import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  executionFixture,
  closeFixturesAt,
} from "./fixtures/living-town-execution.mjs";
import { LivingTownTickScheduler } from "../dist/private/living-town/ticks.js";
import { LivingTownTickRunner } from "../dist/private/living-town/tick-runner.js";

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-town-catchup-"));
  t.after(() => {
    closeFixturesAt(dir);
    assert(dir.startsWith(join(tmpdir(), "bazaar-town-catchup-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function runner(f, collect = async () => f.input()) {
  const scheduler = new LivingTownTickScheduler(f.store, f.demand, 30000);
  return new LivingTownTickRunner(
    f.store,
    scheduler,
    f.processor,
    f.adapter.client,
    collect,
  );
}
async function fixture(t) {
  const f = await executionFixture(directory(t));
  await f.processor.recover();
  return f;
}
function advance(f, seconds) {
  const t = f.state.town;
  t.block_timestamp_ns = (
    BigInt(t.block_timestamp_ns) +
    BigInt(seconds) * 1000000000n
  ).toString();
  t.block_height = (BigInt(t.block_height) + 1n).toString();
  t.data.epoch = (
    (BigInt(t.block_timestamp_ns) - BigInt(t.data.genesis_time_ns)) /
    60000000000n
  ).toString();
  // Controlled effective views: do not mutate a previously captured original effect.
  t.data.customer_pool = structuredClone(t.data.customer_pool);
  t.data.customer_pool.epoch = t.data.epoch;
  t.data.customer_pool.potion_units_bought = "0";
  t.data.customer_pool.tool_units_bought = "0";
  for (const shop of f.state.shops)
    for (const key of ["shop", "ledger"])
      Object.assign(shop[key], {
        block_height: t.block_height,
        block_timestamp_ns: t.block_timestamp_ns,
      });
}
async function planned(f) {
  const s = new LivingTownTickScheduler(f.store, f.demand, 30000);
  return s.prepare(await f.adapter.client.finalized());
}
async function customerReady(f) {
  const tick = await planned(f);
  if (f.store.ticks.actions(tick.id)[0]?.arrival === "fund") {
    await f.processor.fundCurrentEpoch();
    await f.processor.recover();
  }
  return tick;
}

test("long downtime expires only never-started old opportunities and coalesces missed slots without a funding backlog", async (t) => {
  const f = await fixture(t),
    old = await planned(f);
  advance(f, 100 * 86400);
  const result = await runner(f).poll();
  assert.equal(result.kind, "advanced");
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
  assert.equal(f.store.ticks.get(old.id).state, "completed");
  assert(
    f.store.ticks
      .actions(old.id)
      .every(
        (a) =>
          a.state === "expired" &&
          JSON.parse(a.resolution_json).kind === "missed_epoch",
      ),
  );
  const current = f.store.ticks.active();
  assert.equal(current.sequence, 2);
  assert(BigInt(current.skipped_slots) > 100000n);
  assert(BigInt(current.missed_epochs) > 100000n);
  assert(f.store.ticks.actions(current.id).length <= 5);
  assert.equal(f.state.town.data.customer_pool.gold, "200");
  const before = f.counts.send;
  await runner(f).poll();
  assert(f.counts.send - before <= 1);
  assert.equal(f.store.ticks.active().id, current.id);
});

for (const point of [
  "before_sign",
  "after_signed",
  "after_unknown",
  "after_network",
]) {
  test(`tick runner recovers real process death at ${point} with the original intent identity`, async (t) => {
    const dir = directory(t);
    const script = `import {executionFixture} from './apps/worker/test/fixtures/living-town-execution.mjs'; import {LivingTownTickScheduler} from './apps/worker/dist/private/living-town/ticks.js'; import {LivingTownTickRunner} from './apps/worker/dist/private/living-town/tick-runner.js'; const f=await executionFixture(${JSON.stringify(dir)},{crashAt:${JSON.stringify(point)}});const s=new LivingTownTickScheduler(f.store,f.demand,30000);await new LivingTownTickRunner(f.store,s,f.processor,f.adapter.client,async()=>f.input()).poll();process.exit(99);`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30000 },
    );
    assert.notEqual(child.status, 99, child.stderr);
    assert.notEqual(child.status, 0, child.stderr);
    const f = await executionFixture(dir),
      row = f.store.unresolved()[0];
    assert(row);
    const tick = f.store.ticks.active(),
      args = row.args_json,
      signed = row.signed_json;
    const result = await runner(f).poll();
    assert.equal(f.store.get(row.id).args_json, args);
    assert.equal(f.store.ticks.active().id, tick.id);
    if (point === "after_unknown") {
      assert.equal(result.kind, "blocked");
      assert.equal(f.counts.send, 0);
      assert.equal(f.counts.sign, 0);
      advance(f, 86400);
      assert.equal((await runner(f).poll()).kind, "blocked");
      assert.equal(f.store.ticks.get(tick.id).state, "running");
    } else if (point === "after_network") {
      assert.equal(f.store.get(row.id).status, "confirmed");
      assert(f.counts.send <= 1);
      assert.notEqual(result.action?.actionId, row.id);
    } else {
      assert.equal(result.action.actionId, row.id);
      assert.equal(result.action.kind, "submitted");
      assert.equal(f.counts.sign, point === "before_sign" ? 1 : 0);
      assert.equal(f.counts.send, 1);
    }
    if (signed) assert.equal(f.store.get(row.id).signed_json, signed);
  });
}

test("recovery drops a stale prepared/signed quote without replacing its ID or signature", async (t) => {
  for (const state of ["prepared", "signed"]) {
    const f = await fixture(t),
      tick = await customerReady(f);
    const original =
      state === "prepared"
        ? f.adapter.prepare.bind(f.adapter)
        : f.store.markBroadcast.bind(f.store);
    if (state === "prepared")
      f.adapter.prepare = async () => {
        throw Error("controlled before signature");
      };
    else
      f.store.markBroadcast = () => {
        throw Error("controlled before broadcast");
      };
    await assert.rejects(f.processor.executeCustomer(f.input()), /controlled/);
    if (state === "prepared") f.adapter.prepare = original;
    else f.store.markBroadcast = original;
    const row = f.store.unresolved()[0],
      decision = JSON.parse(f.store.get(row.id).decision_json);
    const listing = f.state.listings.find(
      (l) => l.listing_id === decision.terms.listing_id,
    );
    listing.revision = (BigInt(listing.revision) + 1n).toString();
    const signs = f.counts.sign,
      sends = f.counts.send;
    const result = await runner(f).poll();
    assert.equal(result.action.kind, "skipped");
    assert.equal(result.action.actionId, row.id);
    assert.equal(f.store.get(row.id).status, "abandoned");
    assert.equal(
      f.store.ticks.actions(tick.id).find((a) => a.action_id === row.id).state,
      "expired",
    );
    assert.equal(f.counts.sign, signs);
    assert.equal(f.counts.send, sends);
  }
});

test("partial or changed finalized collection defers rather than consuming/signing the planned opportunity", async (t) => {
  const f = await fixture(t),
    tick = await customerReady(f),
    before = f.store.ticks.actions(tick.id);
  const signs = f.counts.sign;
  assert.equal(
    (
      await runner(f, async () => ({
        ...f.input(),
        marketComplete: false,
      })).poll()
    ).kind,
    "deferred",
  );
  const changing = runner(f, async () => {
    const input = f.input();
    f.state.town.market_revision = f.state.town.event_sequence = (
      BigInt(f.state.town.market_revision) + 1n
    ).toString();
    return input;
  });
  assert.equal((await changing.poll()).kind, "deferred");
  assert.deepEqual(f.store.ticks.actions(tick.id), before);
  assert.equal(f.counts.sign, signs);
});

test("RPC outage during recovery preserves unsent bytes and does not classify transport errors as stale failure", async (t) => {
  const f = await fixture(t);
  await customerReady(f);
  const broadcast = f.store.markBroadcast.bind(f.store);
  f.store.markBroadcast = () => {
    throw Error("controlled before broadcast");
  };
  await assert.rejects(f.processor.executeCustomer(f.input()), /controlled/);
  f.store.markBroadcast = broadcast;
  const row = f.store.unresolved()[0],
    read = f.adapter.client.finalized.bind(f.adapter.client);
  f.adapter.client.finalized = async () => {
    throw Error("controlled RPC outage");
  };
  await assert.rejects(runner(f).poll(), /RPC outage/);
  assert.equal(f.store.get(row.id).status, "signed");
  assert.equal(f.store.get(row.id).signed_json, row.signed_json);
  f.adapter.client.finalized = read;
  const signs = f.counts.sign;
  assert.equal((await runner(f).poll()).action.actionId, row.id);
  assert.equal(f.counts.sign, signs);
});

test("expired unsent work closes before old-epoch plans expire, with no old-epoch broadcast", async (t) => {
  const f = await fixture(t),
    tick = await customerReady(f);
  const broadcast = f.store.markBroadcast.bind(f.store);
  f.store.markBroadcast = () => {
    throw Error("controlled before broadcast");
  };
  await assert.rejects(f.processor.executeCustomer(f.input()), /controlled/);
  f.store.markBroadcast = broadcast;
  const row = f.store.unresolved()[0],
    before = f.counts.send;
  advance(f, 600);
  await runner(f).poll();
  assert.equal(f.store.get(row.id).status, "abandoned");
  assert.equal(f.store.ticks.get(tick.id).state, "completed");
  assert(f.counts.send - before <= 1);
  const pending = f.store.unresolved();
  assert(
    pending.every(
      (a) => JSON.parse(a.args_json).epoch === f.state.town.data.epoch,
    ),
  );
});

test("pause or already-allocated finalized funding closes only the unstarted funding opportunity without a fake receipt", async (t) => {
  for (const paused of [true, false]) {
    const f = await fixture(t),
      tick = await planned(f);
    const funding = f.store.ticks
      .actions(tick.id)
      .find((a) => a.arrival === "fund");
    assert(funding);
    // Explicitly controlled change between planning and dispatch, not another chain execution.
    if (paused) f.state.town.data.paused = true;
    else
      f.state.town.data.customer_pool.last_funded_epoch =
        f.state.town.data.epoch;
    assert.equal((await runner(f).poll()).kind, "advanced");
    const saved = f.store.ticks
      .actions(tick.id)
      .find((a) => a.arrival === "fund");
    assert.equal(saved.state, "completed");
    assert.equal(
      JSON.parse(saved.resolution_json).kind,
      paused ? "paused" : "already_allocated",
    );
    assert.equal(f.store.get(funding.action_id), undefined);
    assert.equal(f.counts.sign, 0);
    assert.equal(f.counts.send, 0);
  }
});

test("overlapping polls and repeated completed-slot polls never exceed one dispatch per poll or replay the epoch", async (t) => {
  const f = await fixture(t),
    r = runner(f);
  const pair = await Promise.allSettled([r.poll(), r.poll()]);
  assert.equal(pair.filter((p) => p.status === "fulfilled").length, 1);
  assert.match(
    pair.find((p) => p.status === "rejected").reason.message,
    /already in progress/,
  );
  for (let i = 0; i < 5; i++) {
    const before = f.counts.send;
    await r.poll();
    assert(f.counts.send - before <= 1);
  }
  const before = f.counts.send;
  for (let i = 0; i < 4; i++) assert.equal((await r.poll()).kind, "idle");
  assert.equal(f.counts.send, before);
  assert.equal(before, 5);
  assert.equal(f.store.ticks.active(), undefined);
  assert.equal(f.state.town.data.customer_pool.potion_units_bought, "2");
  assert.equal(f.state.town.data.customer_pool.tool_units_bought, "2");
});

test("a newer finalized block with unchanged economic state can dispatch coherent collected facts", async (t) => {
  const f = await fixture(t);
  await customerReady(f);
  const signs = f.counts.sign;
  const result = await runner(f, async () => {
    const facts = f.input();
    // Controlled block progress only. Keep the collected pages pinned to their original block.
    f.state.town.block_height = (
      BigInt(f.state.town.block_height) + 1n
    ).toString();
    f.state.town.block_timestamp_ns = (
      BigInt(f.state.town.block_timestamp_ns) + 1n
    ).toString();
    return facts;
  }).poll();
  assert.equal(result.kind, "advanced");
  assert.equal(result.action.kind, "submitted");
  assert.equal(f.counts.sign, signs + 1);
});
