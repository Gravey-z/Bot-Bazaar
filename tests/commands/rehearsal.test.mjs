import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  makeRehearsalPlan,
  rehearsalCompose,
  rehearsalCommands,
  prepareRehearsal,
  validateRehearsalManifest,
  assertFreshSeed,
  verifyRehearsalSeed,
} from "../../scripts/rehearsal-plan.mjs";
import {
  accountPresence,
  transactionHash,
  executeRehearsalStep,
  reconcileRehearsalStep,
} from "../../scripts/rehearsal-command.mjs";
import { auditRehearsalStore } from "../../scripts/rehearsal-audit.mjs";
import { WorkerStore } from "../../apps/worker/dist/private/storage/database.js";
const requireWorker = createRequire(
  new URL("../../apps/worker/package.json", import.meta.url),
);
const { baseEncode } = requireWorker("near-api-js");
const input = JSON.parse(
  await readFile("tests/scenarios/rehearsal.example.json", "utf8"),
);
const fixture = JSON.parse(
  await readFile("tests/fixtures/chain/market.json", "utf8"),
);
function plan() {
  return makeRehearsalPlan(input);
}
function market(p) {
  const snapshot = structuredClone(fixture.seed.market);
  snapshot.data.contract_account_id = p.identity.contractId;
  snapshot.data.owner_account_id = p.identity.ownerId;
  for (const merchant of snapshot.data.merchants)
    merchant.controller_account_id =
      p.identity.controllers[merchant.merchant_id];
  return snapshot;
}
async function prepared(t) {
  const directory = await mkdtemp(join(tmpdir(), "bazaar-rehearsal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const artifact = join(directory, "fixture.wasm");
  await writeFile(artifact, bytes);
  const config = {
    ...input,
    codeHash: baseEncode(createHash("sha256").update(bytes).digest()),
  };
  const result = await prepareRehearsal(config, artifact, {
    baseDirectory: join(directory, "runs"),
  });
  return {
    ...result,
    config,
    artifact,
    manifestPath: join(result.directory, "manifest.json"),
  };
}

test("rehearsal namespaces use fresh accounts, a separate worker port and disabled inference", () => {
  const p = plan();
  validateRehearsalManifest(p);
  const accounts = [
    p.identity.contractId,
    p.player,
    ...Object.values(p.identity.controllers),
  ];
  assert.equal(new Set(accounts).size, 5);
  assert.ok(accounts.every((id) => id.endsWith(".operator.testnet")));
  const c = rehearsalCompose(p, "/rehearsals/unique");
  assert.equal(c.services.worker.environment.MODEL_PROVIDER, "disabled");
  assert.equal(
    c.services.worker.environment.WORKER_INITIALIZE_DATABASE,
    "false",
  );
  assert.equal(c.services.worker.volumes.length, 1);
  assert.equal(
    c.services.worker.volumes[0].source,
    join("/rehearsals/unique", "data"),
  );
  assert.equal(c.services.worker.container_name, undefined);
  assert.equal(c.services.worker.env_file, undefined);
  assert.equal(p.provider.continuity, "unverified");
});

test("invalid, secret-shaped, mainnet and overlapping namespace inputs are rejected", () => {
  for (const change of [
    { funder: "operator.near" },
    { port: 3001 },
    { runId: "../public" },
    { privateKey: "do-not-accept" },
    { activeDeployments: [] },
  ])
    assert.throws(() => makeRehearsalPlan({ ...input, ...change }));
  const p = plan(),
    collision = structuredClone(input);
  collision.activeDeployments[0].controllers.rex = p.identity.controllers.rex;
  assert.throws(() => makeRehearsalPlan(collision));
  p.identity.contractId = input.activeDeployments[0].contractId;
  assert.throws(() => validateRehearsalManifest(p));
});

test("prepared artifacts are exclusive, hash-pinned and never copy an old database or usage ledger", async (t) => {
  const p = await prepared(t);
  assert.equal(p.manifest.status, "prepared");
  assert.equal(p.manifest.liveAiEvidence, false);
  const checklist = await readFile(join(p.directory, "checklist.md"), "utf8");
  assert.match(checklist, /Adopt the fenced provider lane/);
  await assert.rejects(
    prepareRehearsal(p.config, p.artifact, {
      baseDirectory: join(p.directory, ".."),
    }),
    /EEXIST/,
  );
  await assert.rejects(
    prepareRehearsal({ ...p.config, codeHash: input.codeHash }, p.artifact, {
      baseDirectory: join(p.directory, ".."),
    }),
    /hash mismatch/,
  );
});

test("generated operator arguments target only rehearsal accounts and store keys in the keychain", () => {
  const p = plan(),
    commands = rehearsalCommands(p, "/rehearsal");
  assert.equal(commands.steps.length, 10);
  for (const step of commands.steps) {
    assert.ok(step.args.includes("testnet"));
    assert.ok(step.args.includes("sign-with-keychain"));
    assert.ok(!step.args.includes("print-to-terminal"));
    assert.notEqual(step.account, input.activeDeployments[0].contractId);
  }
  assert.equal(commands.fundingNear, "5.7");
  assert.equal(
    commands.steps.find((step) => step.id === "deploy-initialize").account,
    p.identity.contractId,
  );
});

test("fresh seed validation detects prior grants/trades, changed prices, balances and action history", () => {
  const p = plan();
  assertFreshSeed(market(p), fixture.seed.market, p.identity);
  for (const change of [
    (m) => (m.market_revision = "2"),
    (m) => (m.data.registered_player_count = "1"),
    (m) => (m.data.next_trade_id = "2"),
    (m) => (m.data.merchants[0].gold = "181"),
    (m) => (m.data.merchants[1].listings[0].unit_price = "7"),
    (m) => (m.data.merchants[2].last_action_id = "1"),
  ]) {
    const m = market(p);
    change(m);
    assert.throws(() => assertFreshSeed(m, fixture.seed.market, p.identity));
  }
});

test("read-only seed verification pins identity, all listings, no players/trades/offers to one block", async () => {
  const p = plan(),
    m = market(p),
    requests = [],
    block = fixture.seed.finalized_block;
  let registered = false;
  let methods = [
    "set_listing",
    "propose_trade",
    "accept_trade",
    "cancel_trade",
    "expire_offers",
  ];
  const rpc = async (method, args) => {
    requests.push(method);
    if (method === "status")
      return { chain_id: "testnet", sync_info: { syncing: false } };
    if (method === "block")
      return {
        header: {
          hash: block.hash,
          height: block.height,
          timestamp_nanosec: block.timestamp_ns,
        },
      };
    assert.equal(args.block_id, block.hash);
    if (args.request_type === "view_account")
      return {
        code_hash: p.identity.codeHash,
        block_hash: block.hash,
        block_height: block.height,
      };
    if (args.request_type === "view_access_key_list")
      return {
        block_hash: block.hash,
        block_height: block.height,
        keys: [
          {
            public_key: "ed25519:" + "A".repeat(43),
            access_key: {
              permission: {
                FunctionCall: {
                  receiver_id: p.identity.contractId,
                  method_names: methods,
                  allowance: "100000000000000000000000",
                },
              },
            },
          },
        ],
      };
    const data =
      args.method_name === "get_market_state"
        ? m.data
        : args.method_name === "get_player"
          ? registered
            ? {
                account_id: p.player,
                gold: "100",
                inventory: { crystal: "0", wood: "0", herb: "0", iron: "0" },
              }
            : null
          : {
              items: [],
              next_after_id: null,
              has_more: false,
              history_gap: false,
              pruned_through: "0",
            };
    return {
      block_hash: block.hash,
      block_height: block.height,
      result: [...Buffer.from(JSON.stringify({ ...m, data }))],
    };
  };
  const report = await verifyRehearsalSeed(p, rpc, {
    now: () => Number(BigInt(block.timestamp_ns) / 1000000n) + 1000,
  });
  assert.equal(report.status, "seed_verified");
  assert.equal(report.chainMutations, 0);
  assert.equal(report.providerRequests, 0);
  assert.ok(
    requests.every((method) => ["status", "block", "query"].includes(method)),
  );
  registered = true;
  m.market_revision = "2";
  m.data.registered_player_count = "1";
  m.data.total_issued_gold = "650";
  const prepared = await verifyRehearsalSeed(p, rpc, {
    registered: true,
    now: () => Number(BigInt(block.timestamp_ns) / 1000000n) + 1000,
  });
  assert.equal(prepared.status, "prepared_read_only");
  assert.equal(Object.keys(prepared.runtimeKeys).length, 3);
  methods = ["pause_market"];
  await assert.rejects(
    verifyRehearsalSeed(p, rpc, {
      registered: true,
      now: () => Number(BigInt(block.timestamp_ns) / 1000000n) + 1000,
    }),
    /restricted rehearsal runtime key/,
  );
});

test("only an explicit unknown-account response proves account absence", async () => {
  const response = (cause) => async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rehearsal-presence",
        error: { cause: { name: cause } },
      }),
    );
  assert.equal(
    await accountPresence(plan(), plan().player, response("UNKNOWN_ACCOUNT")),
    null,
  );
  await assert.rejects(
    accountPresence(plan(), plan().player, response("UNKNOWN_BLOCK")),
  );
});

test("operation journals precede invocation and forbid duplicate or uncertain signing", async (t) => {
  const p = await prepared(t);
  let invoked = 0;
  const hash = fixture.seed.finalized_block.hash;
  const dependencies = {
    preflight: async () => {},
    run: () => {
      invoked++;
      return {
        status: 0,
        stdout: `Transaction ID: ${hash}\n`,
        stderr: "PRIVATE_KEY_CANARY",
      };
    },
    confirm: async () => ({ verified: true }),
  };
  const result = await executeRehearsalStep(
    p.manifestPath,
    "create-contract",
    "fixture-cli",
    dependencies,
  );
  assert.equal(result.status, "confirmed");
  await assert.rejects(
    executeRehearsalStep(
      p.manifestPath,
      "create-contract",
      "fixture-cli",
      dependencies,
    ),
    /EEXIST/,
  );
  assert.equal(invoked, 1);
  await executeRehearsalStep(
    p.manifestPath,
    "register-player",
    "fixture-cli",
    dependencies,
  );
  const registered = JSON.parse(
    await readFile(
      join(p.directory, "operations/register-player.json"),
      "utf8",
    ),
  );
  assert.equal(registered.receiver, p.manifest.identity.contractId);
  assert.equal(registered.signer, p.manifest.player);
  assert.equal(invoked, 2);
  const stored = await readFile(
    join(p.directory, "operations/create-contract.json"),
    "utf8",
  );
  assert.doesNotMatch(stored, /PRIVATE_KEY_CANARY/);
  await assert.rejects(
    executeRehearsalStep(p.manifestPath, "create-rex", "fixture-cli", {
      ...dependencies,
      run: () => ({ error: new Error("timeout"), status: null }),
    }),
  );
  assert.equal(
    JSON.parse(
      await readFile(join(p.directory, "operations/create-rex.json"), "utf8"),
    ).status,
    "unknown",
  );
  await assert.rejects(
    executeRehearsalStep(
      p.manifestPath,
      "create-rex",
      "fixture-cli",
      dependencies,
    ),
    /EEXIST/,
  );
  assert.equal(invoked, 2);
});

test("ambiguous CLI transaction IDs are never guessed", () => {
  const hash = fixture.seed.finalized_block.hash;
  assert.equal(transactionHash(`Transaction ID: ${hash}`), hash);
  assert.throws(() => transactionHash("error"));
  assert.throws(() =>
    transactionHash(`Transaction ID: ${hash}\nTransaction ID: ${hash}`),
  );
});

test("uncertain recorded transactions reconcile the original hash without invoking a signer", async (t) => {
  const p = await prepared(t),
    hash = fixture.seed.finalized_block.hash;
  let invocations = 0;
  await assert.rejects(
    executeRehearsalStep(p.manifestPath, "create-contract", "fixture-cli", {
      preflight: async () => {},
      run: () => {
        invocations++;
        return { status: 1, stdout: `Transaction ID: ${hash}` };
      },
    }),
  );
  const result = await reconcileRehearsalStep(
    p.manifestPath,
    "create-contract",
    {
      confirm: async (_plan, _step, original) => {
        assert.equal(original, hash);
        return { verified: true };
      },
    },
  );
  assert.equal(result.resubmitted, false);
  assert.equal(result.status, "confirmed");
  assert.equal(invocations, 1);
});

test("stopped-store audit verifies backups without configuring or clearing a provider usage lane", async (t) => {
  const p = await prepared(t);
  const store = new WorkerStore({
    dataDir: join(p.directory, "data"),
    identity: p.manifest.identity,
    policyVersion: "v1",
    create: true,
  });
  store.budget.configure({
    projectId: "fixture",
    laneId: "rehearsal",
    portions: [
      { laneId: "rehearsal", dailyMicro: 100000, monthlyMicro: 1000000 },
    ],
  });
  store.budget.missingHistory(Date.now(), "fixture:fenced-history-unavailable");
  await store.close();
  const report = await auditRehearsalStore(p.manifestPath);
  assert.equal(report.counts.usage_state, 1);
  assert.equal(report.providerUsageReset, false);
  assert.equal(report.unresolvedIntents, 0);
  assert.match(report.providerContinuity, /unverified/);
  assert.match(report.backup.sha256, /^[a-f0-9]{64}$/);
  const reopened = new WorkerStore({
    dataDir: join(p.directory, "data"),
    identity: p.manifest.identity,
    policyVersion: "v1",
    create: false,
  });
  assert.equal(reopened.budget.history().config.laneId, "rehearsal");
  assert.equal(reopened.budget.status().blocked, true);
  await reopened.close();
});
