import assert from "node:assert/strict";
import test from "node:test";
import {
  EconomyModel,
  economy,
  decimalReport,
} from "./living-town-economy.mjs";

const products = Object.keys(economy.recipes);
const materials = Object.keys(economy.materials);
function setup(options) {
  const model = new EconomyModel(options);
  model.register("register");
  return model;
}
function buyIngredients(model, prefix, product, quantity = 1n) {
  for (const [item, units] of Object.entries(economy.recipes[product].inputs)) {
    const needed = BigInt(units) * quantity;
    if (model.state.stock[item].listed < needed) {
      model.allocate(`${prefix}:supply:${item}`, "supply", item);
      model.relistRaw(
        `${prefix}:relist:${item}`,
        item,
        model.state.stock[item].price,
      );
    }
    model.buy(`${prefix}:buy:${item}`, item, needed);
  }
}
function craft(model, id, product, quantity = 1n) {
  model.start(id, product, quantity);
  model.advance(BigInt(economy.recipes[product].seconds) * quantity);
  model.complete(id);
}
function sale(model, id, product) {
  if (model.state.customer < BigInt(economy.recipes[product].salePrice))
    model.allocate(`${id}:fund`, "topup");
  model.sell(id, product);
}
function pair(model, n) {
  for (const product of products)
    buyIngredients(model, `${n}:${product}`, product);
  const afterBuy = model.state.player;
  for (const product of products) {
    craft(model, `${n}:craft:${product}`, product);
    model.list(
      `${n}:list:${product}`,
      product,
      1n,
      economy.recipes[product].salePrice,
    );
    sale(model, `${n}:sale:${product}`, product);
  }
  return {
    pair: n,
    afterBuy,
    afterSales: model.state.player,
    revenue: model.state.revenue,
    cogs: model.state.cogs,
    profit: model.state.revenue - model.state.cogs,
  };
}
function unchanged(model, fn, message) {
  const before = structuredClone(model.state);
  assert.throws(fn, message);
  assert.deepEqual(model.state, before);
}

test("offline V2 config 1: four funded pairs, both products, upgrade and returning purchase", (t) => {
  const model = setup();
  const rows = [1, 2, 3, 4].map((n) => pair(model, n));
  assert.deepEqual(
    rows.map((row) => row.afterBuy),
    [78n, 98n, 118n, 138n],
  );
  assert.deepEqual(
    rows.map((row) => row.afterSales),
    [120n, 140n, 160n, 180n],
  );
  assert.equal(model.state.revenue, 168n);
  assert.equal(model.state.cogs, 88n);
  assert.equal(model.state.now, 1200n);
  assert.deepEqual(
    materials.map((item) => model.state.consumed[item]),
    [4n, 4n, 8n, 8n],
  );
  assert.equal(model.upgrade("upgrade"), 30n);
  assert.equal(model.upgrade("upgrade"), 30n); // Exact retry, no second debit.
  unchanged(model, () => model.upgrade("new-upgrade"), /already upgraded/);
  assert.equal(model.state.slots, 2);
  assert.equal(model.state.revenue - model.state.cogs, 80n);
  assert.equal(model.state.player - 100n, -70n);
  // Return to the same model: no re-registration or reset; recipe inputs still funded.
  const returning = pair(model, 5);
  assert.equal(returning.afterBuy, 8n);
  assert.equal(returning.afterSales, 50n);
  t.diagnostic(
    JSON.stringify(
      decimalReport({
        mode: economy.mode,
        economyVersion: economy.economyVersion,
        liveAiEvidence: false,
        chainEvidence: false,
        rows,
        upgradeCost: 150n,
        cashAfterUpgrade: 30n,
        productionSecondsBeforeUpgrade: 1200n,
        returning,
      }),
    ),
  );
});

test("maximum retail bands still fund upgrade within seven pairs with replenishment", () => {
  const model = setup();
  for (const item of materials)
    model.relistRaw(`max:${item}`, item, economy.materials[item].maxPrice);
  for (let n = 1; n <= 7; n++) pair(model, n);
  assert.equal(model.state.purchases, 203n);
  assert.equal(model.state.revenue, 294n);
  assert.equal(model.state.player, 191n);
  assert.equal(model.upgrade("upgrade"), 41n);
  assert(model.state.supplied.herb > 0n); // Seventh pair exceeds original herb listing.
});

test("depleted saleable seed stock, offline epochs and explicit relisting allow a returning purchase", () => {
  const model = setup();
  model.buy("drain-herbs", "herb", 12n); // Remaining 8 are the protected floor.
  assert.equal(model.state.stock.herb.held, 8n);
  unchanged(model, () => model.buy("empty", "herb", 1n), /supplier exhausted/);
  model.advance(6000n); // 100 epochs of downtime; only the current allowance is issued.
  unchanged(
    model,
    () => model.allocate("old", "supply", "herb", 1n),
    /current epoch only/,
  );
  assert.equal(model.allocate("supply", "supply", "herb"), 8n);
  assert.equal(model.state.supplied.herb, 8n);
  unchanged(
    model,
    () => model.buy("not-relisted", "herb", 1n),
    /supplier exhausted/,
  );
  model.relistRaw("relist", "herb");
  assert.equal(model.buy("returning-buy", "herb", 2n), 6n);
  assert.equal(model.state.player, 58n);
  assert.equal(model.state.issuedGold, 800n); // No new grant or customer top-up.
});

test("source grants, zero allocations, customer top-ups and treasury sinks cannot repeat", () => {
  const model = setup();
  assert.equal(model.register("register"), 100n);
  unchanged(
    model,
    () => model.register("another-registration"),
    /already registered/,
  );
  model.advance(60n);
  assert.equal(model.allocate("full-stock", "supply", "herb"), 0n);
  model.buy("buy", "herb", 2n);
  assert.equal(model.allocate("full-stock", "supply", "herb"), 0n);
  unchanged(
    model,
    () => model.allocate("different-id", "supply", "herb"),
    /already allocated/,
  );
  assert.equal(model.allocate("fund", "topup"), 100n);
  assert.equal(model.allocate("fund", "topup"), 100n);
  unchanged(
    model,
    () => model.allocate("fund-again", "topup"),
    /already allocated/,
  );
  assert.equal(model.allocate("sink", "treasury", "luna"), 6n);
  assert.equal(model.allocate("sink", "treasury", "luna"), 6n);
  unchanged(
    model,
    () => model.allocate("sink-again", "treasury", "luna"),
    /already allocated/,
  );
  assert.equal(model.state.merchants.luna, 200n);
  model.advance(60n);
  assert.equal(model.allocate("at-cap", "topup"), 0n);
  unchanged(
    model,
    () => model.allocate("cap-retry", "topup"),
    /already allocated/,
  );
  assert.equal(model.allocate("next-supply", "supply", "herb"), 2n);
});

test("overpricing yields no sale; reprice/cancel preserves cost and only a funded sale earns revenue", () => {
  const model = setup();
  buyIngredients(model, "p", "health_potion");
  craft(model, "potion", "health_potion");
  model.list("expensive", "health_potion", 1n, 19n);
  assert.equal(model.available("health_potion"), 0n);
  unchanged(model, () => model.sell("no-sale", "health_potion"), /overpriced/);
  model.advance(600n);
  unchanged(
    model,
    () => model.sell("still-no-sale", "health_potion"),
    /overpriced/,
  );
  model.list("cancel", "health_potion", 0n, 19n);
  assert.equal(model.available("health_potion"), 1n);
  assert.deepEqual(model.state.inventory.health_potion, [10n]);
  model.list("reprice", "health_potion", 1n, 18n);
  assert.equal(model.sell("sale", "health_potion"), 18n);
  assert.equal(model.sell("sale", "health_potion"), 18n);
  unchanged(
    model,
    () => model.sell("second-sale", "health_potion"),
    /no listed stock/,
  );
  assert.equal(model.state.player, 108n);
  assert.equal(model.state.cogs, 10n);
});

test("deliberately selling below cost loses gold with no automatic rescue grant", () => {
  const model = setup();
  buyIngredients(model, "p", "health_potion");
  craft(model, "p", "health_potion");
  model.list("loss", "health_potion", 1n, 1n);
  model.sell("loss-sale", "health_potion");
  assert.equal(model.state.player, 91n);
  assert.equal(model.state.revenue - model.state.cogs, -9n);
  unchanged(model, () => model.upgrade("too-early"), /both products required/);
  model.advance(60000n);
  assert.equal(model.state.player, 91n);
  unchanged(model, () => model.register("rescue"), /already registered/);
});

test("batch timing, slots, duplicate start/completion and conflicting command payloads", () => {
  const model = setup();
  buyIngredients(model, "batch", "health_potion", 2n);
  model.start("batch", "health_potion", 2n);
  assert.equal(model.state.jobs.batch.ready, 240n);
  assert.equal(model.state.jobs.batch.recipeVersion, "1");
  assert.equal(model.start("batch", "health_potion", 2n), "batch");
  unchanged(
    model,
    () => model.start("batch", "health_potion", 1n),
    /payload conflict/,
  );
  unchanged(model, () => model.start("overlap", "iron_tool"), /no free slot/);
  model.advance(239n);
  unchanged(model, () => model.complete("batch"), /not ready/);
  model.advance(1n);
  assert.equal(model.complete("batch"), 2n);
  assert.equal(model.complete("batch"), 2n);
  assert.equal(model.held("health_potion"), 2n);
  assert.equal(model.state.outputReserved.health_potion, 0n);
  unchanged(
    model,
    () => model.start("zero", "iron_tool", 0n),
    /batch quantity/,
  );
});

test("FIFO mixed input costs, integer output allocation and partial sale cost basis", () => {
  const model = setup();
  model.buy("herb-lot-1", "herb", 2n); // Cost 6.
  model.relistRaw("herb-price", "herb", 4n);
  model.buy("herb-lot-2", "herb", 2n); // Cost 8.
  model.buy("crystal-lot-1", "crystal", 1n); // Cost 4.
  model.relistRaw("crystal-price", "crystal", 3n);
  model.buy("crystal-lot-2", "crystal", 1n); // Cost 3; batch cost = 21.
  craft(model, "mixed", "health_potion", 2n);
  assert.deepEqual(model.state.inventory.health_potion, [11n, 10n]);
  model.list("two", "health_potion", 2n, 18n);
  model.sell("first", "health_potion");
  assert.equal(model.state.cogs, 11n);
  assert.deepEqual(model.state.inventory.health_potion, [10n]);
  assert.equal(model.state.revenue - model.state.cogs, 7n);
  model.sell("second", "health_potion");
  assert.equal(model.state.cogs, 21n);
  assert.equal(model.state.revenue - model.state.cogs, 15n);
});

test("global per-product epoch quotas and finite customer budget both block unchanged", () => {
  const model = setup();
  buyIngredients(model, "p", "health_potion", 3n);
  craft(model, "p", "health_potion", 3n);
  model.list("potions", "health_potion", 3n, 18n);
  model.sell("p1", "health_potion");
  model.sell("p2", "health_potion");
  unchanged(
    model,
    () => model.sell("p3-blocked", "health_potion"),
    /quota exhausted/,
  );
  model.advance(60n);
  model.sell("p3", "health_potion"); // Pool now 46.
  buyIngredients(model, "t", "iron_tool", 2n);
  craft(model, "t", "iron_tool", 2n);
  model.list("tools", "iron_tool", 2n, 24n);
  model.sell("t1", "iron_tool"); // Pool 22, quota still has one tool.
  unchanged(
    model,
    () => model.sell("t2-blocked", "iron_tool"),
    /budget exhausted/,
  );
  assert.equal(model.state.customer, 22n);
  model.allocate("fund", "topup");
  model.sell("t2", "iron_tool");
  assert.equal(model.state.customer, 98n);
});

test("lower-capacity stress case: concurrent jobs reserve output headroom until settled", () => {
  const model = setup({ capacity: 4n }); // Explicit variant, default capacity remains 1,000.
  for (let n = 1; n <= 7; n++) pair(model, n);
  model.upgrade("upgrade"); // 90 gold permits the four-unit capacity boundary setup.
  for (const id of ["a", "b"]) {
    buyIngredients(model, id, "health_potion", 2n);
    model.start(id, "health_potion", 2n);
  }
  assert.equal(model.state.outputReserved.health_potion, 4n);
  model.advance(240n);
  model.complete("a");
  assert.equal(model.held("health_potion"), 2n);
  assert.equal(model.state.outputReserved.health_potion, 2n);
  buyIngredients(model, "blocked", "health_potion");
  unchanged(
    model,
    () => model.start("overflow", "health_potion"),
    /output capacity/,
  );
  model.complete("b");
  assert.equal(model.held("health_potion"), 4n);
  assert.equal(model.state.outputReserved.health_potion, 0n);
});
