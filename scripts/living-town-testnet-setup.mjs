import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  LivingTownClient,
  createRpcTransport,
  canonicalLivingTownJson,
} from "../packages/chain/dist/index.js";
import {
  assertRuntimePermission,
  townMerchantMethods,
  townOperatorMethods,
  customerRuntimeMethods,
} from "../apps/worker/dist/private/near-signer.js";

const require = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
);
const {
  KeyPairEd25519,
  KeyPairSigner,
  PublicKey,
  createTransaction,
  baseDecode,
  baseEncode,
  actions,
} = require("near-api-js");
const privateDir = new URL("../data/p77-testnet-private/", import.meta.url);
const ownerPath = new URL("owner.json", privateDir);
const rpcUrl = "https://test.rpc.fastnear.com";
let stage = "network_check";
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "living-town-setup",
      method,
      params,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  // This Testnet RPC can return legacy missing-key errors inside `result`.
  // Recognize only the exact queried public key, never arbitrary error text.
  if (
    method === "query" &&
    params.request_type === "view_access_key" &&
    body.result?.error ===
      `access key ${params.public_key} does not exist while viewing`
  ) {
    return { error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } };
  }
  return body;
}
async function finalizedAccount(account) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const state = await rpc("query", {
      request_type: "view_account",
      account_id: account,
      finality: "final",
    });
    if (state.result || state.error?.cause?.name !== "UNKNOWN_ACCOUNT")
      return state;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error("account finality pending");
}

// Owner-only setup credential. Never used by a reader/runtime worker.
async function faucet() {
  const stat = await lstat(privateDir);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal((await rpc("status", [])).result?.chain_id, "testnet");
  stage = "local_key_preparation";
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const key = KeyPairEd25519.fromRandom();
    owner = {
      account_id: `bb-v2-${randomBytes(5).toString("hex")}.testnet`,
      public_key: key.getPublicKey().toString(),
      private_key: key.toString(),
    };
    await writeFile(ownerPath, JSON.stringify(owner), {
      flag: "wx",
      mode: 0o600,
    });
  }
  assert.match(owner.account_id, /^bb-v2-[a-f0-9]{10}\.testnet$/);
  stage = "account_lookup";
  let state = await rpc("query", {
    request_type: "view_account",
    account_id: owner.account_id,
    finality: "final",
  });
  if (!state.result) {
    // Only an explicit missing account permits a new faucet request.
    const cause = state.error?.cause?.name;
    if (cause !== "UNKNOWN_ACCOUNT") {
      console.log(
        JSON.stringify({
          phase: stage,
          error_code: state.error?.code,
          cause: /^[A-Z_]{1,50}$/.test(cause ?? "") ? cause : "unclassified",
        }),
      );
      throw Error("account lookup did not establish absence");
    }
    stage = "faucet_request";
    // A timeout/ambiguous helper response must never cause another sponsorship
    // request automatically. Preserve the account/key and reconcile manually.
    await writeFile(
      new URL("faucet-request.json", privateDir),
      JSON.stringify({
        account_id: owner.account_id,
        public_key: owner.public_key,
      }),
      { flag: "wx", mode: 0o600 },
    );
    const response = await fetch("https://helper.nearprotocol.com/account", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        newAccountId: owner.account_id,
        newAccountPublicKey: owner.public_key,
      }),
    });
    console.log(
      JSON.stringify({
        phase: "faucet",
        account_id: owner.account_id,
        http: response.status,
      }),
    );
    if (!response.ok) {
      process.exitCode = 1;
      return;
    }
    await response.arrayBuffer();
    // Never infer success from the helper response alone.
    state = await finalizedAccount(owner.account_id);
  }
  assert.ok(state.result);
  stage = "access_key_verification";
  const access = await rpc("query", {
    request_type: "view_access_key",
    account_id: owner.account_id,
    public_key: owner.public_key,
    finality: "final",
  });
  assert.equal(access.result?.permission, "FullAccess");
  const publicRecord = {
    network: "testnet",
    owner: owner.account_id,
    public_key: owner.public_key,
    amount_yocto: state.result.amount,
    block_hash: state.result.block_hash,
    block_height: state.result.block_height,
    credential_directory:
      "data/p77-testnet-private (owner setup only; never publish)",
  };
  await writeFile(
    new URL(
      "../data/p77-deployment-artifacts/accounts-public.json",
      import.meta.url,
    ),
    JSON.stringify(publicRecord, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(publicRecord));
}

async function children() {
  assert.equal((await rpc("status", [])).result?.chain_id, "testnet");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  const ownerState = await rpc("query", {
    request_type: "view_account",
    account_id: owner.account_id,
    finality: "final",
  });
  assert.ok(ownerState.result);
  const records = { network: "testnet", owner: owner.account_id, roles: {} };
  for (const [role, amount] of Object.entries({
    contract: "7000000000000000000000000",
    operator: "300000000000000000000000",
    rex: "300000000000000000000000",
    luna: "300000000000000000000000",
    bolt: "300000000000000000000000",
    player: "500000000000000000000000",
  })) {
    stage = `child_${role}`;
    const path = new URL(`${role}.json`, privateDir);
    let credential;
    try {
      credential = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const key = KeyPairEd25519.fromRandom();
      credential = {
        account_id: `${role}.${owner.account_id}`,
        public_key: key.getPublicKey().toString(),
        private_key: key.toString(),
      };
      await writeFile(path, JSON.stringify(credential), {
        flag: "wx",
        mode: 0o600,
      });
    }
    assert.equal(credential.account_id, `${role}.${owner.account_id}`);
    let state = await rpc("query", {
      request_type: "view_account",
      account_id: credential.account_id,
      finality: "final",
    });
    const intentPath = new URL(`create-${role}-intent.json`, privateDir);
    let intent;
    try {
      intent = JSON.parse(await readFile(intentPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!state.result) {
      assert.equal(state.error?.cause?.name, "UNKNOWN_ACCOUNT");
      if (intent) {
        stage = `reconcile_${role}`;
        const outcome = await rpc("tx", {
          tx_hash: intent.transaction_hash,
          sender_account_id: owner.account_id,
          wait_until: "FINAL",
        });
        console.log(
          JSON.stringify({
            phase: stage,
            transaction_hash: intent.transaction_hash,
            result_status: outcome.result?.status
              ? Object.keys(outcome.result.status)
              : null,
            error_code: outcome.error?.code,
            cause: outcome.error?.cause?.name,
          }),
        );
        assert.ok(
          outcome.result?.status &&
            Object.hasOwn(outcome.result.status, "SuccessValue"),
          "original setup outcome unresolved; do not replace",
        );
      } else {
        const access = await rpc("query", {
          request_type: "view_access_key",
          account_id: owner.account_id,
          public_key: owner.public_key,
          finality: "final",
        });
        assert.equal(access.result?.permission, "FullAccess");
        const tx = createTransaction(
          owner.account_id,
          PublicKey.from(owner.public_key),
          credential.account_id,
          BigInt(access.result.nonce) + 1n,
          [
            actions.createAccount(),
            actions.transfer(BigInt(amount)),
            actions.addFullAccessKey(PublicKey.from(credential.public_key)),
          ],
          baseDecode(access.result.block_hash),
        );
        const signed = await KeyPairSigner.fromSecretKey(
          owner.private_key,
        ).signTransaction(tx);
        intent = {
          transaction_hash: baseEncode(signed.txHash),
          signed_base64: Buffer.from(
            signed.signedTransaction.encode(),
          ).toString("base64"),
        };
        await writeFile(intentPath, JSON.stringify(intent), {
          flag: "wx",
          mode: 0o600,
        });
        stage = `broadcast_${role}`;
        const sent = await rpc("broadcast_tx_commit", [intent.signed_base64]);
        console.log(
          JSON.stringify({
            phase: stage,
            transaction_hash: intent.transaction_hash,
            result_status: sent.result?.status
              ? Object.keys(sent.result.status)
              : null,
            error_code: sent.error?.code,
            cause: sent.error?.cause?.name,
          }),
        );
        assert.ok(
          sent.result?.status &&
            Object.hasOwn(sent.result.status, "SuccessValue"),
          "setup outcome unresolved; preserve original intent",
        );
      }
      stage = `finality_${role}`;
      state = await finalizedAccount(credential.account_id);
    }
    assert.ok(state.result);
    const access = await rpc("query", {
      request_type: "view_access_key",
      account_id: credential.account_id,
      public_key: credential.public_key,
      finality: "final",
    });
    assert.equal(access.result?.permission, "FullAccess");
    records.roles[role] = {
      account_id: credential.account_id,
      public_key: credential.public_key,
      amount_yocto: state.result.amount,
      block_hash: state.result.block_hash,
      block_height: state.result.block_height,
      creation_transaction: intent?.transaction_hash ?? null,
    };
    await writeFile(
      new URL(
        "../data/p77-deployment-artifacts/accounts-public.json",
        import.meta.url,
      ),
      JSON.stringify(records, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ role, ...records.roles[role] }));
  }
}

async function deploy() {
  stage = "deploy_preflight";
  assert.equal((await rpc("status", [])).result?.chain_id, "testnet");
  const credential = JSON.parse(
    await readFile(new URL("contract.json", privateDir), "utf8"),
  );
  const accounts = JSON.parse(
    await readFile(
      new URL(
        "../data/p77-deployment-artifacts/accounts-public.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(credential.account_id, accounts.roles.contract.account_id);
  const wasm = await readFile(
    new URL(
      "../data/p77-deployment-artifacts/bot_bazaar_living_town.wasm",
      import.meta.url,
    ),
  );
  assert.equal(
    createHash("sha256").update(wasm).digest("hex"),
    "3d8bf4fb6db379ca93ad77c413177be4ff929ae75607707e9c0f3129a5b7b4fd",
  );
  const codeHash = baseEncode(createHash("sha256").update(wasm).digest());
  const cfg = JSON.parse(
    await readFile(
      new URL("../config/living-town-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const configHash = createHash("sha256")
    .update(canonicalLivingTownJson(cfg))
    .digest("hex");
  const genesisConfig = await rpc("EXPERIMENTAL_genesis_config", []);
  assert.equal(genesisConfig.result?.chain_id, "testnet");
  const genesis = await rpc("block", {
    block_id: genesisConfig.result.genesis_height,
  });
  assert.ok(genesis.result?.header?.hash);
  const args = {
    owner_account_id: accounts.owner,
    operator_account_id: accounts.roles.operator.account_id,
    merchant_controllers: Object.fromEntries(
      ["rex", "luna", "bolt"].map((id) => [id, accounts.roles[id].account_id]),
    ),
    network_genesis_hash: genesis.result.header.hash,
    config_sha256: configHash,
  };
  const path = new URL("deploy-initialize-intent.json", privateDir);
  let intent;
  try {
    intent = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const current = await finalizedAccount(credential.account_id);
  assert.ok(current.result);
  if (!intent) {
    assert.equal(
      current.result.code_hash,
      "11111111111111111111111111111111",
      "refuse replacing existing contract",
    );
    assert.ok(BigInt(current.result.amount) >= 7n * 10n ** 24n);
    const access = await rpc("query", {
      request_type: "view_access_key",
      account_id: credential.account_id,
      public_key: credential.public_key,
      finality: "final",
    });
    assert.equal(access.result?.permission, "FullAccess");
    const tx = createTransaction(
      credential.account_id,
      PublicKey.from(credential.public_key),
      credential.account_id,
      BigInt(access.result.nonce) + 1n,
      [
        actions.deployContract(wasm),
        actions.functionCall("initialize_town", args, 200_000_000_000_000n, 0n),
      ],
      baseDecode(access.result.block_hash),
    );
    const signed = await KeyPairSigner.fromSecretKey(
      credential.private_key,
    ).signTransaction(tx);
    intent = {
      transaction_hash: baseEncode(signed.txHash),
      signed_base64: Buffer.from(signed.signedTransaction.encode()).toString(
        "base64",
      ),
      args,
      wasm_sha256: createHash("sha256").update(wasm).digest("hex"),
    };
    await writeFile(path, JSON.stringify(intent), { flag: "wx", mode: 0o600 });
    stage = "deploy_broadcast";
    const sent = await rpc("broadcast_tx_commit", [intent.signed_base64]);
    console.log(
      JSON.stringify({
        phase: stage,
        transaction_hash: intent.transaction_hash,
        status: sent.result?.status ? Object.keys(sent.result.status) : null,
        error_code: sent.error?.code,
      }),
    );
    assert.ok(
      sent.result?.status && Object.hasOwn(sent.result.status, "SuccessValue"),
    );
  } else {
    stage = "deploy_reconcile";
    const previous = await rpc("tx", {
      tx_hash: intent.transaction_hash,
      sender_account_id: credential.account_id,
      wait_until: "FINAL",
    });
    assert.ok(
      previous.result?.status &&
        Object.hasOwn(previous.result.status, "SuccessValue"),
    );
    assert.deepEqual(intent.args, args);
  }
  stage = "deployed_identity_verification";
  for (let attempt = 0; attempt < 15; attempt++) {
    const state = await finalizedAccount(credential.account_id);
    if (state.result.code_hash === codeHash) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const identity = {
    deployment: {
      network_id: "testnet",
      genesis_hash: args.network_genesis_hash,
      contract_id: credential.account_id,
      api_version: "2.0.0",
      state_schema: "1",
      command_schema: "1",
      config_version: "1",
      config_sha256: configHash,
    },
    codeHash,
    ownerId: accounts.owner,
    operatorId: args.operator_account_id,
    controllers: args.merchant_controllers,
  };
  const client = new LivingTownClient(identity, createRpcTransport(rpcUrl));
  const reader = await client.finalized();
  const town = await reader.getTown();
  const pub = {
    networkId: "testnet",
    contractId: credential.account_id,
    rpcUrl,
    explorerUrl: "https://testnet.nearblocks.io",
    workerUrl: "http://127.0.0.1:3011",
  };
  const settings = {
    schema: "bot-bazaar-living-town-reader-v1",
    identity,
    public: pub,
    data_dir: fileURLToPath(
      new URL("../data/p77-local-projection/", import.meta.url),
    ),
    receipt_inbox: null,
    backup_directory: null,
    agent_activity_inbox: null,
    trusted_proxy_ips: [],
    port: "3011",
    poll_ms: "3000",
    allowed_origins: ["http://127.0.0.1:4201"],
  };
  const output = new URL("../data/p77-deployment-artifacts/", import.meta.url);
  for (const [name, value] of Object.entries({
    "reader.json": settings,
    "living-town.json": { schema: "living-town-web-v1", identity, public: pub },
    "deployment-public.json": {
      network: "testnet",
      identity,
      initialization_transaction: intent.transaction_hash,
      finalized_block: reader.block,
      town,
    },
  })) {
    await writeFile(
      new URL(name, output),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  console.log(
    JSON.stringify({
      phase: "deployed_verified",
      contract: credential.account_id,
      transaction_hash: intent.transaction_hash,
      code_hash: codeHash,
      block: reader.block,
    }),
  );
}

async function runtimeKeys() {
  assert.equal((await rpc("status", [])).result?.chain_id, "testnet");
  const accounts = JSON.parse(
    await readFile(
      new URL(
        "../data/p77-deployment-artifacts/accounts-public.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const summary = [];
  for (const [lane, role, scope, methods] of [
    ["rex", "rex", "town_merchant", townMerchantMethods],
    ["luna", "luna", "town_merchant", townMerchantMethods],
    ["bolt", "bolt", "town_merchant", townMerchantMethods],
    ["operator", "operator", "town_operator", townOperatorMethods],
    ["customer", "operator", "customer", customerRuntimeMethods],
  ]) {
    stage = `runtime_key_${lane}`;
    const setup = JSON.parse(
      await readFile(new URL(`${role}.json`, privateDir), "utf8"),
    );
    const keyPath = new URL(`runtime-${lane}.json`, privateDir);
    let credential;
    try {
      credential = JSON.parse(await readFile(keyPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const key = KeyPairEd25519.fromRandom();
      credential = {
        account_id: setup.account_id,
        public_key: key.getPublicKey().toString(),
        private_key: key.toString(),
      };
      await writeFile(keyPath, JSON.stringify(credential), {
        flag: "wx",
        mode: 0o600,
      });
    }
    assert.equal(credential.account_id, accounts.roles[role].account_id);
    let key = await rpc("query", {
      request_type: "view_access_key",
      account_id: setup.account_id,
      public_key: credential.public_key,
      finality: "final",
    });
    const intentPath = new URL(`runtime-${lane}-intent.json`, privateDir);
    let intent;
    try {
      intent = JSON.parse(await readFile(intentPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!key.result) {
      assert.equal(key.error?.cause?.name, "UNKNOWN_ACCESS_KEY");
      if (intent) {
        const outcome = await rpc("tx", {
          tx_hash: intent.transaction_hash,
          sender_account_id: setup.account_id,
          wait_until: "FINAL",
        });
        assert.ok(
          outcome.result?.status &&
            Object.hasOwn(outcome.result.status, "SuccessValue"),
        );
      } else {
        const access = await rpc("query", {
          request_type: "view_access_key",
          account_id: setup.account_id,
          public_key: setup.public_key,
          finality: "final",
        });
        assert.equal(access.result?.permission, "FullAccess");
        const tx = createTransaction(
          setup.account_id,
          PublicKey.from(setup.public_key),
          setup.account_id,
          BigInt(access.result.nonce) + 1n,
          [
            actions.addFunctionCallAccessKey(
              PublicKey.from(credential.public_key),
              accounts.roles.contract.account_id,
              [...methods],
              50_000_000_000_000_000_000_000n,
            ),
          ],
          baseDecode(access.result.block_hash),
        );
        const signed = await KeyPairSigner.fromSecretKey(
          setup.private_key,
        ).signTransaction(tx);
        intent = {
          transaction_hash: baseEncode(signed.txHash),
          signed_base64: Buffer.from(
            signed.signedTransaction.encode(),
          ).toString("base64"),
        };
        await writeFile(intentPath, JSON.stringify(intent), {
          flag: "wx",
          mode: 0o600,
        });
        const sent = await rpc("broadcast_tx_commit", [intent.signed_base64]);
        assert.ok(
          sent.result?.status &&
            Object.hasOwn(sent.result.status, "SuccessValue"),
        );
      }
      for (let attempt = 0; attempt < 15; attempt++) {
        key = await rpc("query", {
          request_type: "view_access_key",
          account_id: setup.account_id,
          public_key: credential.public_key,
          finality: "final",
        });
        if (key.result) break;
        assert.equal(key.error?.cause?.name, "UNKNOWN_ACCESS_KEY");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    assert.ok(key.result);
    assertRuntimePermission(
      key.result.permission,
      accounts.roles.contract.account_id,
      scope,
    );
    assert.equal(
      key.result.permission.FunctionCall.allowance,
      "50000000000000000000000",
    );
    summary.push({
      lane,
      account_id: setup.account_id,
      public_key: credential.public_key,
      permission: key.result.permission,
      block_hash: key.result.block_hash,
      block_height: key.result.block_height,
      transaction_hash: intent?.transaction_hash ?? null,
    });
    await writeFile(
      new URL(
        "../data/p77-deployment-artifacts/runtime-keys-public.json",
        import.meta.url,
      ),
      JSON.stringify(summary, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        lane,
        account_id: setup.account_id,
        status: "restricted_permission_verified",
      }),
    );
  }
}

try {
  assert.ok(
    process.argv.length === 3 &&
      ["faucet", "children", "deploy", "runtime-keys"].includes(
        process.argv[2],
      ),
  );
  if (process.argv[2] === "faucet") await faucet();
  else if (process.argv[2] === "children") await children();
  else if (process.argv[2] === "deploy") await deploy();
  else await runtimeKeys();
} catch (error) {
  const code = error?.code;
  if (typeof code === "string" && /^[A-Z_]{1,32}$/.test(code))
    console.error(`Setup error code: ${code}`);
  const location = error?.stack
    ?.split("\n")
    .find(
      (line) =>
        /^\s+at /.test(line) && line.includes("living-town-testnet-setup.mjs:"),
    );
  if (location) console.error(`Setup location: ${location.trim()}`);
  console.error(
    `Testnet account setup did not finish at ${stage}. Preserve local credentials and reconcile the public account before retrying; no secrets logged.`,
  );
  process.exitCode = 1;
}
