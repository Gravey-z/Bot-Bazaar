import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  rmdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import {
  TownOperations,
  operationsLimits,
} from "../dist/private/living-town/operations.js";
import { readLivingTownHealth } from "../dist/private/living-town/health.js";
import { createReadServer } from "../dist/private/read-api/server.js";
import { projectionFixture } from "./fixtures/living-town-feed.mjs";
import {
  adapterFixture,
  closeAdapterFixturesAt,
} from "./fixtures/living-town-adapter.mjs";
import { providerFixture } from "./fixtures/living-town-provider.mjs";

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-p74-"));
  t.after(() => {
    closeAdapterFixturesAt(dir);
    assert(dir.startsWith(join(tmpdir(), "bazaar-p74-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const runtime = () => ({
  recoveryRequired: false,
  unresolved: 0,
  oldestIntentAt: null,
  activeTick: null,
  lastCompletedTick: null,
  rejectedActions: 0,
});
test("read-only health exposes snapshot ages, with no invented signer/provider/budget readiness", (t) => {
  const f = projectionFixture(t),
    now = Date.now(),
    health = readLivingTownHealth(f.store, now);
  assert.equal(health.role, "read_projection");
  assert.equal(typeof health.snapshot_age_ms, "number");
  assert.equal("budget" in health, false);
  assert.equal("runtime" in health, false);
  const ops = new TownOperations("read_projection", () => now),
    report = ops.snapshot();
  assert.equal(report.runtime, null);
  assert.equal(report.provider.state, "not_attached");
  assert.equal(report.readiness.signingRuntime, false);
  assert.equal(report.snapshotAgeMs, null);
});
test("stale snapshots, stalled ticks, unresolved work, backup problems and budget ceilings produce finite coded alerts", () => {
  const now = 200000,
    ops = new TownOperations("simulation", () => now);
  ops.observeSnapshot(0, "0");
  ops.observeRuntime({
    ...runtime(),
    unresolved: 1,
    oldestIntentAt: 0,
    activeTick: { id: "tick", slot: "1", epoch: "1", createdAt: 0 },
    rejectedActions: 1,
  });
  ops.observeProvider("unavailable", {
    dailyMicro: 1000,
    dailyLimit: 1000,
    monthlyMicro: 1000,
    monthlyLimit: 10000,
    warning: true,
    blocked: false,
  });
  ops.observeBackup("failed");
  const r = ops.snapshot();
  for (const code of [
    "snapshot_stale",
    "chain_head_lag",
    "tick_stalled",
    "unknown_intents",
    "backup_failed",
    "provider_unavailable",
    "budget_warning",
    "budget_blocked",
    "actions_rejected",
  ])
    assert.ok(r.alerts.includes(code), code);
  assert.equal(r.provider.headroom.dailyMicro, 0);
  assert.equal(r.readiness.signingRuntime, false);
  assert.deepEqual(
    ops.snapshot().events,
    r.events,
    "repeated polls must not duplicate alert transitions",
  );
  ops.observeBackup("verified", now, false);
  assert.ok(ops.snapshot().alerts.includes("backup_incomplete"));
});
test("metrics retain 128 samples and 64 events without retaining untrusted labels or errors", async () => {
  let now = 1000;
  const ops = new TownOperations("read_projection", () => now);
  for (let i = 0; i < 300; i++) {
    ops.record("api", i, i % 3 === 0);
    ops.observeSnapshot(i % 2 ? 0 : now, String(now * 1000000));
    ops.snapshot();
    now += 40000;
  }
  ops.record("https://secret.invalid", 2);
  await assert.rejects(
    ops.measure("chain", async () => {
      throw Error("private-error-content");
    }),
    /private-error/,
  );
  const r = ops.snapshot();
  assert.equal(r.metrics.api.windowSamples, 128);
  assert.equal(r.metrics.api.count, 300);
  assert(r.events.length <= 64);
  assert.equal(r.metrics.chain.errors, 1);
  assert.doesNotMatch(
    JSON.stringify(r),
    /secret\.invalid|private-error-content/,
  );
});
test("completed tick identity is durable but elapsed time is measured only for a tick observed active", () => {
  let now = 10000;
  const ops = new TownOperations("simulation", () => now),
    tick = { id: "tick", slot: "1", epoch: "1", createdAt: 9000 };
  ops.observeRuntime({ ...runtime(), lastCompletedTick: tick });
  assert.equal(ops.snapshot().metrics.tick, undefined);
  ops.observeRuntime({ ...runtime(), activeTick: tick });
  now += 1000;
  ops.observeRuntime({ ...runtime(), lastCompletedTick: tick });
  ops.observeRuntime({ ...runtime(), lastCompletedTick: tick });
  assert.equal(ops.snapshot().metrics.tick.count, 1);
  assert.equal(ops.snapshot().metrics.tick.maxMs, 2000);
});
test("low disk and failed report writes latch recovery-only until repaired and explicitly resumed", async (t) => {
  const dir = directory(t),
    ops = new TownOperations("simulation");
  ops.observeStorage(0);
  assert.equal(ops.mode, "recovery_only");
  assert.throws(() => ops.setMode("active"), /repair/);
  ops.observeStorage(operationsLimits.minimumFreeBytes + 1);
  ops.setMode("active");
  const target = join(dir, "operations-health.json");
  mkdirSync(target);
  await assert.rejects(ops.persist(dir));
  assert.equal(ops.mode, "recovery_only");
  assert.throws(() => ops.setMode("active"), /repair/);
  rmdirSync(target);
  await ops.persist(dir);
  assert.equal(ops.mode, "recovery_only");
  ops.setMode("active");
  await ops.persist(dir);
  assert(readFileSync(target).length < 65536);
});
test("private checker reports healthy, alerting and stale states with bounded exit codes", async (t) => {
  const dir = directory(t),
    ops = new TownOperations("read_projection");
  ops.observeSnapshot(Date.now(), String(BigInt(Date.now()) * 1000000n));
  ops.observeBackup("verified", Date.now());
  await ops.persist(dir);
  const path = join(dir, "operations-health.json"),
    check = () =>
      spawnSync(
        process.execPath,
        ["scripts/living-town-operations-check.mjs", path],
        { encoding: "utf8", timeout: 5000 },
      );
  assert.equal(check().status, 0);
  ops.observeBackup("failed");
  await ops.persist(dir);
  assert.equal(check().status, 1);
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.capturedAt = 0;
  writeFileSync(path, JSON.stringify(value));
  assert.equal(check().status, 2);
});
test("simulation starts recovery-only, pauses without signing, and recovers submitted work without another dispatch", async (t) => {
  const operations = new TownOperations("simulation"),
    f = await adapterFixture(directory(t), { operations });
  assert.equal((await f.simulation.poll()).kind, "blocked");
  assert.equal(f.stats.sign, 0);
  assert.equal(f.stats.send, 0);
  operations.setMode("paused");
  assert.equal((await f.simulation.poll()).kind, "blocked");
  assert.equal(f.stats.sign, 0);
  operations.setMode("active");
  for (let i = 0; i < 8 && f.stats.send === 0; i++) await f.simulation.poll();
  assert(f.stats.send > 0);
  const signs = f.stats.sign,
    sends = f.stats.send;
  operations.setMode("recovery_only");
  await f.simulation.poll();
  assert.equal(f.stats.sign, signs);
  assert.equal(f.stats.send, sends);
  assert.equal(
    typeof operations.snapshot().runtime.recoveryRequired,
    "boolean",
  );
  assert(operations.snapshot().metrics.poll.count >= 4);
});
test("provider telemetry uses the actual shared accounting snapshot and never exposes request payloads", async (t) => {
  const operations = new TownOperations("simulation"),
    f = await providerFixture(t, { operations });
  await f.runner.propose(f.context);
  const r = operations.snapshot();
  assert.equal(r.provider.state, "available");
  assert.equal(r.provider.budget.dailyMicro, f.budget.status().dailyMicro);
  assert.equal(
    r.provider.headroom.dailyMicro,
    f.budget.status().dailyLimit - f.budget.status().dailyMicro,
  );
  assert.doesNotMatch(
    JSON.stringify(r),
    /messages|promptVersion|payload_hash|publicKey/,
  );
});
test("a pause arriving during recovery blocks the later dispatch boundary", async (t) => {
  const operations = new TownOperations("simulation"),
    f = await adapterFixture(directory(t), { operations });
  operations.setMode("active");
  const recover = f.simulation.runtime.recover.bind(f.simulation.runtime);
  f.simulation.runtime.recover = async () => {
    const result = await recover();
    operations.setMode("paused");
    return result;
  };
  const result = await f.simulation.poll();
  assert.equal(result.kind, "blocked");
  assert.equal(f.stats.sign, 0);
  assert.equal(f.stats.send, 0);
});
test("HTTP measurements cover successful and rejected responses without adding public operations routes", async (t) => {
  const f = projectionFixture(t),
    ops = new TownOperations("read_projection");
  const server = createReadServer(
    {
      health: () => readLivingTownHealth(f.store),
      activity: () => {
        throw Error("no V1");
      },
      livingTown: {
        town: () => f.store.town(),
        shop: () => null,
        inventory: () => null,
        production: () => null,
      },
    },
    {
      allowedOrigins: [],
      trustedProxyIps: [],
      clientPerMinute: 60,
      globalPerSecond: 10,
    },
    (duration, status) => ops.record("api", duration, status >= 400),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${url}/health`);
    assert.equal(r.status, 200);
    await r.text();
  }
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      const r = await fetch(`${url}/health`);
      assert.equal(r.status, 200);
      await r.text();
    }),
  );
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${url}/operations`);
    assert.equal(r.status, 404);
    await r.text();
  }
  const metrics = ops.snapshot().metrics.api;
  assert.equal(metrics.count, 19);
  assert.equal(metrics.errors, 3);
  assert.ok(ops.snapshot().alerts.includes("api_errors"));
  t.diagnostic(
    "P74_LOCAL_HTTP=" +
      JSON.stringify({
        mode: "controlled_local_read_projection_not_hosted_capacity",
        sequential: 8,
        parallel: 8,
        ...metrics,
      }),
  );
});
