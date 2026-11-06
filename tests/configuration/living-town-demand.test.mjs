import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { LivingTownCustomerDemand } from "../../apps/worker/dist/private/living-town/customers.js";
import { createLivingTownCall } from "../../packages/chain/dist/index.js";

const config = JSON.parse(readFileSync("config/living-town-v1.json", "utf8"));
const captured = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-customers-sandbox.json",
    "utf8",
  ),
);
const demand = new LivingTownCustomerDemand(config);
const clone = (v) => structuredClone(v);
// Controlled candidate rows around actual finalized pre-sale shop/ledger captures.
// These listing/history rows are policy inputs, not additional captured RPC evidence.
function candidate(source = captured.before, i = 0) {
  const row = source.shops[i],
    item = i === 0 ? "health_potion" : "iron_tool";
  return {
    shop: clone(row.shop),
    ledger: clone(row.ledger),
    listing: {
      listing_id: String(5 + i),
      shop_id: row.shop.data.shop_id,
      owner: clone(row.shop.data.owner),
      item_id: item,
      remaining_quantity: row.ledger.data.inventory.listing_reserved[item],
      unit_price: i === 0 ? "18" : "24",
      revision: i === 0 ? "2" : "1",
      active: row.ledger.data.inventory.listing_reserved[item] !== "0",
    },
    lastSaleEventSequence: null,
  };
}
function input(item = "health_potion", source = captured.before) {
  const town = clone(source.town),
    seed = "42",
    tick = town.data.epoch;
  return {
    town,
    seed,
    tick,
    arrivalIndex: demand
      .arrivals(town, seed, tick)
      .find((a) => a.itemId === item).arrivalIndex,
    fresh: true,
    marketComplete: true,
    historyComplete: true,
    candidates: [candidate(source, 0), candidate(source, 1)],
  };
}
function competitor(base, shopId, listingId, price = "18", last = null) {
  const row = clone(base),
    account = `shop${shopId}.testnet`;
  row.shop.data.shop_id = shopId;
  row.shop.data.owner.account_id = account;
  row.ledger.data.actor.account_id = account;
  Object.assign(row.listing, {
    shop_id: shopId,
    listing_id: listingId,
    unit_price: price,
  });
  row.listing.owner.account_id = account;
  row.lastSaleEventSequence = last;
  return row;
}

test("customer arrivals have stable seed/deployment/epoch identities, bounded product quotas and no wall-clock randomness", () => {
  const i = input(),
    before = JSON.stringify(i);
  const a = demand.arrivals(i.town, i.seed, i.tick);
  assert.deepEqual(demand.arrivals(clone(i.town), i.seed, i.tick), a);
  assert.equal(a.length, 4);
  for (const item of ["health_potion", "iron_tool"])
    assert.equal(a.filter((r) => r.itemId === item).length, 2);
  assert.equal(new Set(a.map((r) => r.customerId)).size, 4);
  const b = demand.arrivals(i.town, "43", i.tick);
  assert(a.every((r, n) => r.customerId !== b[n].customerId));
  const remote = clone(i.town);
  remote.deployment.contract_id = "other.testnet";
  assert.notEqual(
    demand.arrivals(remote, i.seed, i.tick)[0].customerId,
    a[0].customerId,
  );
  const later = clone(i.town);
  later.block_timestamp_ns = (
    BigInt(later.block_timestamp_ns) + 60_000_000_000n
  ).toString();
  later.data.epoch = later.data.customer_pool.epoch = (
    BigInt(i.tick) + 1n
  ).toString();
  assert.notEqual(
    demand.arrivals(later, i.seed, later.data.epoch)[0].customerId,
    a[0].customerId,
  );
  assert.equal(JSON.stringify(i), before);
});

test("actual pre-sale ledgers yield exact narrow one-unit customer call terms without allocating gold", () => {
  for (const item of ["health_potion", "iron_tool"]) {
    const i = input(item),
      before = JSON.stringify(i);
    const result = demand.select(i);
    assert.equal(result.kind, "purchase");
    assert.equal(result.itemId, item);
    assert.deepEqual(result.terms, {
      listing_id: item === "health_potion" ? "5" : "6",
      expected_listing_revision: item === "health_potion" ? "2" : "1",
      epoch: i.tick,
      max_total_price: item === "health_potion" ? "18" : "24",
    });
    assert.doesNotThrow(() =>
      createLivingTownCall("settle_customer_purchase", {
        ...result.terms,
        command: captured.steps[0].args.command,
      }),
    );
    assert.equal(JSON.stringify(i), before);
    assert.deepEqual(demand.select(i), result);
  }
});

test("selection uses price first, never-sold then oldest confirmed sale, numeric shop ID and input-order independence", () => {
  const i = input(),
    original = i.candidates[0];
  i.candidates = [
    competitor(original, "10", "20", "17", "16"),
    competitor(original, "9", "19", "18", null),
    competitor(original, "4", "5", "18", "1"),
  ];
  assert.equal(
    demand.select(i).shopId,
    "10",
    "cheaper wins despite recent sale",
  );
  i.candidates[0].listing.unit_price = "18";
  assert.equal(demand.select(i).shopId, "9", "never sold ranks oldest");
  i.candidates[1].lastSaleEventSequence = "2";
  assert.equal(demand.select(i).shopId, "4", "oldest confirmed sale wins");
  for (const row of i.candidates) row.lastSaleEventSequence = null;
  const expected = demand.select(i);
  assert.equal(expected.shopId, "4", "numeric IDs, not lexical order");
  assert.deepEqual(
    demand.select({ ...i, candidates: [...i.candidates].reverse() }),
    expected,
  );
  i.candidates[2].lastSaleEventSequence = "16";
  assert.equal(
    demand.select(i).shopId,
    "9",
    "confirmation advances service order",
  );
});

test("no-sale decisions explain overpricing, depletion, missing demand, insufficient budget and seller inbound headroom", () => {
  const i = input();
  i.candidates = [i.candidates[0]];
  i.candidates[0].listing.unit_price = "19";
  assert.equal(demand.select(i).reason, "above_willingness_to_pay");
  i.candidates[0].listing.unit_price = "18";
  i.town.data.customer_pool.gold = "17";
  assert.equal(demand.select(i).reason, "insufficient_budget");
  i.town.data.customer_pool.gold = "100";
  const gold = i.candidates[0].ledger.data.gold;
  Object.assign(gold, {
    held: "999980",
    available: "999980",
    trade_inbound_reserved: "3",
  });
  assert.equal(demand.select(i).reason, "seller_capacity");
  gold.trade_inbound_reserved = "2";
  assert.equal(demand.select(i).kind, "purchase", "exact headroom is eligible");
  const listing = i.candidates[0].listing,
    inv = i.candidates[0].ledger.data.inventory;
  listing.remaining_quantity = "0";
  listing.active = false;
  inv.available.health_potion = "3";
  inv.listing_reserved.health_potion = "0";
  assert.equal(demand.select(i).reason, "no_stock");
  assert.equal(demand.select({ ...i, candidates: [] }).reason, "no_stock");
});

test("global confirmed quotas and budget survive epoch rollover without a planner-generated top-up", () => {
  const quota = input("health_potion", captured.after_quota);
  assert.equal(demand.select(quota).reason, "quota_exhausted");
  const rollover = input("health_potion", captured.rollover);
  assert.equal(demand.select(rollover).reason, "insufficient_budget");
  assert.equal(rollover.town.data.customer_pool.gold, "16");
  const next = input("iron_tool", captured.after_sale);
  assert.equal(demand.select(next).kind, "purchase");
  assert.equal(next.town.data.customer_pool.gold, "98");
  assert.equal(
    demand.select(input("health_potion", captured.after_sale)).reason,
    "no_stock",
  );
});

test("unavailable history, partial markets, paused and stale snapshots defer without inventing sales", () => {
  for (const [field, reason] of [
    ["fresh", "stale_snapshot"],
    ["marketComplete", "market_incomplete"],
    ["historyComplete", "history_unavailable"],
  ]) {
    const i = input();
    i[field] = false;
    const result = demand.select(i);
    assert.equal(result.kind, "no_purchase");
    assert.equal(result.reason, reason);
    assert.equal(result.terms, undefined);
  }
  const i = input();
  i.town.data.paused = true;
  assert.equal(demand.select(i).reason, "paused");
});

test("invalid config, ticks, mixed checkpoints, duplicate rows and fabricated stock/history reject", () => {
  for (const mutate of [
    (i) => (i.tick = "0"),
    (i) => (i.seed = "01"),
    (i) => (i.seed = 42),
    (i) => (i.arrivalIndex = "4"),
    (i) => (i.tick = "18446744073709551616"),
    (i) => (i.town.deployment.config_sha256 = "0".repeat(64)),
    (i) => (i.town.data.customer_pool.epoch = "0"),
    (i) => (i.candidates[0].ledger.block_height = "0"),
    (i) => (i.candidates[0].shop.deployment.contract_id = "other.testnet"),
    (i) => i.candidates.push(clone(i.candidates[0])),
    (i) => (i.candidates[0].lastSaleEventSequence = "0"),
    (i) => (i.candidates[0].lastSaleEventSequence = "999"),
    (i) => (i.candidates[0].listing.remaining_quantity = "2"),
    (i) => (i.candidates[0].listing.owner.account_id = "spoof.testnet"),
    (i) => (i.candidates = Array(2001).fill(i.candidates[0])),
  ]) {
    const i = input();
    mutate(i);
    assert.throws(() => demand.select(i));
  }
  const wrong = clone(config);
  wrong.economy.recipes.iron_tool.salePrice = "25";
  assert.throws(() => new LivingTownCustomerDemand(wrong));
  const changed = clone(config);
  changed.economy.starterGold = "101";
  assert.throws(() => new LivingTownCustomerDemand(changed).select(input()));
});

test("equal-price shops alternate only after confirmed fulfillment; repeated proposals never advance fairness", () => {
  const i = input(),
    row = i.candidates[0];
  i.candidates = [competitor(row, "4", "5"), competitor(row, "5", "6")];
  const counts = { 4: 0, 5: 0 };
  for (let n = 1; n <= 100; n++) {
    const result = demand.select(i);
    assert.deepEqual(demand.select(i), result);
    counts[result.shopId]++;
    // Explicit controlled confirmation/history advancement, not a live chain sale.
    i.town.market_revision = i.town.event_sequence = String(16 + n);
    for (const c of i.candidates) {
      c.shop.market_revision = c.shop.event_sequence = String(16 + n);
      c.ledger.market_revision = c.ledger.event_sequence = String(16 + n);
      if (c.listing.shop_id === result.shopId)
        c.lastSaleEventSequence = String(16 + n);
    }
  }
  assert.deepEqual(counts, { 4: 50, 5: 50 });
});
