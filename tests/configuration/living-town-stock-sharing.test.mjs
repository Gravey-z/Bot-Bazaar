import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LivingTownMerchantPolicy } from "../../apps/worker/dist/private/living-town/merchant-policy.js";
import {
  canonicalLivingTownJson,
  offerMaterialRules,
  livingTownTradingRules,
  parseLivingTownDeployment,
  planLivingTownProduction,
  livingTownRecipe,
} from "../../packages/chain/dist/index.js";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const cfg = read("config/living-town-v1.json");
const fixture = read("tests/fixtures/economy/distributed-merchant-stock.json");
const capture = read(
  "tests/fixtures/chain/living-town-merchant-offers-sandbox.json",
);
const policy = new LivingTownMerchantPolicy(cfg);
const names = ["rex", "luna", "bolt"],
  items = ["crystal", "wood", "herb", "iron"];
const digest = createHash("sha256")
  .update(canonicalLivingTownJson(cfg))
  .digest("hex");
function held(input, merchant, item, quantity, listed = 0, incoming = 0) {
  const inv = input.town.data.npc_ledgers[names.indexOf(merchant)].inventory;
  for (const [key, value] of Object.entries({
    held: quantity,
    available: quantity - listed,
    listing_reserved: listed,
    trade_reserved: 0,
    trade_inbound_reserved: incoming,
    production_output_reserved: 0,
  }))
    inv[key][item] = String(value);
  const listing = input.merchants?.[names.indexOf(merchant)]?.listings.find(
    (l) => l.item_id === item,
  );
  if (listing) {
    listing.remaining_quantity = String(listed);
    listing.active = listed > 0;
  }
}
function bind(input) {
  input.merchants.forEach((r) => {
    const data = r.shop.data;
    r.shop = { ...structuredClone(input.town), data };
  });
  return input;
}
function input() {
  const town = structuredClone(capture.low);
  town.deployment.config_version = "1";
  town.deployment.config_sha256 = digest;
  town.data.next_offer_id = "1";
  town.data.next_trade_id = "1";
  town.data.totals.seed_items = {
    crystal: "23",
    wood: "23",
    herb: "23",
    iron: "23",
    health_potion: "0",
    iron_tool: "0",
  };
  const result = {
    town,
    merchants: [],
    trades: [],
    pendingOffers: [],
    negotiatedTrading: true,
    fresh: true,
    historyComplete: true,
    stockSharingReaction: {
      id: "a".repeat(64),
      usedMerchants: [],
      followUpOnly: false,
    },
  };
  names.forEach((m, index) => {
    const ledger = town.data.npc_ledgers[index];
    ledger.revision = "1";
    ledger.gold = {
      held: "200",
      available: "200",
      trade_reserved: "0",
      trade_inbound_reserved: "0",
    };
    cfg.items.forEach((item) =>
      held(
        result,
        m,
        item,
        Number(fixture.initial[m][item] ?? 0),
        cfg.economy.materials[item]?.supplier === m
          ? Number(cfg.economy.materials[item].listed)
          : 0,
      ),
    );
  });
  result.merchants = names.map((m, index) => ({
    shop: {
      ...structuredClone(town),
      data: structuredClone(town.data.npc_shops[index]),
    },
    job: null,
    listings: items
      .filter((item) => cfg.economy.materials[item].supplier === m)
      .map((item) => ({
        listing_id: String(items.indexOf(item) + 1),
        shop_id: String(index + 1),
        owner: { kind: "merchant", merchant_id: m },
        item_id: item,
        remaining_quantity: cfg.economy.materials[item].listed,
        unit_price: cfg.economy.materials[item].price,
        revision: "1",
        active: true,
      })),
  }));
  return bind(result);
}
const plan = (i) => policy.evaluate(bind(i)).stockSharing;
const candidates = (p, b, item) =>
  p.candidates.filter((c) => c.buyer === b && c.item === item);
function command(i) {
  return {
    sequence: "1",
    config_version: i.town.deployment.config_version,
    valid_until_ns: String(BigInt(i.town.block_timestamp_ns) + 500000000000n),
  };
}
const identity = (i) => ({
  ...capture.foundation.data,
  deployment: i.town.deployment,
  codeHash: capture.steps[0].account.code_hash,
  ownerId: capture.foundation.data.owner_account_id,
  operatorId: capture.foundation.data.operator_account_id,
  controllers: capture.foundation.data.merchant_controllers,
});
function compile(i, c, q = "2", price = "5") {
  const id = identity(i);
  return policy.compileStockSharingProposal(
    bind(i),
    c.buyer,
    { candidateId: c.id, quantity: q, unitPrice: price },
    {
      deployment: id.deployment,
      codeHash: id.codeHash,
      ownerId: id.ownerId,
      operatorId: id.operatorId,
      controllers: id.controllers,
    },
    command(i),
  );
}

test("distributed seed totals 23 per material and exposes optional purchases without forcing a bootstrap", () => {
  const i = input();
  const before = structuredClone(i);
  const p = plan(i);
  for (const item of items) {
    assert.equal(
      names.reduce((n, m) => n + Number(fixture.initial[m][item]), 0),
      23,
    );
    assert.equal(
      i.merchants.flatMap((r) => r.listings).filter((l) => l.item_id === item)
        .length,
      1,
    );
  }
  assert.equal(p.candidates.length, 4);
  assert.equal(
    p.candidates.every((c) => c.kind === "backup_acquisition"),
    true,
  );
  assert.deepEqual(i, before);
  assert.equal(
    p.signals.every((s) => !s.lowStock && s.healthyForBackups),
    true,
  );
});
for (const item of items)
  test(`distributed ${item} shortage exposes both independent holders without bootstrap`, () => {
    const i = input(),
      rule = offerMaterialRules[item];
    held(i, rule.supplier, item, Number(rule.floor) + 2);
    const options = candidates(plan(i), rule.supplier, item);
    assert.equal(options.length, 2);
    assert.deepEqual(
      new Set(options.map((c) => c.seller)),
      new Set(names.filter((m) => m !== rule.supplier)),
    );
    for (const c of options) {
      assert.equal(c.quantityChoices.at(-1).quantity, "2");
      assert.equal(
        c.quantityChoices.every((q) => q.listingRelease === null),
        true,
      );
    }
  });
test("pre-owned crystal reserve compiles a buyer proposal and preserves all current holdings", () => {
  const i = input();
  held(i, "rex", "crystal", 4);
  const before = structuredClone(i);
  const c = candidates(plan(i), "rex", "crystal").find(
    (c) => c.seller === "luna",
  );
  const step = compile(i, c);
  assert.equal(step.signer, identity(i).controllers.rex);
  assert.equal(step.call.method, "propose_trade");
  assert.equal(step.call.args.command.config_version, "1");
  assert.equal(step.call.args.seller_merchant_id, "luna");
  assert.deepEqual(i, before);
  const wrong = command(i);
  wrong.config_version = "2";
  const id = identity(i);
  delete id.owner_account_id;
  delete id.operator_account_id;
  delete id.merchant_controllers;
  delete id.item_ids;
  delete id.supported_methods;
  assert.throws(() =>
    policy.compileStockSharingProposal(
      i,
      "rex",
      { candidateId: c.id, quantity: "2", unitPrice: "5" },
      {
        deployment: id.deployment,
        codeHash: id.codeHash,
        ownerId: id.ownerId,
        operatorId: id.operatorId,
        controllers: id.controllers,
      },
      wrong,
    ),
  );
});
test("peer retains two units and AI can consider buying at any holding below the seven-unit cap", () => {
  const i = input();
  held(i, "rex", "crystal", 4);
  held(i, "luna", "crystal", 2);
  held(i, "bolt", "crystal", 3);
  const c = candidates(plan(i), "rex", "crystal");
  assert.deepEqual(
    c.map((c) => c.seller),
    ["bolt"],
  );
  assert.deepEqual(
    c[0].quantityChoices.map((q) => q.quantity),
    ["1"],
  );
  held(i, "rex", "crystal", 12, 10);
  held(i, "luna", "crystal", 3);
  const topup = candidates(plan(i), "luna", "crystal")[0];
  assert.equal(topup.buyerHeadroom, "4");
  assert.equal(topup.quantityChoices.length, 2);
  held(i, "luna", "crystal", 4);
  assert.equal(candidates(plan(i), "luna", "crystal").length, 1);
  held(i, "luna", "crystal", 6);
  assert.equal(
    candidates(plan(i), "luna", "crystal")[0].quantityChoices.at(-1).quantity,
    "1",
  );
  held(i, "luna", "crystal", 7);
  assert.equal(candidates(plan(i), "luna", "crystal").length, 0);
});
test("refill invalidates a distributed candidate and middle-band stock avoids buyback loops", () => {
  const i = input();
  held(i, "rex", "crystal", 4);
  const c = candidates(plan(i), "rex", "crystal")[0];
  held(i, "rex", "crystal", 8);
  assert.equal(candidates(plan(i), "rex", "crystal").length, 0);
  assert.throws(() => compile(i, c));
});
test("distributed fixture conserves items and gold across retail sale and reserve trade", () => {
  for (const state of fixture.crystalScenario) {
    assert.equal(
      Object.values(state)
        .filter((v) => v && typeof v === "object")
        .reduce((n, v) => n + Number(v.crystal), 0),
      23,
    );
    assert.equal(
      Object.values(state)
        .filter((v) => v && typeof v === "object")
        .reduce((n, v) => n + Number(v.gold), 0),
      700,
    );
  }
});
test("fresh-deployment rules enforce the new cap and preserve existing recipe identifiers", () => {
  const rules = {
    schema: "merchant-offers-v1",
    items,
    quantity_cap: "2",
    backup_cap: "7",
    operating_gold: { rex: "80", luna: "120", bolt: "60" },
    max_pending_global: "12",
    max_pending_per_merchant: "8",
    terminal_retention: "128",
    min_offer_lifetime_seconds: "60",
    max_offer_lifetime_seconds: "600",
    materials: offerMaterialRules,
  };
  assert.equal(livingTownTradingRules(rules).backup_cap, "7");
  assert.throws(() => livingTownTradingRules({ ...rules, backup_cap: "2" }));
  assert.throws(() =>
    livingTownTradingRules({ ...rules, schema: "merchant-offers-v2" }),
  );
  const d = input().town.deployment;
  assert.equal(parseLivingTownDeployment(d).config_version, "1");
  assert.throws(() => parseLivingTownDeployment({ ...d, config_version: "2" }));
  const recipe = livingTownRecipe({
    recipe_id: "iron_tool",
    version: "1",
    inputs: {
      crystal: "0",
      wood: "1",
      herb: "0",
      iron: "2",
      health_potion: "0",
      iron_tool: "0",
    },
    output_item: "iron_tool",
    output_per_unit: "1",
    duration_seconds: "180",
    max_batch_quantity: "10",
  });
  assert.equal(
    planLivingTownProduction(recipe, "1", "1", "10").config_version,
    "1",
  );
});

function receiptOutcome(step) {
  const id = step.receipt.transaction_outcome.outcome.status.SuccessReceiptId;
  return JSON.parse(
    Buffer.from(
      step.receipt.receipts_outcome.find((r) => r.id === id).outcome.status
        .SuccessValue,
      "base64",
    ).toString(),
  ).data.outcome;
}
function gold(i, m, value) {
  const g = i.town.data.npc_ledgers[names.indexOf(m)].gold;
  g.held = g.available = String(value);
}

test("surplus separates listings from potential stock and requires an explicit seller release", () => {
  const i = input(),
    c = candidates(plan(i), "luna", "crystal")[0];
  assert.equal(c.availableSurplus, "0");
  assert.equal(c.potentialSurplus, "10");
  assert.equal(
    c.quantityChoices.find((q) => q.quantity === "2").listingRelease
      .maxRemainingQuantity,
    "8",
  );
  const before = structuredClone(i);
  compile(i, c, "2", "4");
  assert.deepEqual(i, before);
});
test("legal choices retain gold reserves, seller capacity, quantity limits and actor binding", () => {
  const i = input();
  gold(i, "luna", 127);
  let c = candidates(plan(i), "luna", "crystal")[0];
  assert.deepEqual(
    c.quantityChoices.map((q) => q.quantity),
    ["1"],
  );
  gold(i, "luna", 123);
  assert.equal(candidates(plan(i), "luna", "crystal").length, 0);
  gold(i, "luna", 200);
  gold(i, "rex", 999999);
  assert.equal(candidates(plan(i), "luna", "crystal").length, 0);
  gold(i, "rex", 200);
  c = candidates(plan(i), "luna", "crystal")[0];
  assert.throws(() => compile(i, c, "3", "4"));
  assert.throws(() => compile(i, c, "2", "7"));
  const id = identity(i);
  assert.throws(() =>
    policy.compileStockSharingProposal(
      i,
      "bolt",
      { candidateId: c.id, quantity: "2", unitPrice: "4" },
      {
        deployment: id.deployment,
        codeHash: id.codeHash,
        ownerId: id.ownerId,
        operatorId: id.operatorId,
        controllers: id.controllers,
      },
      command(i),
    ),
  );
});
test("stale, paused, partial-history and rootless previews cannot compile a proposal", () => {
  for (const alter of [
    (i) => {
      i.fresh = false;
    },
    (i) => {
      i.town.data.paused = true;
    },
    (i) => {
      i.historyComplete = false;
    },
    (i) => {
      delete i.stockSharingReaction;
    },
    (i) => {
      delete i.pendingOffers;
    },
  ]) {
    const i = input(),
      c = candidates(plan(i), "luna", "crystal")[0];
    alter(i);
    assert.equal(plan(i).executionReady, false);
    assert.throws(() => compile(i, c, "2", "4"));
  }
});
test("root participant locks and follow-up prevent repeated negotiations; idle candidate IDs stay stable", () => {
  const i = input(),
    p = plan(i);
  i.town.block_height = String(BigInt(i.town.block_height) + 1n);
  i.town.block_timestamp_ns = String(
    BigInt(i.town.block_timestamp_ns) + 1000000n,
  );
  assert.deepEqual(
    plan(i).candidates.map((c) => c.id),
    p.candidates.map((c) => c.id),
  );
  i.stockSharingReaction.usedMerchants = ["rex"];
  assert.equal(
    plan(i).candidates.some((c) => c.buyer === "rex" || c.seller === "rex"),
    false,
  );
  i.stockSharingReaction.followUpOnly = true;
  assert.equal(plan(i).candidates.length, 0);
});
test("exact 300-second demand excludes merchant transfers, deduplicates retail receipts and expires old sales", () => {
  const i = input();
  i.town.block_timestamp_ns = String(
    BigInt(i.town.data.genesis_time_ns) + 600000000000n,
  );
  i.town.data.epoch = "10";
  held(i, "rex", "crystal", 5, 3);
  const t = structuredClone(receiptOutcome(capture.steps[6]).trade);
  t.quantity = "15";
  t.total_price = "60";
  t.settled_at_ns = String(BigInt(i.town.block_timestamp_ns) - 299000000000n);
  i.trades = [t, structuredClone(t), receiptOutcome(capture.steps[4]).trade];
  let signal = plan(i).signals.find((s) => s.item === "crystal");
  assert.equal(signal.lowStock, false);
  assert.equal(signal.fastSelling, true);
  assert.equal(signal.retailDemand, "15");
  t.settled_at_ns = String(BigInt(i.town.block_timestamp_ns) - 300000000000n);
  i.trades = [t];
  assert.equal(plan(i).signals[0].retailDemand, "15");
  t.settled_at_ns = String(BigInt(i.town.block_timestamp_ns) - 301000000000n);
  assert.equal(plan(i).signals[0].retailDemand, "0");
  const duplicate = structuredClone(t);
  duplicate.quantity = "16";
  duplicate.total_price = "64";
  i.trades = [t, duplicate];
  assert.throws(() => plan(i), /conflicting/);
});
test("pending incoming units count toward seven and expired promises remain locked until cleanup", () => {
  const i = input(),
    l = i.town.data.npc_ledgers[1];
  held(i, "luna", "crystal", 6, 0, 1);
  l.gold.trade_reserved = "4";
  l.gold.available = "196";
  const offer = structuredClone(receiptOutcome(capture.steps[1]).offer);
  offer.quantity = "1";
  offer.total_price = "4";
  i.pendingOffers = [offer];
  let p = plan(i);
  assert.equal(
    p.candidates.some((c) =>
      [c.buyer, c.seller].some((m) => m === "rex" || m === "luna"),
    ),
    false,
  );
  assert.equal(p.pendingAssessments[0].eligible, true);
  assert.equal(p.pendingAssessments[0].acceptanceReady, false);
  i.town.block_timestamp_ns = offer.expires_at_ns;
  i.town.data.epoch = String(
    (BigInt(offer.expires_at_ns) - BigInt(i.town.data.genesis_time_ns)) /
      60000000000n,
  );
  p = plan(i);
  assert.equal(p.pendingAssessments[0].eligible, false);
  assert(
    p.pendingAssessments[0].reasons.includes("offer_expired_requires_cleanup"),
  );
  i.pendingOffers = [];
  assert.throws(() => plan(i), /reservation|pending/);
});
