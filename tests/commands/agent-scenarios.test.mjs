import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { controlledTurn } from "../scenarios/controlled-turn.mjs";
import {
  testnetPreflight,
  runScenario,
} from "../../scripts/run-agent-scenario.mjs";

const capture = JSON.parse(
  await readFile(
    new URL("../fixtures/chain/market.json", import.meta.url),
    "utf8",
  ),
);
function input(merchantId = "rex", phase = "decision") {
  const market = structuredClone(capture.seed.market),
    now = Number(BigInt(market.block_timestamp_ns) / 1000000n);
  market.data.merchants[0].inventory.crystal = "3";
  market.data.merchants[0].gold = "228";
  market.data.merchants[0].listings[0].quantity = "3";
  return {
    merchantId,
    phase,
    state: {
      market,
      block: {
        hash: null,
        height: market.block_height,
        timestampNs: market.block_timestamp_ns,
      },
      observedAt: now,
      offers: [],
      trades: [],
      tradeCursor: "0",
      mode: "initial",
    },
  };
}

test("controlled provider is deterministic, labelled and goes through real schema/policy prerequisites", () => {
  const request = input(),
    first = controlledTurn(request),
    second = controlledTurn(request);
  assert.deepEqual(first, second);
  assert.equal(first.liveAiEvidence, false);
  assert.equal(first.provider, "controlled-fixture");
  assert.equal(first.providerInvoked, true);
  assert.equal(first.candidate.action.method, "propose_trade");
  assert.equal(first.plan.preparations[0].args.active, false);
  assert.match(first.promptSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.candidate.action.args.total_price, "24");
});

test("controlled revalidation allocates next action after prerequisites without another provider decision", () => {
  const request = input(),
    first = controlledTurn(request);
  const own = request.state.market.data.merchants[0];
  own.last_action_id = "1";
  own.listings[0].active = false;
  own.listings[0].quantity = "0";
  own.listings[0].version = "2";
  const next = controlledTurn({ ...request, candidate: first.candidate });
  assert.equal(next.providerInvoked, false);
  assert.equal(next.candidate.action.args.action_id, "2");
  assert.deepEqual(next.plan.preparations, []);
  assert.equal(
    next.candidate.action.args.total_price,
    first.candidate.action.args.total_price,
  );
  assert.equal(next.candidate.reason, first.candidate.reason);
});

test("controlled candidate errors fail validation instead of falling back to a successful choice", () => {
  const request = input();
  assert.throws(() =>
    controlledTurn({
      ...request,
      candidate: { action: { method: "delete_market" }, reason: "bad" },
    }),
  );
  const buy = controlledTurn(request).candidate;
  buy.action.args.quantity = "100";
  buy.action.args.total_price = "600";
  assert.throws(() => controlledTurn({ ...request, candidate: buy }));
  assert.equal(controlledTurn(input("bolt")).candidate.action.method, "hold");
});

test("real-provider Testnet preflight is separate, blocked and does not dispatch even with a key in environment", async () => {
  const before = process.env.NEAR_AI_API_KEY;
  process.env.NEAR_AI_API_KEY = "PRIVATE_SCENARIO_CANARY";
  try {
    const report = await testnetPreflight();
    assert.equal(report.mode, "real_provider_testnet");
    assert.equal(report.status, "blocked");
    assert.equal(report.providerRequests, 0);
    assert.equal(report.chainMutations, 0);
    assert.equal(report.liveAiEvidence, false);
    assert.ok(report.blockers.includes("explicit_owner_spend_approval"));
    assert.ok(report.blockers.includes("reviewed_near_ai_adapter"));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SCENARIO_CANARY/);
  } finally {
    if (before === undefined) delete process.env.NEAR_AI_API_KEY;
    else process.env.NEAR_AI_API_KEY = before;
  }
});

test("Testnet tooling persists a blocked run and cannot accept an execute/approval bypass flag", async (t) => {
  const result = await runScenario(["testnet"], () => {
    throw new Error("No commands allowed");
  });
  t.after(() =>
    rm(dirname(result.reportPath), { recursive: true, force: true }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(
    JSON.parse(await readFile(result.reportPath, "utf8")).status,
    "blocked",
  );
  assert.match(result.reportPath, /near-ai-testnet-preflight\.json$/);
  await assert.rejects(runScenario(["testnet", "--execute"]));
});

test("a controlled build/run failure records failure without retrying or claiming live success", async (t) => {
  let calls = 0;
  const result = await runScenario(["sandbox"], () => {
    calls++;
    return { status: 1 };
  });
  t.after(() =>
    rm(dirname(result.reportPath), { recursive: true, force: true }),
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.status, "failed");
  assert.equal(report.liveAiEvidence, false);
  assert.equal(report.mode, "controlled_sandbox");
});

test("controlled provider CLI accepts bounded stdin and emits sanitized validation failures", () => {
  const result = spawnSync(
    process.execPath,
    ["tests/scenarios/controlled-turn.mjs"],
    { input: JSON.stringify(input()), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).provider, "controlled-fixture");
  for (const value of ['{"privateKey":"PRIVATE_CANARY"}', "x".repeat(262145)]) {
    const invalid = spawnSync(
      process.execPath,
      ["tests/scenarios/controlled-turn.mjs"],
      { input: value, encoding: "utf8" },
    );
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.doesNotMatch(invalid.stderr, /PRIVATE_CANARY/);
  }
});

test("sandbox execution has no repository/credential mount and disables external networking", async (t) => {
  const commands = [];
  const result = await runScenario(["sandbox"], (_exe, args) => {
    commands.push(args);
    return { status: commands.length === 4 ? 1 : 0 };
  });
  t.after(() =>
    rm(dirname(result.reportPath), { recursive: true, force: true }),
  );
  assert.equal(commands.length, 4);
  assert.ok(commands[3].includes("none"));
  for (const args of commands.slice(2)) {
    const command = args.join(" ");
    assert.doesNotMatch(
      command,
      /target=\/workspace(?:,|\s|$)|--env-file|NEAR_AI_API_KEY|worker\.env/,
    );
  }
});
