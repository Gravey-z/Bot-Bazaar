import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LivingTownMerchantPolicy } from "../../../apps/worker/dist/private/living-town/merchant-policy.js";
import { canonicalLivingTownJson } from "../../../packages/chain/dist/index.js";

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

export { input, held, bind, policy, capture, cfg };
export function identity(i) {
  return {
    deployment: i.town.deployment,
    codeHash: capture.steps[0].account.code_hash,
    ownerId: capture.foundation.data.owner_account_id,
    operatorId: capture.foundation.data.operator_account_id,
    controllers: structuredClone(capture.foundation.data.merchant_controllers),
  };
}
export function command(i, sequence = "1") {
  return {
    sequence,
    config_version: "1",
    valid_until_ns: String(BigInt(i.town.block_timestamp_ns) + 500000000000n),
  };
}
export function authorize(i) {
  i.negotiationAuthority = {
    journal: "ready",
    signerScopes: {
      rex: "town_negotiating_merchant",
      luna: "town_negotiating_merchant",
      bolt: "town_negotiating_merchant",
    },
  };
  return bind(i);
}
export function proposal(i, merchant, action, tick = "b".repeat(64)) {
  return {
    schema: "living-town-proposal-v1",
    tick_id: tick,
    market_revision: i.town.market_revision,
    merchant_id: merchant,
    reason: "controlled independent model judgment",
    action,
  };
}
export function pending(
  i,
  buyer = "rex",
  seller = "luna",
  item = "crystal",
  quantity = "2",
  price = "5",
) {
  const now = BigInt(i.town.block_timestamp_ns),
    total = String(BigInt(quantity) * BigInt(price));
  const o = {
    offer_id: "1",
    proposer: buyer,
    buyer,
    seller,
    item_id: item,
    quantity,
    unit_price: price,
    total_price: total,
    created_at_ns: String(now),
    expires_at_ns: String(now + 600000000000n),
    status: "pending",
    expired: false,
    revision: "1",
    trade_id: null,
    proposal_command_sequence: "1",
    closed_at_ns: null,
    closing_principal: null,
    closing_command_sequence: null,
  };
  const l = i.town.data.npc_ledgers.find((l) => l.actor.merchant_id === buyer);
  l.gold.trade_reserved = total;
  l.gold.available = String(BigInt(l.gold.held) - BigInt(total));
  l.inventory.trade_inbound_reserved[item] = quantity;
  i.pendingOffers = [o];
  i.town.data.next_offer_id = "2";
  return authorize(i);
}
