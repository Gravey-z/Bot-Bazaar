import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionFixture,
  closeFixturesAt,
} from "./fixtures/living-town-execution.mjs";
import { LivingTownTickScheduler } from "../dist/private/living-town/ticks.js";

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-town-ticks-"));
  t.after(() => {
    closeFixturesAt(dir);
    assert(dir.startsWith(join(tmpdir(), "bazaar-town-ticks-")));
    rmSync(dir, { recursive: true, force: true });
  });
  const f = await executionFixture(dir);
  await f.processor.recover();
  const scheduler = new LivingTownTickScheduler(f.store, f.demand, 30000);
  return {
    ...f,
    dir,
    scheduler,
    prepare: async () => scheduler.prepare(await f.adapter.client.finalized()),
  };
}
function advance(f, ms = 60000) {
  const town = f.state.town;
  town.block_timestamp_ns = (
    BigInt(town.block_timestamp_ns) +
    BigInt(ms) * 1000000n
  ).toString();
  town.block_height = (BigInt(town.block_height) + 1n).toString();
  const oldEpoch = town.data.epoch;
  town.data.epoch = (
    (BigInt(town.block_timestamp_ns) - BigInt(town.data.genesis_time_ns)) /
    60000000000n
  ).toString();
  // Controlled finalized-view rollover, matching the contract's effective epoch counters.
  if (oldEpoch !== town.data.epoch) {
    town.data.customer_pool.epoch = town.data.epoch;
    town.data.customer_pool.potion_units_bought = "0";
    town.data.customer_pool.tool_units_bought = "0";
  }
}
async function fund(f, tick) {
  if (f.store.ticks.actions(tick.id)[0]?.arrival === "fund") {
    assert.equal((await f.processor.fundCurrentEpoch()).kind, "submitted");
    assert.equal((await f.processor.recover()).kind, "ready");
  }
}

test("tick cadence, seed/config and first finalized checkpoint are persisted and duplicate observations preserve the plan", async (t) => {
  const f = await fixture(t);
  const reader = await f.adapter.client.finalized();
  for (const cadence of [0, 29999, 60001, 30000.5, NaN])
    await assert.rejects(
      new LivingTownTickScheduler(f.store, f.demand, cadence).prepare(reader),
      /cadence/,
    );
  const tick = await f.prepare();
  assert.equal(tick.sequence, 1);
  assert.equal(tick.seed, "42");
  assert.equal(tick.state, "prepared");
  assert.equal(JSON.parse(tick.config_json).cadenceMs, "30000");
  assert.deepEqual(JSON.parse(tick.checkpoint_json).block, reader.block);
  const plan = f.store.ticks.actions(tick.id);
  assert(plan.length >= 4 && plan.length <= 5);
  assert.deepEqual(
    plan.filter((a) => a.arrival !== "fund").map((a) => a.arrival),
    ["0", "1", "2", "3"],
  );
  assert.deepEqual(await f.prepare(), tick);
  assert.deepEqual(f.store.ticks.actions(tick.id), plan);
  assert.equal(f.counts.sign, 0);
  advance(f);
  await assert.rejects(f.prepare(), /unresolved/);
  assert.deepEqual(f.store.ticks.get(tick.id), tick);
});

test("tick plans bind ordered customer intents and no-purchase outcomes atomically until the whole tick is terminal", async (t) => {
  const f = await fixture(t);
  const town = f.state.town;
  // Place this controlled test at the first half of a new economic epoch.
  town.block_timestamp_ns = (
    BigInt(town.data.genesis_time_ns) +
    (BigInt(town.data.epoch) + 1n) * 60000000000n
  ).toString();
  advance(f, 0);
  const tick = await f.prepare();
  await fund(f, tick);
  await assert.rejects(
    f.processor.executeCustomer({
      ...f.input(),
      arrivalIndex: "1",
      fresh: false,
    }),
    /next persisted tick plan/,
  );
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.throws(
    () =>
      f.store.claimRuntimeJob("other-merchant", ["rex"], Date.now() + 30000),
    /tick/,
  );
  for (let i = 0; i < 4; i++) {
    const input = { ...f.input(), arrivalIndex: String(i), fresh: false };
    assert.equal(
      (await f.processor.executeCustomer(input)).kind,
      "no_purchase",
    );
    const saved = f.store.ticks.get(tick.id);
    assert.equal(saved.state, i === 3 ? "completed" : "running");
  }
  assert(f.store.ticks.actions(tick.id).every((a) => a.state === "completed"));
  const signs = f.counts.sign;
  assert.deepEqual(await f.prepare(), f.store.ticks.get(tick.id));
  assert.equal(f.counts.sign, signs);
  // Another cadence slot in the same economic epoch cannot create new opportunities.
  advance(f, 30000);
  const next = await f.prepare();
  assert.equal(next.sequence, 2);
  assert.equal(next.state, "completed");
  assert.equal(f.store.ticks.actions(next.id).length, 0);
});

test("an unknown broadcast keeps the tick unresolved after restart and elapsed cadence without another signature", async (t) => {
  const f = await fixture(t),
    tick = await f.prepare();
  await fund(f, tick);
  f.mode("timeout_before_execution");
  const result = await f.processor.executeCustomer(f.input());
  assert.equal(result.kind, "unknown");
  const signed = f.store.get(result.actionId).signed_json;
  assert.equal(f.store.ticks.get(tick.id).state, "running");
  assert.throws(
    () => f.store.ticks.settled(result.actionId, "completed"),
    /known/,
  );
  f.save();
  f.close();
  const reopened = await executionFixture(f.dir);
  advance(reopened, 120000);
  assert.equal((await reopened.processor.recover()).kind, "blocked");
  const scheduler = new LivingTownTickScheduler(
    reopened.store,
    reopened.demand,
    30000,
  );
  await assert.rejects(
    scheduler.prepare(await reopened.adapter.client.finalized()),
    /recovery/,
  );
  assert.equal(reopened.store.get(result.actionId).signed_json, signed);
  assert.equal(reopened.store.ticks.get(tick.id).state, "running");
  assert.equal(reopened.counts.sign, 0);
  assert.equal(reopened.counts.send, 0);
});

test("known receipt recovery advances only its own tick action and preserves pending siblings", async (t) => {
  const f = await fixture(t),
    tick = await f.prepare();
  await fund(f, tick);
  f.mode("timeout_after_execution");
  const result = await f.processor.executeCustomer(f.input());
  assert.equal(result.kind, "unknown");
  assert.equal((await f.processor.recover()).kind, "ready");
  const plan = f.store.ticks.actions(tick.id);
  assert.equal(
    plan.find((a) => a.action_id === result.actionId).state,
    "completed",
  );
  assert.equal(plan.filter((a) => a.state === "planned").length, 3);
  assert.equal(f.store.ticks.get(tick.id).state, "running");
  assert.equal(
    (await f.processor.executeCustomer(f.input())).kind,
    "duplicate",
  );
  assert.deepEqual(f.store.ticks.actions(tick.id), plan);
});

test("wrong checkpoint identity and competing work cannot create a tick; prepared ticks survive reopening behind recovery", async (t) => {
  const f = await fixture(t),
    reader = await f.adapter.client.finalized(),
    town = await reader.getTown();
  assert.throws(
    () =>
      f.store.ticks.prepare(
        { block: reader.block, codeHash: "wrong", town },
        30000,
        [],
      ),
    /checkpoint/,
  );
  f.store.claimRuntimeJob("merchant-turn", ["bolt"], Date.now() + 30000);
  await assert.rejects(f.prepare(), /economic work/);
  await f.processor.recover();
  f.store.completeRuntimeJob("merchant-turn");
  const tick = await f.prepare(),
    plan = f.store.ticks.actions(tick.id);
  f.save();
  f.close();
  const reopened = await executionFixture(f.dir);
  const scheduler = new LivingTownTickScheduler(
    reopened.store,
    reopened.demand,
    30000,
  );
  await assert.rejects(
    scheduler.prepare(await reopened.adapter.client.finalized()),
    /recovery/,
  );
  assert.equal((await reopened.processor.recover()).kind, "ready");
  assert.deepEqual(
    await scheduler.prepare(await reopened.adapter.client.finalized()),
    tick,
  );
  assert.deepEqual(reopened.store.ticks.actions(tick.id), plan);
});

test("paused empty ticks finish without signing and persist cadence across later observations", async (t) => {
  const f = await fixture(t);
  f.state.town.data.paused = true;
  const first = await f.prepare();
  assert.equal(first.state, "completed");
  assert.equal(f.store.ticks.actions(first.id).length, 0);
  advance(f, 30000);
  const second = await f.prepare();
  assert.equal(second.sequence, 2);
  const changed = new LivingTownTickScheduler(f.store, f.demand, 60000);
  advance(f, 60000);
  await assert.rejects(
    changed.prepare(await f.adapter.client.finalized()),
    /cadence\/config/,
  );
  assert.equal(f.counts.sign, 0);
});

test("tick/action persistence faults roll back together and cannot consume an opportunity", async (t) => {
  const f = await fixture(t),
    tick = await f.prepare();
  await fund(f, tick);
  const before = f.store.ticks.actions(tick.id);
  const original = f.store.ticks.settled.bind(f.store.ticks);
  f.store.ticks.settled = (...args) => {
    original(...args);
    throw Error("controlled commit boundary fault");
  };
  const input = { ...f.input(), fresh: false },
    actionId = f.demand.select(input).customerId;
  await assert.rejects(
    f.processor.executeCustomer(input),
    /commit boundary fault/,
  );
  assert.equal(f.store.get(actionId), undefined);
  assert.deepEqual(f.store.ticks.actions(tick.id), before);
  f.store.ticks.settled = original;
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal((await f.processor.executeCustomer(input)).kind, "no_purchase");
  assert.equal(
    f.store.ticks.actions(tick.id).find((a) => a.action_id === actionId).state,
    "completed",
  );
});

test("overlapping observations and incoherent or non-advancing finalized checkpoints cannot create extra ticks", async (t) => {
  const f = await fixture(t);
  f.state.town.data.paused = true;
  const outcomes = await Promise.allSettled([f.prepare(), f.prepare()]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.match(
    outcomes.find((o) => o.status === "rejected").reason.message,
    /already in progress/,
  );
  const tick = outcomes.find((o) => o.status === "fulfilled").value;
  advance(f, 30000);
  f.state.town.block_height = (
    BigInt(f.state.town.block_height) - 1n
  ).toString();
  await assert.rejects(f.prepare(), /newer finalized block/);
  await f.processor.recover();
  f.state.town.data.epoch = (BigInt(f.state.town.data.epoch) + 1n).toString();
  await assert.rejects(f.prepare(), /epoch is inconsistent/);
  assert.equal(f.store.ticks.get(tick.id).sequence, 1);
});
