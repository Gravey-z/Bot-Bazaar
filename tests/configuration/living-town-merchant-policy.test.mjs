import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalLivingTownJson } from "../../packages/chain/dist/index.js";
import {
  LivingTownMerchantPolicy,
  collectMerchantPolicyInput,
} from "../../apps/worker/dist/private/living-town/merchant-policy.js";
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const config = read("config/living-town-v1.json"),
  capture = read("tests/fixtures/chain/living-town-races-sandbox.json");
// Controlled snapshots are rebound to the fresh demo configuration; archived files stay untouched.
function rebind(v) {
  if (!v || typeof v !== "object") return;
  if (v.deployment)
    v.deployment.config_sha256 = createHash("sha256")
      .update(canonicalLivingTownJson(config))
      .digest("hex");
  for (const child of Object.values(v)) rebind(child);
}
rebind(capture);
const policy = new LivingTownMerchantPolicy(config),
  names = ["rex", "luna", "bolt"],
  raw = ["crystal", "wood", "herb", "iron"];
const f = capture.setup[0].foundation;
const identity = {
  deployment: f.deployment,
  codeHash: capture.setup[0].account.code_hash,
  ownerId: f.data.owner_account_id,
  operatorId: f.data.operator_account_id,
  controllers: f.data.merchant_controllers,
};
// Controlled complete NPC shop/listing pages around actual captured town/ledger facts.
function input(sourceTown = capture.stages[0].before.town) {
  const town = structuredClone(sourceTown);
  const merchants = names.map((name, index) => ({
    shop: {
      ...structuredClone(town),
      data: {
        shop_id: String(index + 1),
        owner: { kind: "merchant", merchant_id: name },
        name,
        revision: "1",
        production_slots: "1",
        policy_revision: "1",
        created_at_ns: town.data.genesis_time_ns,
        ownership_command_sequence: null,
      },
    },
    listings: raw
      .filter((item) => config.economy.materials[item].supplier === name)
      .map((item) => {
        const q = town.data.npc_ledgers[index].inventory.listing_reserved[item];
        return {
          listing_id: String(raw.indexOf(item) + 1),
          shop_id: String(index + 1),
          owner: { kind: "merchant", merchant_id: name },
          item_id: item,
          remaining_quantity: q,
          unit_price: config.economy.materials[item].price,
          revision: "1",
          active: q !== "0",
        };
      }),
    job: null,
  }));
  return { town, merchants, trades: [], fresh: true, historyComplete: true };
}
function ledger(i, name) {
  return i.town.data.npc_ledgers[names.indexOf(name)];
}
function stock(i, name, item, held, listed, trade = "0") {
  const inv = ledger(i, name).inventory;
  inv.held[item] = String(held);
  inv.listing_reserved[item] = String(listed);
  inv.trade_reserved[item] = String(trade);
  inv.available[item] = String(BigInt(held) - BigInt(listed) - BigInt(trade));
  const listing = i.merchants[names.indexOf(name)].listings.find(
    (l) => l.item_id === item,
  );
  if (listing) {
    listing.remaining_quantity = String(listed);
    listing.active = String(listed) !== "0";
  }
}
const action = (i, name) =>
  policy.evaluate(i).decisions.find((d) => d.merchant === name).action;
const command = (i) => ({
  sequence: "1",
  config_version: "1",
  valid_until_ns: (
    BigInt(i.town.data.genesis_time_ns) +
    (BigInt(i.town.data.epoch) + 1n) * 60000000000n
  ).toString(),
});

test("V2 policy is pure, deterministic and stable across merchant/listing/history enumeration", () => {
  const i = input(),
    before = structuredClone(i),
    result = policy.evaluate(i);
  assert.deepEqual(i, before);
  i.merchants.reverse();
  for (const r of i.merchants) r.listings.reverse();
  assert.deepEqual(policy.evaluate(i), result);
  assert.deepEqual(
    result.decisions.map((d) => d.merchant),
    names,
  );
  assert.equal(result.policy, "living-town-merchants-v1");
  assert.equal(result.scarcity.find((s) => s.item === "herb").floor, "4");
});

test("Rex scarcity aggression and price floor, Luna reserve and bounded prices follow V2 profiles", () => {
  const i = input();
  assert.equal(action(i, "rex").price, "4");
  stock(i, "rex", "crystal", 4, 2);
  assert.equal(action(i, "rex").price, "6");
  assert.equal(policy.evaluate(i).scarcity[0].scarcityBps, "8000");
  stock(i, "luna", "herb", 6, 2);
  const luna = action(i, "luna");
  assert.equal(luna.quantity, "2");
  assert.equal(luna.price, "4");
  stock(i, "luna", "herb", 4, 0);
  assert.equal(action(i, "luna").quantity, "0");
});

test("confirmed demand windows deduplicate original trades and reject conflicts, future events and oversized history", () => {
  const i = input(),
    trade = structuredClone(
      capture.stages
        .find((s) => s.name === "last_raw_unit")
        .calls.find((c) => c.succeeded).effect.data.outcome.trade,
    );
  // Controlled historic trade at this checkpoint, not an extra transaction.
  trade.settled_at_ns = i.town.block_timestamp_ns;
  trade.event_sequence = i.town.event_sequence;
  i.trades = [trade, structuredClone(trade)];
  assert.equal(policy.evaluate(i).volume.crystal, "1");
  i.trades[1].unit_price = i.trades[1].total_price = "5";
  assert.throws(() => policy.evaluate(i), /conflicting|price/);
  i.trades = [
    {
      ...trade,
      event_sequence: (BigInt(i.town.event_sequence) + 1n).toString(),
    },
  ];
  assert.throws(() => policy.evaluate(i), /future/);
  i.trades = Array(2001).fill(trade);
  assert.throws(() => policy.evaluate(i), /bounded/);
});

test("demand expires outside five current epochs and future timestamps never count", () => {
  const i = input(),
    trade = structuredClone(
      capture.stages[0].calls.find((c) => c.succeeded).effect.data.outcome
        .trade,
    );
  i.trades = [trade];
  i.town.block_timestamp_ns = (
    BigInt(trade.settled_at_ns) + 360000000000n
  ).toString();
  i.town.data.epoch = (
    (BigInt(i.town.block_timestamp_ns) - BigInt(i.town.data.genesis_time_ns)) /
    60000000000n
  ).toString();
  i.town.data.customer_pool.epoch = i.town.data.epoch;
  for (const r of i.merchants)
    r.shop.block_timestamp_ns = i.town.block_timestamp_ns;
  trade.event_sequence = i.town.event_sequence;
  assert.equal(policy.evaluate(i).volume.crystal, "0");
  trade.settled_at_ns = (BigInt(i.town.block_timestamp_ns) + 1n).toString();
  assert.throws(() => policy.evaluate(i), /future/);
});

test("Bolt releases only necessary listed inputs then uses the ordinary NPC production command", () => {
  const i = input();
  stock(i, "bolt", "wood", 8, 8);
  stock(i, "bolt", "iron", 20, 16);
  const release = action(i, "bolt");
  assert.equal(release.kind, "set_listing");
  assert.equal(release.reason, "release_inputs_before_crafting");
  assert.equal(release.item, "wood");
  assert.equal(release.quantity, "6");
  stock(i, "bolt", "wood", 8, 6);
  const craft = action(i, "bolt");
  assert.equal(craft.kind, "start_production");
  assert.equal(craft.quantity, "1");
  const compiled = policy.compile(i, "bolt", craft, identity, command(i));
  assert.equal(compiled.signer, identity.controllers.bolt);
  assert.equal(compiled.call.method, "start_production");
  assert.equal(compiled.call.args.shop_id, "3");
  assert.equal(compiled.call.args.recipe_id, "iron_tool");
  assert.equal(compiled.call.args.recipe_version, "1");
  assert.notEqual(compiled.signer, identity.operatorId);
});

test("Bolt waits for floors, reserved inputs, gold/capacity and bounded product target without minting", () => {
  const i = input();
  stock(i, "bolt", "wood", 2, 0);
  assert.equal(action(i, "bolt").reason, "supplier_allocation_required");
  stock(i, "bolt", "wood", 10, 0, "9");
  assert.equal(action(i, "bolt").reason, "supplier_allocation_required");
  stock(i, "bolt", "wood", 10, 7);
  ledger(i, "bolt").gold.held = ledger(i, "bolt").gold.available = "59";
  assert.equal(action(i, "bolt").reason, "gold_reserve");
  ledger(i, "bolt").gold.held = ledger(i, "bolt").gold.available = "200";
  ledger(i, "bolt").inventory.trade_inbound_reserved.iron_tool = "1000";
  assert.equal(action(i, "bolt").reason, "output_capacity");
  ledger(i, "bolt").inventory.trade_inbound_reserved.iron_tool = "0";
  stock(i, "bolt", "iron_tool", 1, 0);
  assert.notEqual(action(i, "bolt").kind, "start_production");
});

test("running NPC jobs occupy their slot and known readiness compiles permissionless completion", () => {
  const stage = capture.stages.find((s) => s.name === "craft_versus_reserve");
  const i = input(stage.after.town);
  const actual = stage.calls.find((c) => c.method === "start_production").effect
    ?.data.outcome.job;
  // Race winners vary. If reserve won, use an explicit controlled job rather than claiming another receipt.
  const job = structuredClone(
    actual ?? {
      recipe_id: "iron_tool",
      recipe_version: "1",
      config_version: "1",
      quantity: "3",
      inputs_consumed: {
        crystal: "0",
        wood: "3",
        herb: "0",
        iron: "6",
        health_potion: "0",
        iron_tool: "0",
      },
      output_item: "iron_tool",
      output_quantity: "3",
      start_at_ns: i.town.block_timestamp_ns,
      ready_at_ns: (
        BigInt(i.town.block_timestamp_ns) + 540000000000n
      ).toString(),
      job_id: "1",
      shop_id: "3",
      owner: { kind: "merchant", merchant_id: "bolt" },
      completed_at_ns: null,
      status: "running",
      start_command_sequence: "3",
      revision: "1",
    },
  );
  i.merchants[2].job = job;
  const inv = ledger(i, "bolt").inventory;
  inv.production_output_reserved.iron_tool = job.output_quantity;
  assert.equal(action(i, "bolt").reason, "production_running");
  i.town.block_timestamp_ns = job.ready_at_ns;
  i.town.data.epoch = (
    (BigInt(job.ready_at_ns) - BigInt(i.town.data.genesis_time_ns)) /
    60000000000n
  ).toString();
  i.town.data.customer_pool.epoch = i.town.data.epoch;
  for (const r of i.merchants) r.shop.block_timestamp_ns = job.ready_at_ns;
  i.town.data.paused = true;
  const complete = action(i, "bolt");
  assert.equal(complete.kind, "complete_production");
  const c = policy.compile(i, "bolt", complete, identity, null);
  assert.equal(c.call.method, "complete_production");
  assert.deepEqual(c.call.args, { job_id: job.job_id });
});

test("stale/incomplete/pause waits are explicit and forged merchant state fails closed", () => {
  const i = input();
  i.historyComplete = false;
  assert(
    policy
      .evaluate(i)
      .decisions.every(
        (d) => d.action.reason === "confirmed_facts_unavailable",
      ),
  );
  assert.equal(policy.evaluate(i).scarcity[0].confirmedDemand, null);
  assert.equal(policy.evaluate(i).scarcity[0].suggestedPrice, null);
  i.historyComplete = true;
  i.town.data.paused = true;
  assert(
    policy.evaluate(i).decisions.every((d) => d.action.reason === "paused"),
  );
  i.merchants[0].shop.data.owner = {
    kind: "player",
    account_id: identity.operatorId,
  };
  assert.throws(() => policy.evaluate(i), /merchant|owner|shop/i);
  assert.throws(
    () =>
      new LivingTownMerchantPolicy({
        ...config,
        economy: {
          ...config.economy,
          materials: {
            ...config.economy.materials,
            herb: { ...config.economy.materials.herb, floor: "0" },
          },
        },
      }),
    /unreviewed/,
  );
});

test("compiler rejects stale/altered steps, commands and operator/controller substitution", () => {
  const i = input(),
    plan = action(i, "rex");
  assert.throws(
    () =>
      policy.compile(
        i,
        "rex",
        { ...plan, quantity: "100" },
        identity,
        command(i),
      ),
    /altered/,
  );
  const wrong = structuredClone(identity);
  wrong.controllers.rex = wrong.operatorId;
  assert.throws(
    () => policy.compile(i, "rex", plan, wrong, command(i)),
    /independent/,
  );
  assert.throws(
    () =>
      policy.compile(i, "rex", plan, identity, {
        ...command(i),
        valid_until_ns: i.town.block_timestamp_ns,
      }),
    /epoch/,
  );
  i.merchants[0].listings[0].revision = "2";
  assert.throws(
    () => policy.compile(i, "rex", plan, identity, command(i)),
    /stale|altered/,
  );
});

test("bounded collector pins NPC listings/jobs to one reader and rejects incomplete scans", async () => {
  const i = input(),
    calls = [];
  const reader = {
    getTown: async () => i.town,
    getShop: async (id) => i.merchants[Number(id) - 1].shop,
    getListings: async (args) => {
      calls.push(args);
      return {
        data: {
          items: i.merchants[Number(args.shop_id) - 1].listings,
          has_more: false,
        },
      };
    },
    getProductionJobs: async (args) => {
      calls.push(args);
      return { data: { items: [], has_more: false } };
    },
  };
  const collected = await collectMerchantPolicyInput(reader, [], true);
  assert.deepEqual(policy.evaluate(collected), policy.evaluate(i));
  assert(
    calls.every(
      (c) =>
        c.expected_market_revision === i.town.market_revision &&
        c.limit === "50",
    ),
  );
  reader.getListings = async () => ({ data: { items: [], has_more: true } });
  await assert.rejects(
    collectMerchantPolicyInput(reader, [], true),
    /incomplete/,
  );
});

test("bounded backups buy existing primary stock only with capability, surplus and operating gold", () => {
  const i = input();
  stock(i, "luna", "herb", 20, 4);
  assert.notEqual(action(i, "luna").kind, "merchant_purchase");
  i.merchantTrading = true;
  const plan = action(i, "luna");
  assert.equal(plan.kind, "merchant_purchase");
  assert.equal(plan.reason, "build_bounded_backup");
  assert.equal(plan.seller, "rex");
  assert.equal(plan.item, "crystal");
  assert.equal(plan.quantity, "1");
  const compiled = policy.compile(i, "luna", plan, identity, command(i));
  assert.equal(compiled.call.method, "merchant_purchase");
  assert.equal(compiled.call.args.buyer_merchant_id, "luna");
  assert.equal(compiled.call.args.merchant_id, "rex");
  assert.equal(compiled.call.deposit, "0");
  stock(i, "luna", "crystal", 2, 0);
  assert.notEqual(action(i, "luna").item, "crystal");
  ledger(i, "luna").gold.held = ledger(i, "luna").gold.available = "120";
  assert.notEqual(action(i, "luna").kind, "merchant_purchase");
});

test("backup holders offer actual reserves during shortages and the primary supplier buys them back", () => {
  const i = input();
  i.merchantTrading = true;
  stock(i, "rex", "crystal", 4, 2);
  stock(i, "luna", "crystal", 2, 0);
  const offer = action(i, "luna");
  assert.equal(offer.kind, "set_listing");
  assert.equal(offer.reason, "offer_emergency_backup");
  assert.equal(offer.quantity, "2");
  assert.equal(offer.expectedRevision, null);
  i.merchants[1].listings.push({
    listing_id: "20",
    shop_id: "2",
    owner: { kind: "merchant", merchant_id: "luna" },
    item_id: "crystal",
    remaining_quantity: "2",
    unit_price: offer.price,
    revision: "1",
    active: true,
  });
  stock(i, "luna", "crystal", 2, 2);
  const buyback = action(i, "rex");
  assert.equal(buyback.reason, "emergency_peer_restock");
  assert.equal(buyback.seller, "luna");
  assert.equal(buyback.quantity, "2");
  const c = policy.compile(i, "rex", buyback, identity, command(i));
  assert.equal(c.call.args.buyer_merchant_id, "rex");
  stock(i, "rex", "crystal", 10, 4);
  assert.equal(action(i, "luna").reason, "protect_backup_stock");
  assert.equal(action(i, "luna").quantity, "0");
  for (const block of [
    (s) => {
      s.fresh = false;
    },
    (s) => {
      s.historyComplete = false;
    },
    (s) => {
      s.town.data.paused = true;
    },
  ]) {
    const disabled = structuredClone(i);
    block(disabled);
    assert.equal(action(disabled, "luna").kind, "wait");
  }
});
