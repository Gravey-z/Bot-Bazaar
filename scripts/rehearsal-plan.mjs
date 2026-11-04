import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MarketClient,
  createRpcTransport,
} from "../packages/chain/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const account = (value) =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(
    value,
  );
const sha = (value) => createHash("sha256").update(value).digest();
const workerRequire = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
);
const { baseEncode } = workerRequire("near-api-js");
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const names = ["rex", "luna", "bolt"];
export const runtimeMethods = [
  "set_listing",
  "propose_trade",
  "accept_trade",
  "cancel_trade",
  "expire_offers",
];

export function makeRehearsalPlan(input, createdAt = new Date().toISOString()) {
  assert.ok(
    exact(input, ["runId", "funder", "codeHash", "port", "activeDeployments"]),
    "Only public rehearsal configuration is accepted",
  );
  assert.match(input.runId, /^r[0-9]{8}-[a-f0-9]{8}$/);
  assert.ok(
    account(input.funder),
    "A named Testnet funding account is required",
  );
  assert.match(input.codeHash, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.ok(
    Number.isSafeInteger(input.port) &&
      input.port >= 1024 &&
      input.port <= 65535 &&
      input.port !== 3001,
    "Use a distinct rehearsal port",
  );
  assert.ok(
    Array.isArray(input.activeDeployments) &&
      input.activeDeployments.length > 0 &&
      input.activeDeployments.length <= 16,
    "Declare active deployments",
  );
  const protectedAccounts = new Set();
  for (const deployment of input.activeDeployments) {
    assert.ok(exact(deployment, ["contractId", "controllers", "workerUrl"]));
    assert.ok(exact(deployment.controllers, names));
    assert.equal(new Set(Object.values(deployment.controllers)).size, 3);
    assert.ok(
      !Object.values(deployment.controllers).includes(deployment.contractId),
    );
    for (const id of [
      deployment.contractId,
      ...Object.values(deployment.controllers),
    ]) {
      assert.ok(account(id));
      protectedAccounts.add(id);
    }
    const url = new URL(deployment.workerUrl);
    assert.ok(
      ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
    );
    assert.ok(
      url.protocol === "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    );
    assert.ok(
      url.port !== String(input.port),
      "Rehearsal port overlaps a declared worker",
    );
  }
  const contractId = `${input.runId}.${input.funder}`;
  const controllers = Object.fromEntries(
    names.map((name) => [name, `${input.runId}-${name}.${input.funder}`]),
  );
  const player = `${input.runId}-player.${input.funder}`;
  for (const id of [contractId, player, ...Object.values(controllers)])
    assert.ok(
      account(id) && !protectedAccounts.has(id),
      "Fresh accounts must be distinct from every declared active deployment",
    );
  return {
    schema: "bot-bazaar-rehearsal-v1",
    runId: input.runId,
    createdAt,
    mode: "live_rehearsal_preparation",
    label: "Fresh rehearsal plan · execution is tracked separately",
    status: "prepared",
    liveAiEvidence: false,
    fundingAccount: input.funder,
    identity: {
      networkId: "testnet",
      contractId,
      ownerId: contractId,
      codeHash: input.codeHash,
      controllers,
    },
    player,
    rpcUrl: "https://test.rpc.fastnear.com/",
    workerUrl: `http://127.0.0.1:${input.port}/`,
    policyVersion: "v1",
    protectedDeployments: structuredClone(input.activeDeployments),
    provider: {
      mode: "disabled",
      requestsAuthorized: false,
      continuity: "unverified",
      note: "No budget is initialized or reset. Adopt the fenced lane's durable usage before any later paid admission.",
    },
  };
}

export function rehearsalCompose(plan, directory) {
  const environment = {
    NEAR_NETWORK_ID: "testnet",
    NEAR_CONTRACT_ID: plan.identity.contractId,
    NEAR_OWNER_ID: plan.identity.ownerId,
    NEAR_EXPECTED_CODE_HASH: plan.identity.codeHash,
    NEAR_RPC_URL: plan.rpcUrl,
    NEAR_EXPLORER_URL: "https://testnet.nearblocks.io",
    REX_CONTROLLER_ID: plan.identity.controllers.rex,
    LUNA_CONTROLLER_ID: plan.identity.controllers.luna,
    BOLT_CONTROLLER_ID: plan.identity.controllers.bolt,
    WORKER_URL: plan.workerUrl,
    HOST: "0.0.0.0",
    PORT: "3001",
    WORKER_DATA_DIR: "/var/data",
    WORKER_BACKUP_DIR: "/var/data/backups",
    WORKER_POLICY_VERSION: "v1",
    WORKER_INITIALIZE_DATABASE: "false",
    WORKER_DISCOVERY_ENABLED: "true",
    MODEL_PROVIDER: "disabled",
    WORKER_ALLOWED_ORIGINS: "",
    WORKER_TRUSTED_PROXY_IPS: "",
    WORKER_READS_PER_MINUTE: "60",
    WORKER_READS_PER_SECOND: "10",
  };
  return {
    name: `bazaar-${plan.runId}`,
    services: {
      worker: {
        image: "bot-bazaar-worker:local",
        init: true,
        restart: "no",
        stop_grace_period: "30s",
        user: "1000:1000",
        environment,
        ports: [`127.0.0.1:${new URL(plan.workerUrl).port}:3001`],
        volumes: [
          {
            type: "bind",
            source: join(directory, "data"),
            target: "/var/data",
            bind: { create_host_path: false },
          },
        ],
        read_only: true,
        tmpfs: ["/tmp:size=64m,mode=1777"],
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        pids_limit: 128,
        mem_limit: "1g",
        cpus: 1,
      },
    },
  };
}

export function rehearsalCommands(plan, directory) {
  const create = (id, balance) => [
    "account",
    "create-account",
    "fund-myself",
    id,
    balance,
    "autogenerate-new-keypair",
    "--signature-scheme",
    "ed25519",
    "save-to-keychain",
    "sign-as",
    plan.fundingAccount,
    "network-config",
    "testnet",
    "sign-with-keychain",
    "send",
  ];
  return {
    label: "Review-only CLI arguments; preparation never executes these",
    fundingNear: "5.7",
    gasAdditional: true,
    steps: [
      {
        id: "create-contract",
        account: plan.identity.contractId,
        args: create(plan.identity.contractId, "4 NEAR"),
      },
      ...names.map((name) => ({
        id: `create-${name}`,
        account: plan.identity.controllers[name],
        args: create(plan.identity.controllers[name], "0.4 NEAR"),
      })),
      {
        id: "create-player",
        account: plan.player,
        args: create(plan.player, "0.5 NEAR"),
      },
      {
        id: "deploy-initialize",
        account: plan.identity.contractId,
        args: [
          "contract",
          "deploy",
          plan.identity.contractId,
          "use-file",
          join(directory, "contract.wasm"),
          "with-init-call",
          "initialize_market",
          "file-args",
          join(directory, "initialize.json"),
          "prepaid-gas",
          "100 Tgas",
          "attached-deposit",
          "0 NEAR",
          "network-config",
          "testnet",
          "sign-with-keychain",
          "send",
        ],
      },
      {
        id: "register-player",
        account: plan.player,
        args: [
          "contract",
          "call-function",
          "as-transaction",
          plan.identity.contractId,
          "register_player",
          "json-args",
          "{}",
          "prepaid-gas",
          "30 Tgas",
          "attached-deposit",
          "0 NEAR",
          "sign-as",
          plan.player,
          "network-config",
          "testnet",
          "sign-with-keychain",
          "send",
        ],
      },
      ...names.map((name) => ({
        id: `restrict-${name}`,
        account: plan.identity.controllers[name],
        args: [
          "account",
          "add-key",
          plan.identity.controllers[name],
          "grant-function-call-access",
          "--allowance",
          "0.1 NEAR",
          "--contract-account-id",
          plan.identity.contractId,
          "--function-names",
          runtimeMethods.join(","),
          "autogenerate-new-keypair",
          "--signature-scheme",
          "ed25519",
          "save-to-keychain",
          "network-config",
          "testnet",
          "sign-with-keychain",
          "send",
        ],
      })),
    ],
    warning:
      "Verify account absence and funding first. Execute one step at a time, retain receipts, and reconcile every uncertain outcome before another attempt. Verify untouched seed before registration.",
  };
}

export function validateRehearsalManifest(plan) {
  assert.equal(plan.schema, "bot-bazaar-rehearsal-v1");
  const expected = makeRehearsalPlan(
    {
      runId: plan.runId,
      funder: plan.fundingAccount,
      codeHash: plan.identity.codeHash,
      port: Number(new URL(plan.workerUrl).port),
      activeDeployments: plan.protectedDeployments,
    },
    plan.createdAt,
  );
  assert.deepEqual(plan.identity, expected.identity);
  for (const key of [
    "player",
    "rpcUrl",
    "workerUrl",
    "policyVersion",
    "provider",
    "mode",
    "liveAiEvidence",
  ])
    assert.deepEqual(
      plan[key],
      expected[key],
      `Rehearsal manifest changed: ${key}`,
    );
}

export function assertFreshSeed(market, fixture, identity) {
  assert.equal(market.market_revision, "1");
  for (const key of [
    "total_issued_gold",
    "registered_player_count",
    "next_offer_id",
    "next_trade_id",
    "paused",
    "resource_supply",
    "limits",
  ])
    assert.deepEqual(
      market.data[key],
      fixture.data[key],
      `Fresh seed mismatch: ${key}`,
    );
  assert.equal(market.data.contract_account_id, identity.contractId);
  assert.equal(market.data.owner_account_id, identity.ownerId);
  for (const [index, merchant] of market.data.merchants.entries()) {
    assert.equal(
      merchant.controller_account_id,
      identity.controllers[names[index]],
    );
    for (const key of [
      "merchant_id",
      "gold",
      "inventory",
      "last_action_id",
      "listings",
    ])
      assert.deepEqual(
        merchant[key],
        fixture.data.merchants[index][key],
        `Fresh merchant mismatch: ${key}`,
      );
  }
  assert.equal(market.data.merchants.length, 3);
}

export async function verifyRehearsalSeed(
  plan,
  transport = createRpcTransport(plan.rpcUrl),
  { registered = false, now = Date.now } = {},
) {
  validateRehearsalManifest(plan);
  const { reader, market } = await new MarketClient(
    plan.identity.contractId,
    transport,
  ).verifyDeployment(plan.identity);
  const blockTime = Number(BigInt(reader.block.timestampNs) / 1000000n);
  assert.ok(
    now() - blockTime <= 15000 && blockTime - now() <= 5000,
    "Finalized rehearsal read is stale",
  );
  const fixture = JSON.parse(
    await readFile(join(root, "tests/fixtures/chain/market.json"), "utf8"),
  );
  if (registered) {
    assert.equal(market.market_revision, "2");
    assert.equal(market.data.registered_player_count, "1");
    assert.equal(market.data.total_issued_gold, "650");
    const seedComparable = structuredClone(market);
    seedComparable.market_revision = "1";
    seedComparable.data.registered_player_count = "0";
    seedComparable.data.total_issued_gold = "550";
    assertFreshSeed(seedComparable, fixture.seed.market, plan.identity);
  } else assertFreshSeed(market, fixture.seed.market, plan.identity);
  const args = {
    after_id: null,
    limit: "50",
    expected_revision: market.market_revision,
  };
  const [player, trades, ...offers] = await Promise.all([
    reader.getPlayer(plan.player),
    reader.getRecentTrades(args),
    ...names.map((name) => reader.getOffersForMerchant(name, "all", args)),
  ]);
  if (registered) {
    assert.ok(player.data);
    assert.equal(player.data.account_id, plan.player);
    assert.equal(player.data.gold, "100");
    assert.deepEqual(player.data.inventory, {
      crystal: "0",
      wood: "0",
      herb: "0",
      iron: "0",
    });
  } else
    assert.equal(
      player.data,
      null,
      "Demo player already registered; preserve the changed rehearsal",
    );
  for (const page of [trades, ...offers]) {
    assert.deepEqual(page.data.items, []);
    assert.equal(page.data.has_more, false);
    assert.equal(page.data.history_gap, false);
    assert.equal(page.data.pruned_through, "0");
  }
  const runtimeKeys = {};
  if (registered)
    for (const name of names) {
      const keys = await reader.query(
        "view_access_key_list",
        plan.identity.controllers[name],
      );
      const matches = keys.keys.filter((key) => {
        const permission = key.access_key.permission.FunctionCall;
        return (
          typeof key.public_key === "string" &&
          /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key.public_key) &&
          permission?.receiver_id === plan.identity.contractId &&
          permission.allowance !== null &&
          BigInt(permission.allowance) > 0n &&
          BigInt(permission.allowance) <= 100000000000000000000000n &&
          JSON.stringify([...permission.method_names].sort()) ===
            JSON.stringify([...runtimeMethods].sort())
        );
      });
      assert.equal(
        matches.length,
        1,
        "Exactly one restricted rehearsal runtime key is required",
      );
      runtimeKeys[name] = {
        publicKey: matches[0].public_key,
        permission: matches[0].access_key.permission.FunctionCall,
      };
    }
  return {
    schema: plan.schema,
    runId: plan.runId,
    status: registered ? "prepared_read_only" : "seed_verified",
    network: "testnet",
    contractId: plan.identity.contractId,
    checkedAt: new Date().toISOString(),
    block: reader.block,
    market,
    playerRegistered: registered,
    runtimeKeys,
    liveAiEvidence: false,
    providerRequests: 0,
    chainMutations: 0,
    remaining: [
      ...(registered
        ? []
        : ["player_registration_receipt", "restricted_controller_permissions"]),
      "provider_usage_continuity",
      "worker_recovery_and_backup",
      "genuine_live_run",
    ],
  };
}

export async function prepareRehearsal(
  input,
  wasmFile,
  { baseDirectory = join(root, "target/rehearsals"), createdAt } = {},
) {
  const plan = makeRehearsalPlan(input, createdAt);
  const wasm = await readFile(wasmFile);
  assert.ok(
    wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])),
    "Reviewed WASM required",
  );
  assert.equal(
    baseEncode(sha(wasm)),
    plan.identity.codeHash,
    "Reviewed WASM code hash mismatch",
  );
  const directory = resolve(baseDirectory, plan.runId);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory); // Never overwrite or resume an existing rehearsal implicitly.
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const manifest = {
    ...plan,
    applicationCommit: commit,
    sourceDirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim().length > 0,
    artifact: { sha256: sha(wasm).toString("hex"), file: "contract.wasm" },
  };
  const save = (name, value) =>
    writeFile(join(directory, name), value, { flag: "wx" });
  await save("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  await save("contract.wasm", wasm);
  await save(
    "commands.json",
    JSON.stringify(rehearsalCommands(plan, directory), null, 2) + "\n",
  );
  await mkdir(join(directory, "data"));
  await save(
    "compose.yaml",
    JSON.stringify(rehearsalCompose(plan, directory), null, 2) + "\n",
  );
  await save(
    "compose.initialize.yaml",
    JSON.stringify(
      {
        services: {
          worker: { environment: { WORKER_INITIALIZE_DATABASE: "true" } },
        },
      },
      null,
      2,
    ) + "\n",
  );
  await save(
    "initialize.json",
    JSON.stringify({
      owner_account_id: plan.identity.ownerId,
      merchant_controllers: plan.identity.controllers,
    }) + "\n",
  );
  await save(
    "checklist.md",
    `# ${plan.runId} · fresh rehearsal\n\nPrepared only. No account or ledger has been changed.\n\n${[
      "Verify every new account is absent on finalized Testnet before provisioning; record all create/deploy/init receipts.",
      "Create fresh contract/controllers/player with operator-held keys; never mount owner/full-access keys into the worker.",
      "Deploy contract.wasm and self-call initialize_market with initialize.json, once only; reconcile unknown results before continuing.",
      "Run seed verification; register the separate player once and verify its receipt and 100 gold / zero resources.",
      "Verify restricted runtime controller permissions and gas before any signing is enabled.",
      "Use only this isolated Compose project/data directory; leave all public configs, jobs and databases intact.",
      "If replacing a rehearsal, drain/reconcile and fence its signing/provider access; preserve unresolved journals and backups.",
      "Adopt the fenced provider lane's durable usage/reservations separately. Missing history stays blocked; do not reset spend windows.",
      "Initialize this fresh database explicitly, then use normal Compose with initialization false; verify health/recovery and a backup.",
      "Verify the live provider/tokenizer/pricing/accounting and obtain separately authorized spend before any inference.",
      "Capture fresh before-state; run and record genuine outcomes without forced retries.",
      "Export reviewed evidence, drain/fence the rehearsal and preserve unresolved recovery material before retirement.",
    ]
      .map((item) => `- [ ] ${item}`)
      .join("\n")}\n`,
  );
  return { directory, manifest };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const [mode, input, artifact] = process.argv.slice(2);
    if (mode === "prepare" && input && artifact && process.argv.length === 5) {
      const result = await prepareRehearsal(
        JSON.parse(await readFile(input, "utf8")),
        artifact,
      );
      console.info(`Prepared only: ${result.directory}`);
    } else if (
      ["verify-seed", "verify-prepared"].includes(mode) &&
      input &&
      !artifact
    ) {
      const manifest = JSON.parse(await readFile(input, "utf8"));
      assert.equal(manifest.schema, "bot-bazaar-rehearsal-v1");
      const report = await verifyRehearsalSeed(manifest, undefined, {
        registered: mode === "verify-prepared",
      });
      const output = join(
        dirname(resolve(input)),
        `${mode === "verify-prepared" ? "prepared" : "seed"}-${Date.now()}.json`,
      );
      await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
        flag: "wx",
      });
      console.info(
        `Rehearsal state verified (not a live-provider run): ${output}`,
      );
    } else
      throw new Error(
        "Usage: node scripts/rehearsal-plan.mjs prepare <public-config.json> <reviewed.wasm> | verify-seed <manifest.json>",
      );
  } catch {
    console.error(
      "Rehearsal preparation/verification failed. Preserve existing files and changed deployments; inspect public configuration and reconcile unknown transactions before retrying.",
    );
    process.exitCode = 1;
  }
}
