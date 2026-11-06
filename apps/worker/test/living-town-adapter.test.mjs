import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  adapterFixture,
  identity,
  closeAdapterFixturesAt,
} from "./fixtures/living-town-adapter.mjs";
import {
  parseTownProposal,
  townProposalSchema,
  resolveTownProposal,
} from "../dist/private/living-town/proposals.js";
import {
  readTownPrepared,
  townCall,
} from "../dist/private/living-town/town-chain.js";
import {
  assertRuntimePermission,
  townMerchantMethods,
  townSourceMethods,
  runtimeMethods,
  customerRuntimeMethods,
} from "../dist/private/near-signer.js";
const tickId = "a".repeat(64);
const envelope = (
  merchant = "rex",
  action = { type: "wait" },
  tick = tickId,
  rev = "1",
) => ({
  schema: "living-town-proposal-v1",
  tick_id: tick,
  market_revision: rev,
  merchant_id: merchant,
  reason: "controlled proposal",
  action,
});
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-proposal-adapter-"));
  t.after(() => {
    assert(dir.startsWith(join(tmpdir(), "bazaar-proposal-adapter-")));
    closeAdapterFixturesAt(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
async function fixture(t, options) {
  const dir = directory(t),
    f = await adapterFixture(dir, options);
  t.after(() => f.close());
  return { ...f, dir };
}
function allocated(f) {
  const e = f.state.town.data.epoch;
  for (const k of Object.keys(f.state.markers.raw_epochs))
    f.state.markers.raw_epochs[k] = e;
  for (const k of Object.keys(f.state.markers.treasury_epochs))
    f.state.markers.treasury_epochs[k] = e;
}

test("strict proposal schema accepts six bounded shapes and rejects fields, numbers, actors, getters and stale references", () => {
  const actions = [
    { type: "wait" },
    { type: "adjust_price", item_id: "crystal", unit_price: "5" },
    { type: "restock", item_id: "iron_tool" },
    {
      type: "propose_trade",
      counterparty: "luna",
      side: "buy",
      item_id: "herb",
      quantity: "2",
      unit_price: "3",
    },
    { type: "accept_trade", offer_id: "1", expected_offer_revision: "1" },
    { type: "reject_trade", offer_id: "1" },
  ];
  assert.equal(townProposalSchema.properties.action.oneOf.length, 6);
  for (const action of actions)
    assert.deepEqual(parseTownProposal(envelope("rex", action)).action, action);
  for (const bad of [
    { ...envelope(), method: "allocate_raw_supply" },
    { ...envelope(), merchant_id: "player.testnet" },
    { ...envelope(), tick_id: "1" },
    { ...envelope(), market_revision: 1 },
    { ...envelope(), market_revision: "18446744073709551616" },
    envelope("rex", { type: "restock", item_id: "gold" }),
    envelope("rex", {
      type: "adjust_price",
      item_id: "crystal",
      unit_price: 5,
    }),
    envelope("rex", {
      type: "adjust_price",
      item_id: "crystal",
      unit_price: "05",
    }),
    envelope("rex", {
      type: "adjust_price",
      item_id: "crystal",
      unit_price: "5\n",
    }),
    envelope("rex", {
      type: "propose_trade",
      counterparty: "rex",
      side: "buy",
      item_id: "crystal",
      quantity: "1",
      unit_price: "4",
    }),
    envelope("rex", { type: "wait", args: {} }),
  ])
    assert.throws(() => parseTownProposal(bad));
  let read = 0;
  const hostile = { ...envelope() };
  Object.defineProperty(hostile, "action", {
    enumerable: true,
    get() {
      read++;
      throw Error("getter invoked");
    },
  });
  assert.throws(() => parseTownProposal(hostile));
  assert.equal(read, 0);
});

test("deterministic adapter binds price-only stock/reserves and deliberately declines unavailable V2 trades", async (t) => {
  const f = await fixture(t),
    input = await f.collect(),
    town = f.state.town;
  const c = {
    sequence: "1",
    config_version: "1",
    valid_until_ns: (
      BigInt(town.data.genesis_time_ns) + 120000000000n
    ).toString(),
  };
  const p = envelope(
    "rex",
    { type: "adjust_price", item_id: "crystal", unit_price: "5" },
    tickId,
    town.market_revision,
  );
  const result = resolveTownProposal(
    p,
    input,
    tickId,
    "rex",
    f.policy,
    identity,
    c,
  );
  assert.equal(result.call.method, "set_listing");
  assert.equal(
    result.call.args.quantity,
    input.merchants[0].listings[0].remaining_quantity,
  );
  assert.equal(result.call.args.shop_id, "1");
  assert.throws(
    () =>
      resolveTownProposal(
        { ...p, market_revision: "999" },
        input,
        tickId,
        "rex",
        f.policy,
        identity,
        c,
      ),
    /stale/,
  );
  assert.throws(
    () =>
      resolveTownProposal(
        { ...p, action: { ...p.action, unit_price: "3" } },
        input,
        tickId,
        "rex",
        f.policy,
        identity,
        c,
      ),
    /band/,
  );
  for (const a of [
    {
      type: "propose_trade",
      counterparty: "luna",
      side: "buy",
      item_id: "herb",
      quantity: "1",
      unit_price: "3",
    },
    { type: "accept_trade", offer_id: "1", expected_offer_revision: "1" },
    { type: "reject_trade", offer_id: "1" },
  ]) {
    const r = resolveTownProposal(
      envelope("rex", a, tickId, town.market_revision),
      input,
      tickId,
      "rex",
      f.policy,
      identity,
      c,
    );
    assert.equal(r.kind, "no_op");
    assert.equal(r.reason, "v2_trade_not_available");
    assert.equal(r.call, null);
  }
});

test("shared adapter runs capped sources and three merchant lanes before customer work without model inference", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const before = f.stats.send;
    assert.equal((await f.simulation.poll()).kind, "advanced");
    assert(f.stats.send - before <= 1);
  }
  await f.simulation.poll();
  assert.equal(f.stats.model, 0);
  assert.equal(f.stats.send, 10);
  const plan = f.store.ticks.actions(f.store.ticks.active().id);
  assert.equal(plan.length, 15);
  assert(plan.slice(0, 10).every((a) => a.state === "completed"));
  assert.equal(f.store.checkpoint("operator").last_action_id, "7");
  for (const lane of ["rex", "luna", "bolt"])
    assert.equal(f.store.checkpoint(lane).last_action_id, "1");
  assert.equal(f.state.jobs[0].owner.merchant_id, "bolt");
  assert.equal(f.state.jobs[0].status, "running");
});

test("source/merchant command high-waters hand off to the real customer processor in the same journal", async (t) => {
  const f = await fixture(t, { realCustomers: true });
  // Controlled already-funded current epoch and complete empty player market.
  f.state.town.data.customer_pool.last_funded_epoch = f.state.town.data.epoch;
  for (let i = 0; i < 14; i++)
    assert.equal((await f.simulation.poll()).kind, "advanced");
  assert.equal(f.store.ticks.active(), undefined);
  assert.equal(f.store.checkpoint("operator").last_action_id, "7");
  assert.equal(f.stats.send, 10);
  assert.equal(f.stats.model, 0);
  assert.equal((await f.simulation.poll()).kind, "idle");
});

test("invalid model actions become durable no-ops and cannot trigger a faucet, signature or repeat attempt", async (t) => {
  const f = await fixture(t, {
    propose: async (c) => ({
      ...envelope(
        c.merchant,
        { type: "allocate_raw_supply", item_id: "crystal" },
        c.tickId,
        c.facts.town.market_revision,
      ),
    }),
  });
  allocated(f);
  for (let i = 0; i < 3; i++)
    assert.equal((await f.simulation.poll()).action.kind, "no_op");
  for (let i = 0; i < 3; i++) await f.simulation.poll();
  assert.equal(f.stats.model, 3);
  assert.equal(f.stats.sign, 0);
  assert.equal(f.stats.send, 0);
  for (const a of f.store.ticks
    .actions(f.store.ticks.active().id)
    .slice(0, 3)) {
    const row = f.store.get(a.action_id);
    assert.equal(row.job_status, "completed");
    assert.equal(row.method, null);
    assert.equal(
      JSON.parse(row.decision_json).reason,
      "invalid_or_unavailable_proposal",
    );
  }
});

test("late model proposals cannot sign after a confirmed market revision changes", async (t) => {
  let fixtureRef;
  const f = await fixture(t, {
    propose: async (c) => {
      const p = envelope(
        c.merchant,
        { type: "adjust_price", item_id: "crystal", unit_price: "5" },
        c.tickId,
        c.facts.town.market_revision,
      );
      fixtureRef.state.town.market_revision =
        fixtureRef.state.town.event_sequence = (
          BigInt(fixtureRef.state.town.market_revision) + 1n
        ).toString();
      return p;
    },
  });
  fixtureRef = f;
  allocated(f);
  const r = await f.simulation.poll();
  assert.equal(r.action.kind, "no_op");
  assert.equal(f.stats.sign, 0);
  assert.equal(f.stats.model, 1);
});

test("unknown runtime source broadcasts fence all lanes across restart and pruned command lookup", async (t) => {
  const f = await fixture(t);
  f.mode("timeout_before");
  const first = await f.simulation.poll(),
    row = f.store.get(first.action.actionId);
  assert.equal(first.action.kind, "unknown");
  f.save();
  f.close();
  const reopened = await adapterFixture(f.dir);
  t.after(() => reopened.close());
  reopened.state.commands.operator.sequence = "9";
  reopened.state.commands.operator.effect = null;
  assert.equal((await reopened.simulation.poll()).kind, "blocked");
  assert.equal(reopened.store.get(row.id).signed_json, row.signed_json);
  assert.equal(reopened.stats.sign, 0);
  assert.equal(reopened.stats.send, 0);
  assert.throws(() => reopened.store.abandon(row.id), /broadcast/);
});

test("matching retained source checkpoints recover missing receipts without issuing twice or inventing a transaction", async (t) => {
  const f = await fixture(t);
  await f.simulation.poll();
  const row = f.store.unresolved()[0];
  f.state.hideReceipts = true;
  await f.simulation.poll();
  assert.equal(f.store.get(row.id).status, "confirmed");
  const evidence = f.store.get(row.id);
  assert.equal(evidence.tx_hash, row.tx_hash);
  assert.equal(f.stats.send, 2);
  assert.equal(f.state.commands.operator.sequence, "2");
});

test("finite merchant/source keys reject scope mixing before credential loading and signed bytes reject role substitution", async (t) => {
  const permission = (methods) => ({
    FunctionCall: {
      receiver_id: identity.deployment.contract_id,
      allowance: "10000000000000000000000",
      method_names: [...methods],
    },
  });
  assertRuntimePermission(
    permission(townMerchantMethods),
    identity.deployment.contract_id,
    "town_merchant",
  );
  assertRuntimePermission(
    permission(townSourceMethods),
    identity.deployment.contract_id,
    "town_source",
  );
  for (const scope of ["town_source", "town_merchant"])
    for (const wrong of [
      runtimeMethods,
      customerRuntimeMethods,
      [...townMerchantMethods, ...townSourceMethods],
    ])
      assert.throws(() =>
        assertRuntimePermission(
          permission(wrong),
          identity.deployment.contract_id,
          scope,
        ),
      );
  const f = await fixture(t);
  await f.simulation.poll();
  const row = f.store.unresolved()[0];
  assert.throws(() => readTownPrepared(row.signed_json, identity, "rex"));
  assert.throws(
    () =>
      townCall(
        "start_production",
        {
          shop_id: "4",
          recipe_id: "iron_tool",
          recipe_version: "1",
          quantity: "1",
          expected_shop_revision: "1",
          command: { sequence: "1", config_version: "1", valid_until_ns: "1" },
        },
        "bolt",
      ),
    /scope|shop/,
  );
});

test("known ready NPC completion uses the same journal but does not advance a business command or reward a caller", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 11; i++) await f.simulation.poll();
  const job = f.state.jobs[0],
    oldGold = f.state.town.data.npc_ledgers[2].gold.held;
  f.state.town.block_timestamp_ns = job.ready_at_ns;
  f.state.town.block_height = (
    BigInt(f.state.town.block_height) + 1n
  ).toString();
  f.state.town.data.epoch = f.state.town.data.customer_pool.epoch = (
    (BigInt(job.ready_at_ns) - BigInt(f.state.town.data.genesis_time_ns)) /
    60000000000n
  ).toString();
  allocated(f);
  for (let i = 0; i < 4; i++) await f.simulation.poll();
  assert.equal(f.state.jobs[0].status, "completed");
  assert.equal(f.store.checkpoint("bolt").last_action_id, "1");
  assert.equal(f.state.town.data.npc_ledgers[2].gold.held, oldGold);
});

test("mixed tick plans reject duplicate/reordered opportunities and bind source payloads to their original lane", async (t) => {
  const f = await fixture(t);
  await f.simulation.runtime.recover();
  const reader = await f.adapters.operator.client.finalized(),
    town = await reader.getTown(),
    checkpoint = { block: reader.block, codeHash: identity.codeHash, town };
  const id = "c".repeat(64);
  assert.throws(
    () =>
      f.store.ticks.prepare(checkpoint, 30000, [
        { id, arrival: "raw:crystal" },
        { id: "d".repeat(64), arrival: "raw:crystal" },
      ]),
    /plan/,
  );
  assert.throws(
    () =>
      f.store.ticks.prepare(checkpoint, 30000, [
        { id, arrival: "sweep:rex" },
        { id: "d".repeat(64), arrival: "raw:crystal" },
      ]),
    /plan/,
  );
  const tick = await f.scheduler.prepare(reader, [
    { id, arrival: "raw:crystal" },
  ]);
  assert.throws(
    () =>
      f.store.prepareTown(
        {
          id,
          tick: town.data.epoch,
          arrival: "raw:crystal",
          lane: "rex",
          decision: { kind: "no_op" },
          call: null,
          digest: null,
        },
        Date.now() + 30000,
      ),
    /lane/,
  );
  assert.equal(f.store.ticks.actions(tick.id)[0].state, "planned");
  assert.equal(f.store.get(id), undefined);
  const wrong = townCall(
    "allocate_raw_supply",
    {
      item_id: "wood",
      epoch: town.data.epoch,
      command: {
        sequence: "1",
        config_version: "1",
        valid_until_ns: (
          BigInt(town.block_timestamp_ns) + 1000000000n
        ).toString(),
      },
    },
    "operator",
  );
  assert.throws(
    () =>
      f.store.prepareTown(
        {
          id,
          tick: town.data.epoch,
          arrival: "raw:crystal",
          lane: "operator",
          decision: { kind: "raw", item: "wood" },
          call: wrong,
          digest: "a".repeat(64),
        },
        Date.now() + 30000,
      ),
    /source item/,
  );
  assert.equal(f.store.ticks.actions(tick.id)[0].state, "planned");
  assert.equal(f.store.get(id), undefined);
  assert.equal(f.store.unresolved().length, 0);
});

for (const point of [
  "before_sign",
  "after_signed",
  "after_unknown",
  "after_network",
])
  test(`runtime adapter survives actual process death at ${point} with original action identity`, async (t) => {
    const dir = directory(t),
      script = `import {adapterFixture} from './apps/worker/test/fixtures/living-town-adapter.mjs';const f=await adapterFixture(${JSON.stringify(dir)},{crashAt:${JSON.stringify(point)}});await f.simulation.poll();process.exit(99);`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30000 },
    );
    assert.notEqual(child.status, 99, child.stderr);
    assert.notEqual(child.status, 0, child.stderr);
    const f = await adapterFixture(dir);
    t.after(() => f.close());
    const old = f.store.unresolved()[0];
    assert(old);
    const r = await f.simulation.poll();
    assert.equal(f.store.get(old.id).args_json, old.args_json);
    if (old.signed_json)
      assert.equal(f.store.get(old.id).signed_json, old.signed_json);
    if (point === "after_unknown") {
      assert.equal(r.kind, "blocked");
      assert.equal(f.stats.send, 0);
      assert.equal(f.stats.sign, 0);
    } else if (point === "after_network") {
      assert.equal(f.store.get(old.id).status, "confirmed");
      assert(f.stats.send <= 1);
    } else {
      assert.equal(r.action.actionId, old.id);
      assert.equal(f.stats.send, 1);
      assert.equal(f.stats.sign, point === "before_sign" ? 1 : 0);
    }
  });
