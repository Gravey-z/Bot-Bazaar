import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  copyFile,
  lstat,
} from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LivingTownClient,
  createRpcTransport,
  canonicalLivingTownJson,
} from "../packages/chain/dist/index.js";
import {
  townNegotiatingMerchantMethods,
  townOperatorMethods,
  customerRuntimeMethods,
  assertRuntimePermission,
} from "../apps/worker/dist/private/near-signer.js";
import { parseTownRuntimeConfig } from "../apps/worker/dist/private/living-town/runtime-config.js";
const require = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
);
export const near = require("near-api-js");
export const root = fileURLToPath(new URL("../", import.meta.url));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const load = async (path) => JSON.parse(await readFile(path, "utf8"));
export async function save(path, value, exclusive = false) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    ...(exclusive ? { flag: "wx" } : {}),
  });
}
const lanes = ["rex", "luna", "bolt", "operator", "customer"];
export const scopes = Object.fromEntries(
  lanes.map((lane) => [
    lane,
    lane === "customer"
      ? [...customerRuntimeMethods]
      : lane === "operator"
        ? [...townOperatorMethods]
        : [...townNegotiatingMerchantMethods],
  ]),
);
export function demoLimits(value = {}) {
  assert(
    Object.keys(value).every((k) =>
      [
        "duration_ms",
        "max_opportunities",
        "max_provider_calls",
        "max_inference_micro",
      ].includes(k),
    ),
    "Unexpected acceptance limit",
  );
  const limits = {
    duration_ms: 600000,
    max_opportunities: 2,
    max_provider_calls: 12,
    max_inference_micro: 250000,
    ...value,
  };
  assert(
    Number.isInteger(limits.duration_ms) &&
      limits.duration_ms >= 30000 &&
      limits.duration_ms <= 600000,
  );
  assert(
    Number.isInteger(limits.max_opportunities) &&
      limits.max_opportunities >= 1 &&
      limits.max_opportunities <= 2,
  );
  assert(
    Number.isInteger(limits.max_provider_calls) &&
      limits.max_provider_calls >= 1 &&
      limits.max_provider_calls <= 12,
  );
  assert(
    Number.isInteger(limits.max_inference_micro) &&
      limits.max_inference_micro >= 50000 &&
      limits.max_inference_micro <= 250000,
  );
  return limits;
}
export async function sourceIdentity() {
  const paths = [];
  async function walk(name) {
    const stat = await lstat(join(root, name));
    assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) {
      for (const child of await readdir(join(root, name)))
        await walk(name + "/" + child);
    } else if (/\.(ts|rs|json|mjs|toml|lock|html|css)$/.test(name))
      paths.push(name);
  }
  for (const name of [
    "contracts/living-town/src",
    "packages/chain/src",
    "packages/shared/src",
    "apps/worker/src",
    "apps/web/src",
    "characters",
    "scripts",
    "config/living-town-v1.json",
    "Cargo.lock",
    "Cargo.toml",
    "contracts/living-town/Cargo.toml",
    "pnpm-lock.yaml",
    "package.json",
  ])
    await walk(name);
  const files = [];
  for (const path of paths.sort())
    files.push({ path, sha256: sha(await readFile(join(root, path))) });
  return {
    git_head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    content_sha256: sha(canonicalLivingTownJson(files)),
    files,
  };
}
export async function prepareDemo(directory, wasmPath) {
  directory = resolve(directory);
  const privateDir = join(directory, "private"),
    publicDir = join(directory, "public");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await mkdir(publicDir, { recursive: true });
  assert.equal(
    (await readdir(privateDir)).length,
    0,
    "Preparation requires a fresh private directory",
  );
  const owner = `bb-demo-${randomBytes(5).toString("hex")}.testnet`;
  const roles = {};
  for (const role of [
    "owner",
    "contract",
    "operator",
    "rex",
    "luna",
    "bolt",
    "player",
    ...lanes.map((l) => `runtime-${l}`),
  ]) {
    const lane = role.replace("runtime-", "");
    const account =
      role === "owner"
        ? owner
        : `${lane === "customer" ? "operator" : lane}.${owner}`;
    const key = near.KeyPairEd25519.fromRandom();
    const public_key = key.getPublicKey().toString();
    await save(
      join(privateDir, role + ".json"),
      { account_id: account, public_key, private_key: key.toString() },
      true,
    );
    roles[role] = { account_id: account, public_key };
  }
  const wasm = await readFile(wasmPath);
  assert(wasm.length > 100000 && wasm.length < 4 * 1024 * 1024);
  assert.equal(wasm.subarray(0, 4).toString("hex"), "0061736d");
  await copyFile(wasmPath, join(publicDir, "living-town.wasm"));
  const economy = await load(join(root, "config/living-town-v1.json"));
  const plan = {
    purpose: "fresh Testnet demo; never replaces an existing contract",
    created_at: new Date().toISOString(),
    rpc_url: "https://test.rpc.fastnear.com",
    network: "testnet",
    directory,
    public_dir: publicDir,
    private_dir: privateDir,
    roles,
    funding_near: {
      contract: "8",
      operator: "0.3",
      rex: "0.3",
      luna: "0.3",
      bolt: "0.3",
      player: "0.5",
    },
    runtime_key_allowance_yocto: "50000000000000000000000",
    runtime_scopes: scopes,
    wasm: {
      file: join(publicDir, "living-town.wasm"),
      bytes: wasm.length,
      sha256: sha(wasm),
      code_hash: near.baseEncode(createHash("sha256").update(wasm).digest()),
    },
    config_sha256: sha(canonicalLivingTownJson(economy)),
    schemas: { api: "2.0.0", state: "2", command: "1", config: "1" },
    initial_holdings: economy.economy.stockSharing.startingHoldings,
    seed_items: {
      crystal: "23",
      wood: "23",
      herb: "23",
      iron: "23",
      health_potion: "0",
      iron_tool: "0",
    },
    limits: demoLimits(),
    runtime_mode: "paused",
    source: await sourceIdentity(),
  };
  await save(join(publicDir, "deployment-plan.json"), plan, true);
  return plan;
}
export function demoRpc(plan) {
  return async (method, params) => {
    const response = await fetch(plan.rpc_url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "fresh-demo",
        method,
        params,
      }),
    });
    assert(response.ok, `RPC HTTP ${response.status}`);
    const text = await response.text();
    assert(text.length <= 4 * 1024 * 1024, "RPC body bound");
    const body = JSON.parse(text);
    return body;
  };
}
export async function result(rpc, method, params) {
  const body = await rpc(method, params);
  assert(
    body.result && !body.error,
    `RPC ${method}: ${body.error?.cause?.name ?? "no result"}`,
  );
  return body.result;
}
export function transactionSummary(receipt, description) {
  const outcomes = [receipt.transaction_outcome, ...receipt.receipts_outcome];
  return {
    transaction_hash: receipt.transaction.hash,
    signer_id: receipt.transaction.signer_id,
    receiver_id: receipt.transaction.receiver_id,
    description,
    final_execution_status: receipt.final_execution_status ?? null,
    status: receipt.status,
    gas_burnt: outcomes
      .reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n)
      .toString(),
    tokens_burnt_yocto: outcomes
      .reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n)
      .toString(),
    receipt_ids: receipt.receipts_outcome.map((o) => o.id),
    block_hashes: [...new Set(outcomes.map((o) => o.block_hash))],
    url: `https://testnet.nearblocks.io/txns/${receipt.transaction.hash}`,
  };
}
export async function archiveTransaction(
  plan,
  receipt,
  description,
  extra = {},
) {
  const hash = receipt.transaction.hash;
  await save(join(plan.public_dir, "receipts", hash + ".json"), receipt);
  const file = join(plan.public_dir, "transactions.json");
  let records = [];
  try {
    records = await load(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const entry = { ...transactionSummary(receipt, description), ...extra };
  const index = records.findIndex((r) => r.transaction_hash === hash);
  if (index < 0) records.push(entry);
  else records[index] = { ...records[index], ...entry };
  await save(file, records);
  return entry;
}
export async function sendDemoTransaction(
  plan,
  label,
  credential,
  receiver,
  actions,
  description,
  { admit = () => {}, onIntent = async () => {} } = {},
) {
  admit();
  assert(/^[a-z0-9-]{1,90}$/.test(label));
  const rpc = demoRpc(plan);
  const file = join(plan.private_dir, label + "-intent.json");
  let intent;
  try {
    intent = await load(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let receipt;
  if (intent) {
    assert.equal(intent.signer_id, credential.account_id);
    assert.equal(intent.receiver_id, receiver);
    await onIntent({ transaction_hash: intent.hash, signer_id: intent.signer_id,
      receiver_id: receiver, label, status: "unresolved" });
    receipt = await result(rpc, "tx", {
      tx_hash: intent.hash,
      sender_account_id: intent.signer_id,
      wait_until: "FINAL",
    });
  } else {
    const access = await result(rpc, "query", {
      request_type: "view_access_key",
      account_id: credential.account_id,
      public_key: credential.public_key,
      finality: "final",
    });
    assert.equal(access.permission, "FullAccess");
    admit();
    const tx = near.createTransaction(
      credential.account_id,
      near.PublicKey.from(credential.public_key),
      receiver,
      BigInt(access.nonce) + 1n,
      actions,
      near.baseDecode(access.block_hash),
    );
    const signed = await near.KeyPairSigner.fromSecretKey(
      credential.private_key,
    ).signTransaction(tx);
    intent = {
      hash: near.baseEncode(signed.txHash),
      signer_id: credential.account_id,
      receiver_id: receiver,
      signed_base64: Buffer.from(signed.signedTransaction.encode()).toString(
        "base64",
      ),
    };
    await save(file, intent, true);
    await onIntent({ transaction_hash: intent.hash, signer_id: intent.signer_id,
      receiver_id: receiver, label, status: "unresolved" });
    admit();
    const response = await rpc("send_tx", {
      signed_tx_base64: intent.signed_base64,
      wait_until: "FINAL",
    });
    if (!response.result) {
      await save(join(plan.public_dir, label + "-unresolved.json"), {
        transaction_hash: intent.hash,
        signer_id: intent.signer_id,
        description,
        status: "unresolved; query original transaction before any retry",
      });
      throw Error("Original transaction unresolved; signed intent retained");
    }
    receipt = response.result;
  }
  await archiveTransaction(plan, receipt, description, { label });
  await onIntent({ transaction_hash: intent.hash, signer_id: intent.signer_id,
    receiver_id: receiver, label, status: Object.hasOwn(receipt.status, "SuccessValue") ? "confirmed" : "failed" });
  assert(
    Object.hasOwn(receipt.status, "SuccessValue"),
    `Transaction ${label} failed; evidence saved`,
  );
  return receipt;
}
export async function deployDemo(plan) {
  assert.equal(
    (await sourceIdentity()).content_sha256,
    plan.source.content_sha256,
    "Prepared source changed; prepare a new reviewed plan",
  );
  assert.equal(sha(await readFile(plan.wasm.file)), plan.wasm.sha256);
  const rpc = demoRpc(plan);
  assert.equal((await result(rpc, "status", {})).chain_id, "testnet");
  const keys = {};
  for (const role of [
    "owner",
    "contract",
    "operator",
    "rex",
    "luna",
    "bolt",
    "player",
  ])
    keys[role] = await load(join(plan.private_dir, role + ".json"));
  const owner = keys.owner;
  let account = await rpc("query", {
    request_type: "view_account",
    account_id: owner.account_id,
    finality: "final",
  });
  if (!account.result) {
    assert.equal(account.error?.cause?.name, "UNKNOWN_ACCOUNT");
    await save(
      join(plan.private_dir, "faucet-request.json"),
      { account_id: owner.account_id, public_key: owner.public_key },
      true,
    );
    const response = await fetch("https://helper.nearprotocol.com/account", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        newAccountId: owner.account_id,
        newAccountPublicKey: owner.public_key,
      }),
    });
    const responseText = await response.text();
    await save(join(plan.public_dir, "faucet-result.json"), {
      http: response.status,
      account_id: owner.account_id,
      response: responseText.slice(0, 8192),
    });
    assert(
      response.ok,
      "Faucet failed; do not repeat sponsorship automatically",
    );
    for (let n = 0; n < 20; n++) {
      account = await rpc("query", {
        request_type: "view_account",
        account_id: owner.account_id,
        finality: "final",
      });
      if (account.result) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  assert(account.result);
  await save(join(plan.public_dir, "owner-finalized.json"), account.result);
  for (const [role, nearAmount] of Object.entries(plan.funding_near)) {
    const existing = await rpc("query", {
      request_type: "view_account",
      account_id: keys[role].account_id,
      finality: "final",
    });
    let priorIntent = false;
    try {
      await lstat(join(plan.private_dir, `create-${role}-intent.json`));
      priorIntent = true;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!existing.result || priorIntent) {
      if (!existing.result)
        assert.equal(existing.error?.cause?.name, "UNKNOWN_ACCOUNT");
      const [whole, fraction = ""] = nearAmount.split(".");
      const amount =
        BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"));
      await sendDemoTransaction(
        plan,
        `create-${role}`,
        owner,
        keys[role].account_id,
        [
          near.actions.createAccount(),
          near.actions.transfer(amount),
          near.actions.addFullAccessKey(
            near.PublicKey.from(keys[role].public_key),
          ),
        ],
        `Create fresh ${role} account and fund ${nearAmount} Testnet NEAR`,
      );
    }
  }
  const genesisConfig = await result(rpc, "EXPERIMENTAL_genesis_config", []);
  assert.equal(genesisConfig.chain_id, "testnet");
  const genesis = await result(rpc, "block", {
    block_id: genesisConfig.genesis_height,
  });
  const accountState = await result(rpc, "query", {
    request_type: "view_account",
    account_id: keys.contract.account_id,
    finality: "final",
  });
  const deploymentIntent = join(
    plan.private_dir,
    "deploy-initialize-intent.json",
  );
  let hasIntent = false;
  try {
    await lstat(deploymentIntent);
    hasIntent = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  assert(
    hasIntent || accountState.code_hash === "11111111111111111111111111111111",
    "Fresh deployment refuses existing contract code",
  );
  const args = {
    owner_account_id: owner.account_id,
    operator_account_id: keys.operator.account_id,
    merchant_controllers: Object.fromEntries(
      ["rex", "luna", "bolt"].map((l) => [l, keys[l].account_id]),
    ),
    network_genesis_hash: genesis.header.hash,
    config_sha256: plan.config_sha256,
  };
  const deployed = await sendDemoTransaction(
    plan,
    "deploy-initialize",
    keys.contract,
    keys.contract.account_id,
    [
      near.actions.deployContract(await readFile(plan.wasm.file)),
      near.actions.functionCall("initialize_town", args, 200000000000000n, 0n),
    ],
    "Deploy fresh WASM and initialize distributed merchant ownership, specialist listings and game-gold seed",
  );
  const identity = {
    deployment: {
      network_id: "testnet",
      genesis_hash: genesis.header.hash,
      contract_id: keys.contract.account_id,
      api_version: "2.0.0",
      state_schema: "2",
      command_schema: "1",
      config_version: "1",
      config_sha256: plan.config_sha256,
    },
    codeHash: plan.wasm.code_hash,
    ownerId: owner.account_id,
    operatorId: keys.operator.account_id,
    controllers: args.merchant_controllers,
  };
  const client = new LivingTownClient(
    identity,
    createRpcTransport(plan.rpc_url),
  );
  const reader = await client.finalized(),
    town = await reader.getTown(),
    foundation = await reader.getFoundation(),
    rules = await reader.getMerchantTradingRules();
  assert.deepEqual(town.data.totals.seed_items, plan.seed_items);
  assert.equal(town.market_revision, "1");
  const economy = await load(join(root, "config/living-town-v1.json"));
  for (const merchant of ["rex", "luna", "bolt"]) {
    const ledger = town.data.npc_ledgers.find(
      (l) => l.actor.merchant_id === merchant,
    );
    assert.equal(ledger.gold.held, "200");
    for (const [item, material] of Object.entries(economy.economy.materials))
      assert.equal(
        ledger.inventory.listing_reserved[item],
        material.supplier === merchant ? material.listed : "0",
      );
    for (const [item, quantity] of Object.entries(
      plan.initial_holdings[merchant],
    ))
      assert.equal(ledger.inventory.held[item], quantity);
  }
  await save(join(plan.public_dir, "initialization.json"), {
    identity,
    transaction_hash: deployed.transaction.hash,
    block: reader.block,
    foundation,
    town,
    rules,
  });
  for (const lane of lanes) {
    const role = lane === "customer" ? "operator" : lane;
    const key = await load(join(plan.private_dir, `runtime-${lane}.json`));
    await sendDemoTransaction(
      plan,
      `install-${lane}-key`,
      keys[role],
      keys[role].account_id,
      [
        near.actions.addFunctionCallAccessKey(
          near.PublicKey.from(key.public_key),
          keys.contract.account_id,
          plan.runtime_scopes[lane],
          BigInt(plan.runtime_key_allowance_yocto),
        ),
      ],
      `Install ${lane} restricted runtime key: contract-only methods, 0.05 Testnet NEAR gas allowance`,
    );
    const pinned = await client.finalized();
    const access = await pinned.getAccessKey(key.account_id, key.public_key);
    assertRuntimePermission(
      access.permission,
      keys.contract.account_id,
      lane === "customer"
        ? "customer"
        : lane === "operator"
          ? "town_operator"
          : "town_negotiating_merchant",
    );
  }
  const pub = {
    networkId: "testnet",
    contractId: keys.contract.account_id,
    rpcUrl: plan.rpc_url,
    explorerUrl: "https://testnet.nearblocks.io",
    workerUrl: "http://127.0.0.1:3011",
  };
  const oldAi = await load(
    join(root, "data/living-town-runtime.ai.local.json"),
  );
  assert.equal(oldAi.provider.kind, "near-ai");
  const controlFile = join(plan.directory, "control.json");
  await save(controlFile, {
    schema: "living-town-runtime-control-v1",
    mode: "paused",
  });
  const runtime = {
    schema: "bot-bazaar-living-town-runtime-v1",
    identity,
    public: pub,
    execution_dir: join(plan.directory, "execution"),
    witness_dir: join(plan.directory, "witness"),
    receipt_outbox: join(plan.directory, "outbox"),
    agent_activity_inbox: join(plan.directory, "activity.json"),
    control_file: controlFile,
    seed: "42",
    poll_ms: "1000",
    cadence_ms: "30000",
    keys: Object.fromEntries(
      lanes.map((l) => [
        l,
        {
          public_key: plan.roles[`runtime-${l}`].public_key,
          file: join(plan.private_dir, `runtime-${l}.json`),
        },
      ]),
    ),
    provider: oldAi.provider,
  };
  parseTownRuntimeConfig(runtime);
  await save(join(plan.directory, "runtime.json"), runtime, true);
  const web = { schema: "living-town-web-v1", identity, public: pub };
  await save(join(plan.public_dir, "living-town.json"), web);
  const readerConfig = {
    schema: "bot-bazaar-living-town-reader-v1",
    identity,
    public: pub,
    data_dir: join(plan.directory, "projection"),
    receipt_inbox: runtime.receipt_outbox,
    backup_directory: null,
    agent_activity_inbox: runtime.agent_activity_inbox,
    trusted_proxy_ips: [],
    port: "3011",
    poll_ms: "3000",
    allowed_origins: ["http://127.0.0.1:4200", "http://127.0.0.1:4201"],
  };
  await save(join(plan.directory, "reader.json"), readerConfig);
  await save(join(plan.public_dir, "deployment-manifest.json"), {
    ...plan,
    identity,
    initialization_transaction: deployed.transaction.hash,
    supported_methods: foundation.data.supported_methods,
    runtime_mode: "paused",
    shared_budget_reused: true,
    private_runtime_config: join(plan.directory, "runtime.json"),
    private_reader_config: join(plan.directory, "reader.json"),
    initialization_verified: true,
  });
  return {
    identity,
    controlFile,
    runtimeConfig: join(plan.directory, "runtime.json"),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, arg, wasm] = process.argv.slice(2);
  try {
    if (mode === "prepare") {
      assert(arg && wasm);
      const plan = await prepareDemo(arg, resolve(wasm));
      console.log(
        JSON.stringify({
          plan: join(plan.public_dir, "deployment-plan.json"),
          owner: plan.roles.owner.account_id,
          contract: plan.roles.contract.account_id,
          wasm_sha256: plan.wasm.sha256,
          network_transactions: 0,
        }),
      );
    } else if (mode === "deploy") {
      assert(arg && isAbsolute(arg));
      console.log(JSON.stringify(await deployDemo(await load(arg))));
    } else
      throw Error(
        "Use prepare <new-directory> <wasm> or deploy <absolute-plan.json>",
      );
  } catch (e) {
    console.error(
      JSON.stringify({
        stage: mode,
        error:
          e instanceof assert.AssertionError
            ? e.message
            : (e.code ?? "demo_operation_failed"),
        note: "Preserve original intents and public evidence; no automatic replacement transaction.",
      }),
    );
    process.exitCode = 1;
  }
}
