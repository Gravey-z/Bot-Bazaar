// Controlled single-player economic soak using the reviewed specification model
// and real pure V2 merchant/customer policies. Not a contract or hosted worker emulator.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  EconomyModel,
  economy,
  decimalReport,
} from "./living-town-economy.mjs";
import { LivingTownMerchantPolicy } from "../../apps/worker/dist/private/living-town/merchant-policy.js";
import { LivingTownCustomerDemand } from "../../apps/worker/dist/private/living-town/customers.js";
import { describeLivingTownMarketEvent } from "../../packages/chain/dist/index.js";
const read = (p) => JSON.parse(readFileSync(p, "utf8")),
  config = read("config/living-town-v1.json"),
  capture = read("tests/fixtures/chain/living-town-races-sandbox.json");
const base = capture.stages[0].before.town,
  foundation = capture.setup[0].foundation,
  names = ["rex", "luna", "bolt"],
  raw = Object.keys(economy.materials),
  products = Object.keys(economy.recipes),
  items = [...raw, ...products];
const player = capture.stages[0].before.shops[0].shop.data.owner.account_id;
const six = (fn) =>
  Object.fromEntries(items.map((item) => [item, String(fn(item))]));
export function runTownSoak({
  epochs = 720,
  seed = "42",
  shortage = true,
  funding = true,
  overpriceUntil = 0,
  downtimeAt = null,
  downtimeEpochs = 10000,
} = {}) {
  if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs > 1440)
    throw Error("soak epoch bound");
  const event = {
    event_id: "1",
    definition_id: "herb_shortage_v1",
    start_epoch: "1",
    end_epoch: "6",
    herb_supply_ceiling: "4",
    revision: "1",
  };
  const model = new EconomyModel({
    supplyCeiling: (item, epoch, baseline) =>
      item === "herb" && shortage
        ? BigInt(describeLivingTownMarketEvent(event, String(epoch)).current)
        : baseline,
  });
  const merchantPolicy = new LivingTownMerchantPolicy(config),
    demand = new LivingTownCustomerDemand(config),
    history = [],
    lastSale = { health_potion: null, iron_tool: null };
  let command = 0,
    trade = 0,
    lastSaleStep = 0,
    productCursor = 0,
    maxSaleGap = 0,
    missedEpochs = 0,
    lastSaleEpoch = 0n,
    maxEconomicGap = 0n;
  const trace = createHash("sha256"),
    metrics = {
      sales: 0,
      starts: 0,
      completions: 0,
      noPurchase: {},
      rawStockouts: 0,
      unaffordableStarts: 0,
      eligibleUnfunded: 0,
      overpriced: 0,
      prices: Object.fromEntries(
        raw.map((item) => [item, { min: 100n, max: 0n }]),
      ),
      stock: Object.fromEntries(
        items.map((item) => [item, { min: 1000n, max: 0n }]),
      ),
      supplyTrace: [],
    };
  const next = (label) => `${++command}:${label}`,
    revision = () => String(Object.keys(model.state.commands).length + 1),
    now = () =>
      String(BigInt(base.data.genesis_time_ns) + model.state.now * 1000000000n);
  const addTrade = (item, quantity, price, kind) => {
    const r = economy.materials[item];
    history.push({
      trade_id: String(++trade),
      kind,
      buyer:
        kind === "raw_purchase" ? { kind: "player", account_id: player } : null,
      customer_pool_id: kind === "raw_purchase" ? null : "town_customers",
      seller:
        kind === "raw_purchase"
          ? { kind: "merchant", merchant_id: r.supplier }
          : { kind: "player", account_id: player },
      item_id: item,
      quantity: String(quantity),
      unit_price: String(price),
      total_price: String(quantity * price),
      listing_id: String(items.indexOf(item) + 1),
      offer_id: null,
      consumed_quantity: kind === "raw_purchase" ? "0" : "1",
      settled_at_ns: now(),
      command_principal: `account:${kind === "raw_purchase" ? player : foundation.data.operator_account_id}`,
      command_sequence: revision(),
      event_sequence: revision(),
    });
  };
  const buy = (item, quantity) => {
    const price = model.state.stock[item].price;
    model.buy(next(`buy:${item}`), item, quantity);
    addTrade(item, quantity, price, "raw_purchase");
  };
  model.register(next("register"));
  buy("herb", 12n);
  function facts() {
    const town = structuredClone(base),
      s = model.state,
      rev = revision();
    town.market_revision = town.event_sequence = rev;
    town.block_height = String(model.state.now + 1n);
    town.block_timestamp_ns = now();
    Object.assign(town.data, {
      epoch: String(model.epoch),
      registered_player_count: "1",
      next_shop_id: "5",
      next_listing_id: String(5 + Object.keys(s.listings).length),
      next_job_id: String(Object.keys(s.jobs).length + 1),
      next_trade_id: String(trade + 1),
      market_event: shortage ? event : null,
      next_market_event_id: shortage ? "2" : "1",
    });
    const inventory = (merchant = null) => ({
      held: six((i) =>
        merchant
          ? economy.materials[i]?.supplier === merchant
            ? s.stock[i].held
            : 0n
          : model.held(i),
      ),
      available: six((i) =>
        merchant
          ? economy.materials[i]?.supplier === merchant
            ? s.stock[i].held - s.stock[i].listed
            : 0n
          : model.available(i),
      ),
      listing_reserved: six((i) =>
        merchant
          ? economy.materials[i]?.supplier === merchant
            ? s.stock[i].listed
            : 0n
          : (s.listings[i]?.quantity ?? 0n),
      ),
      trade_reserved: six(() => 0n),
      production_output_reserved: six((i) =>
        merchant ? 0n : s.outputReserved[i],
      ),
      trade_inbound_reserved: six(() => 0n),
    });
    town.data.npc_ledgers = names.map((merchant) => ({
      actor: { kind: "merchant", merchant_id: merchant },
      revision: rev,
      gold: {
        held: String(s.merchants[merchant]),
        available: String(s.merchants[merchant]),
        trade_reserved: "0",
        trade_inbound_reserved: "0",
      },
      inventory: inventory(merchant),
    }));
    town.data.customer_pool = {
      pool_id: "town_customers",
      gold: String(s.customer),
      epoch: String(model.epoch),
      last_funded_epoch: String(s.allocations["topup:pool"] ?? 0n),
      potion_units_bought: String(
        s.quota[`${model.epoch}:health_potion`] ?? 0n,
      ),
      tool_units_bought: String(s.quota[`${model.epoch}:iron_tool`] ?? 0n),
      revision: rev,
    };
    Object.assign(town.data.totals, {
      player_grants: "100",
      customer_topups: String(s.issuedGold - 800n),
      treasury_burns: String(s.burnedGold - s.upgradeSpending),
      upgrade_burns: String(s.upgradeSpending),
      supplied_items: six((i) => s.supplied[i]),
      recipe_inputs_consumed: six((i) =>
        raw.includes(i) ? s.consumed[i] : 0n,
      ),
      completed_outputs: six((i) => s.produced[i]),
      customer_consumed: six((i) =>
        products.includes(i) ? s.consumed[i] : 0n,
      ),
    });
    const pin = (data) => ({ ...town, data });
    const merchants = names.map((merchant, i) => ({
      shop: pin(town.data.npc_shops[i]),
      listings: raw
        .filter((item) => economy.materials[item].supplier === merchant)
        .map((item) => ({
          listing_id: String(raw.indexOf(item) + 1),
          shop_id: String(i + 1),
          owner: { kind: "merchant", merchant_id: merchant },
          item_id: item,
          remaining_quantity: String(s.stock[item].listed),
          unit_price: String(s.stock[item].price),
          revision: rev,
          active: s.stock[item].listed > 0n,
        })),
      job: null,
    }));
    const owner = { kind: "player", account_id: player },
      shop = pin({
        shop_id: "4",
        owner,
        name: "Soak fixture",
        revision: rev,
        production_slots: String(s.slots),
        policy_revision: "1",
        created_at_ns: town.data.genesis_time_ns,
        ownership_command_sequence: "2",
      }),
      ledger = pin({
        actor: owner,
        revision: rev,
        gold: {
          held: String(s.player),
          available: String(s.player),
          trade_reserved: "0",
          trade_inbound_reserved: "0",
        },
        inventory: inventory(),
      });
    const candidates = products
      .filter((item) => s.listings[item])
      .map((item) => ({
        shop,
        ledger,
        lastSaleEventSequence: lastSale[item],
        listing: {
          listing_id: String(items.indexOf(item) + 1),
          shop_id: "4",
          owner,
          item_id: item,
          remaining_quantity: String(s.listings[item].quantity),
          unit_price: String(s.listings[item].price),
          revision: rev,
          active: s.listings[item].quantity > 0n,
        },
      }));
    return {
      town,
      merchants,
      trades: history,
      fresh: true,
      historyComplete: true,
      candidates,
    };
  }
  for (let step = 1; step <= epochs; step++) {
    if (step === downtimeAt) {
      model.advance(BigInt(downtimeEpochs) * 60n);
      missedEpochs += downtimeEpochs;
    }
    model.advance(60n);
    const s = model.state;
    const cutoff =
      BigInt(base.data.genesis_time_ns) +
      (model.epoch > 4n ? model.epoch - 4n : 0n) * 60000000000n;
    while (history.length && BigInt(history[0].settled_at_ns) < cutoff)
      history.shift();
    for (const item of raw)
      if (s.stock[item].held < BigInt(economy.materials[item].target)) {
        const id = next(`supply:${item}`),
          amount = model.allocate(id, "supply", item);
        if (model.epoch <= 8n)
          metrics.supplyTrace.push({
            epoch: String(model.epoch),
            item,
            amount: String(amount),
          });
      }
    if (funding && s.customer < BigInt(economy.customerCap))
      model.allocate(next("topup"), "topup");
    for (const merchant of names)
      if (s.merchants[merchant] > BigInt(economy.treasuryRetain))
        model.allocate(next(`treasury:${merchant}`), "treasury", merchant);
    const evaluated = merchantPolicy.evaluate(facts());
    for (const signal of evaluated.scarcity) {
      const price = BigInt(
        signal.suggestedPrice ?? config.economy.materials[signal.item].price,
      );
      const stock = s.stock[signal.item],
        targetListed =
          stock.held - BigInt(economy.materials[signal.item].floor);
      if (stock.price !== price || stock.listed !== targetListed)
        model.relistRaw(next(`list:${signal.item}`), signal.item, price);
      metrics.prices[signal.item].min =
        metrics.prices[signal.item].min < price
          ? metrics.prices[signal.item].min
          : price;
      metrics.prices[signal.item].max =
        metrics.prices[signal.item].max > price
          ? metrics.prices[signal.item].max
          : price;
    }
    for (const [id, job] of Object.entries(s.jobs))
      if (!job.completed && job.ready <= s.now) {
        model.complete(id);
        metrics.completions++;
      }
    for (const product of products) {
      const quantity = model.held(product);
      if (quantity > 0n) {
        const price =
          BigInt(economy.recipes[product].salePrice) +
          (step <= overpriceUntil ? 1n : 0n);
        if (
          s.listings[product]?.quantity !== quantity ||
          s.listings[product]?.price !== price
        )
          model.list(next(`list:${product}`), product, quantity, price);
      }
    }
    for (let index = 0; index < 4; index++) {
      const f = facts(),
        decision = demand.select({
          town: f.town,
          seed,
          tick: String(model.epoch),
          arrivalIndex: String(index),
          fresh: true,
          marketComplete: true,
          historyComplete: true,
          candidates: f.candidates,
        });
      trace.update(JSON.stringify(decision));
      if (decision.kind === "purchase") {
        const item = decision.itemId,
          price = s.listings[item].price;
        model.sell(next(`sale:${item}`), item);
        addTrade(item, 1n, price, "customer_sale");
        lastSale[item] = revision();
        metrics.sales++;
        const economicGap = model.epoch - lastSaleEpoch;
        if (economicGap > maxEconomicGap) maxEconomicGap = economicGap;
        lastSaleEpoch = model.epoch;
        maxSaleGap = Math.max(maxSaleGap, step - lastSaleStep);
        lastSaleStep = step;
      } else {
        metrics.noPurchase[decision.reason] =
          (metrics.noPurchase[decision.reason] ?? 0) + 1;
        if (decision.reason === "insufficient_budget")
          metrics.eligibleUnfunded++;
        if (decision.reason === "above_willingness_to_pay")
          metrics.overpriced++;
      }
    }
    if (Object.values(s.jobs).every((j) => j.completed)) {
      const product = products[productCursor % products.length],
        recipe = economy.recipes[product];
      let cost = 0n,
        stock = true;
      for (const [item, units] of Object.entries(recipe.inputs)) {
        const needed =
          BigInt(units) > model.available(item)
            ? BigInt(units) - model.available(item)
            : 0n;
        cost += needed * s.stock[item].price;
        if (s.stock[item].listed < needed) stock = false;
      }
      if (!stock) metrics.rawStockouts++;
      else if (s.player < cost) metrics.unaffordableStarts++;
      else {
        for (const [item, units] of Object.entries(recipe.inputs)) {
          const needed = BigInt(units) - model.available(item);
          if (needed > 0n) buy(item, needed);
        }
        model.start(next(`craft:${product}`), product);
        metrics.starts++;
        productCursor++;
      }
    }
    for (const item of items) {
      const held = raw.includes(item) ? s.stock[item].held : model.held(item);
      metrics.stock[item].min =
        metrics.stock[item].min < held ? metrics.stock[item].min : held;
      metrics.stock[item].max =
        metrics.stock[item].max > held ? metrics.stock[item].max : held;
    }
    model.verify();
  }
  const s = model.state;
  maxSaleGap = Math.max(maxSaleGap, epochs - lastSaleStep);
  if (model.epoch - lastSaleEpoch > maxEconomicGap)
    maxEconomicGap = model.epoch - lastSaleEpoch;
  return decimalReport({
    mode: "offline_economic_soak_with_real_pure_policies",
    chainEvidence: false,
    liveInferenceEvidence: false,
    providerCalls: 0,
    providerReservedMicro: 0,
    seed,
    epochs,
    economicEpoch: String(model.epoch),
    missedEpochs,
    metrics: {
      ...metrics,
      maxActiveEpochsBetweenSales: maxSaleGap,
      maxEconomicEpochsBetweenSales: maxEconomicGap,
    },
    gold: {
      player: s.player,
      customer: s.customer,
      merchants: s.merchants,
      issued: s.issuedGold,
      burned: s.burnedGold,
    },
    items: Object.fromEntries(
      items.map((item) => [
        item,
        {
          seed: BigInt(economy.materials[item]?.seed ?? 0),
          supplied: s.supplied[item],
          produced: s.produced[item],
          consumed: s.consumed[item],
          held: model.held(item) + (s.stock[item]?.held ?? 0n),
        },
      ]),
    ),
    commands: Object.keys(s.commands).length,
    modelAllocations: s.allocations,
    traceDigest: trace.digest("hex"),
  });
}
