import {
  livingTownItemIds,
  livingTownVersions,
  livingTownFoundationMethods,
} from "@bot-bazaar/shared";
import type { LivingTownSix } from "@bot-bazaar/shared";
import {
  accountId,
  array,
  boolean,
  bounded,
  check,
  choice,
  hash32,
  literal,
  nullable,
  object,
  parseU64,
  positiveU64,
} from "../wire.js";
import type { Decoder } from "../wire.js";

export const livingTownItem = choice(livingTownItemIds);
export function parseLivingTownU128(value: unknown): string {
  check(
    typeof value === "string" &&
      value.length <= 39 &&
      /^(0|[1-9][0-9]*)$/.test(value),
    "expected canonical u128 string",
  );
  check(
    BigInt(value) <= 340282366920938463463374607431768211455n,
    "u128 overflow",
  );
  return value;
}
export const livingTownDigest = (value: unknown): string => {
  check(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "invalid V2 digest",
  );
  return value;
};
export function livingTownSix<T>(
  decode: Decoder<T>,
): Decoder<LivingTownSix<T>> {
  return object({
    crystal: decode,
    wood: decode,
    herb: decode,
    iron: decode,
    health_potion: decode,
    iron_tool: decode,
  });
}
const itemAmount = bounded(0n, 1000n);
const inventoryShape = object({
  held: livingTownSix(itemAmount),
  available: livingTownSix(itemAmount),
  listing_reserved: livingTownSix(itemAmount),
  trade_reserved: livingTownSix(itemAmount),
  production_output_reserved: livingTownSix(itemAmount),
  trade_inbound_reserved: livingTownSix(itemAmount),
});
export function parseLivingTownInventory(
  value: unknown,
): ReturnType<typeof inventoryShape> {
  const result = inventoryShape(value);
  for (const item of livingTownItemIds) {
    check(
      BigInt(result.held[item]) ===
        BigInt(result.available[item]) +
          BigInt(result.listing_reserved[item]) +
          BigInt(result.trade_reserved[item]),
      "V2 inventory conservation",
    );
    check(
      BigInt(result.held[item]) +
        BigInt(result.production_output_reserved[item]) +
        BigInt(result.trade_inbound_reserved[item]) <=
        1000n,
      "V2 inbound capacity",
    );
  }
  return result;
}
export const parseLivingTownDeployment = object({
  network_id: literal("testnet"),
  genesis_hash: hash32,
  contract_id: accountId,
  api_version: literal(livingTownVersions.api_version),
  state_schema: literal(livingTownVersions.state_schema),
  command_schema: literal(livingTownVersions.command_schema),
  config_version: literal(livingTownVersions.config_version),
  config_sha256: livingTownDigest,
});
export const livingTownCommand = object({
  sequence: positiveU64,
  config_version: literal("1"),
  valid_until_ns: positiveU64,
});
export const livingTownActor = (
  value: unknown,
):
  | { kind: "player"; account_id: string }
  | { kind: "merchant"; merchant_id: "rex" | "luna" | "bolt" } => {
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "player"
  )
    return object({ kind: literal("player"), account_id: accountId })(value);
  return object({
    kind: literal("merchant"),
    merchant_id: choice(["rex", "luna", "bolt"] as const),
  })(value);
};
const goldShape = object({
  held: bounded(0n, 1000000n),
  available: bounded(0n, 1000000n),
  trade_reserved: bounded(0n, 1000000n),
  trade_inbound_reserved: bounded(0n, 1000000n),
});
export function livingTownGold(value: unknown): ReturnType<typeof goldShape> {
  const result = goldShape(value);
  check(
    BigInt(result.held) ===
      BigInt(result.available) + BigInt(result.trade_reserved) &&
      BigInt(result.held) + BigInt(result.trade_inbound_reserved) <= 1000000n,
    "V2 gold conservation/capacity",
  );
  return result;
}
export const livingTownLedger = object({
  actor: livingTownActor,
  revision: positiveU64,
  gold: livingTownGold,
  inventory: parseLivingTownInventory,
});
export const livingTownShop = object({
  shop_id: positiveU64,
  owner: livingTownActor,
  name: (v: unknown) => {
    check(
      typeof v === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.exec(v)?.[0] === v,
      "invalid shop name",
    );
    return v;
  },
  revision: positiveU64,
  production_slots: bounded(1n, 2n),
  policy_revision: positiveU64,
  created_at_ns: parseU64,
  ownership_command_sequence: nullable(positiveU64),
});
const exactNull = (v: unknown): null => {
  check(v === null, "expected null");
  return null;
};
const rawItem = choice(["crystal", "wood", "herb", "iron"] as const);
const merchant = choice(["rex", "luna", "bolt"] as const);
const listingShape = object({
  listing_id: positiveU64,
  shop_id: positiveU64,
  owner: livingTownActor,
  item_id: livingTownItem,
  remaining_quantity: bounded(0n, 100n),
  unit_price: bounded(1n, 100n),
  revision: positiveU64,
  active: boolean,
});
export function livingTownListing(
  value: unknown,
): ReturnType<typeof listingShape> {
  const result = listingShape(value);
  check(
    result.active === BigInt(result.remaining_quantity) > 0n,
    "V2 listing activity mismatch",
  );
  return result;
}
const rawTradeShape = object({
  trade_id: positiveU64,
  kind: literal("raw_purchase"),
  buyer: object({ kind: literal("player"), account_id: accountId }),
  customer_pool_id: exactNull,
  seller: object({ kind: literal("merchant"), merchant_id: merchant }),
  item_id: rawItem,
  quantity: bounded(1n, 100n),
  unit_price: bounded(1n, 100n),
  total_price: bounded(1n, 10000n),
  listing_id: positiveU64,
  offer_id: exactNull,
  consumed_quantity: literal("0"),
  settled_at_ns: parseU64,
  command_principal: (v: unknown) => {
    check(
      typeof v === "string" && v.startsWith("account:"),
      "V2 purchase principal required",
    );
    accountId(v.slice(8));
    return v;
  },
  command_sequence: positiveU64,
  event_sequence: positiveU64,
});
export function livingTownRawTrade(
  value: unknown,
): ReturnType<typeof rawTradeShape> {
  const result = rawTradeShape(value);
  check(
    BigInt(result.quantity) * BigInt(result.unit_price) ===
      BigInt(result.total_price) &&
      result.command_principal === `account:${result.buyer.account_id}`,
    "V2 trade arithmetic/identity mismatch",
  );
  return result;
}
const purchaseEffectShape = object({
  principal: (v: unknown) => {
    check(typeof v === "string", "V2 principal required");
    return v;
  },
  command_sequence: positiveU64,
  payload_sha256: livingTownDigest,
  replayed: boolean,
  effect_revision: positiveU64,
  effect_event_sequence: positiveU64,
  outcome: object({
    kind: literal("raw_purchased"),
    trade: livingTownRawTrade,
    listing: livingTownListing,
    buyer: livingTownLedger,
    seller: livingTownLedger,
  }),
});
export function livingTownPurchaseEffect(
  value: unknown,
): ReturnType<typeof purchaseEffectShape> {
  const r = purchaseEffectShape(value);
  const { trade, listing, buyer, seller } = r.outcome;
  check(
    r.principal === trade.command_principal &&
      r.command_sequence === trade.command_sequence &&
      r.effect_revision === r.effect_event_sequence &&
      r.effect_event_sequence === trade.event_sequence,
    "V2 purchase effect mismatch",
  );
  check(
    buyer.actor.kind === "player" &&
      buyer.actor.account_id === trade.buyer.account_id &&
      seller.actor.kind === "merchant" &&
      seller.actor.merchant_id === trade.seller.merchant_id &&
      listing.owner.kind === "merchant" &&
      listing.owner.merchant_id === trade.seller.merchant_id,
    "V2 purchase actors mismatch",
  );
  check(
    listing.shop_id ===
      String(["rex", "luna", "bolt"].indexOf(trade.seller.merchant_id) + 1) &&
      listing.listing_id === trade.listing_id &&
      listing.item_id === trade.item_id &&
      listing.unit_price === trade.unit_price &&
      BigInt(seller.inventory.listing_reserved[trade.item_id]) ===
        BigInt(listing.remaining_quantity),
    "V2 purchase listing mismatch",
  );
  return r;
}
const playerShape = object({
  account_id: accountId,
  ledger: livingTownLedger,
  shop_id: nullable(positiveU64),
  grant_issued: boolean,
  grant_command_sequence: positiveU64,
});
export function livingTownPlayer(
  value: unknown,
): ReturnType<typeof playerShape> {
  const result = playerShape(value);
  check(
    result.grant_issued &&
      result.ledger.actor.kind === "player" &&
      result.ledger.actor.account_id === result.account_id,
    "V2 player ledger/owner mismatch",
  );
  return result;
}
const ownershipOutcome = (value: unknown) => {
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "player_registered"
  )
    return object({
      kind: literal("player_registered"),
      player: livingTownPlayer,
    })(value);
  return object({
    kind: choice(["shop_created", "shop_renamed"] as const),
    shop: livingTownShop,
  })(value);
};
const ownershipEffectShape = object({
  principal: (value: unknown) => {
    check(
      typeof value === "string" && value.startsWith("account:"),
      "V2 ownership principal required",
    );
    accountId(value.slice(8));
    return value;
  },
  command_sequence: positiveU64,
  payload_sha256: livingTownDigest,
  replayed: boolean,
  effect_revision: positiveU64,
  effect_event_sequence: positiveU64,
  outcome: ownershipOutcome,
});
export function livingTownOwnershipEffect(
  value: unknown,
): ReturnType<typeof ownershipEffectShape> {
  const result = ownershipEffectShape(value);
  const owner =
    result.outcome.kind === "player_registered"
      ? result.outcome.player.account_id
      : result.outcome.shop.owner.kind === "player"
        ? result.outcome.shop.owner.account_id
        : null;
  check(
    owner !== null &&
      result.principal === `account:${owner}` &&
      result.effect_revision === result.effect_event_sequence,
    "V2 ownership effect identity mismatch",
  );
  if (result.outcome.kind === "player_registered")
    check(
      result.outcome.player.grant_command_sequence === result.command_sequence,
      "V2 grant command mismatch",
    );
  if (result.outcome.kind === "shop_created")
    check(
      result.outcome.shop.ownership_command_sequence ===
        result.command_sequence,
      "V2 shop creation command mismatch",
    );
  return result;
}
export function livingTownSnapshot<T>(decode: Decoder<T>): Decoder<{
  deployment: ReturnType<typeof parseLivingTownDeployment>;
  market_revision: string;
  event_sequence: string;
  block_height: string;
  block_timestamp_ns: string;
  data: T;
}> {
  const shape = object({
    deployment: parseLivingTownDeployment,
    market_revision: positiveU64,
    event_sequence: positiveU64,
    block_height: parseU64,
    block_timestamp_ns: parseU64,
    data: decode,
  });
  return (value) => {
    const result = shape(value);
    check(
      result.market_revision === result.event_sequence,
      "V2 revision/event mismatch",
    );
    return result;
  };
}
const foundationShape = object({
  owner_account_id: accountId,
  operator_account_id: accountId,
  merchant_controllers: object({
    rex: accountId,
    luna: accountId,
    bolt: accountId,
  }),
  item_ids: array(livingTownItem, 6),
  supported_methods: array(
    choice(livingTownFoundationMethods),
    livingTownFoundationMethods.length,
  ),
});
export function livingTownFoundation(
  value: unknown,
): ReturnType<typeof foundationShape> {
  const result = foundationShape(value);
  // Closed historical profile preserves actual pre-policy receipt fixtures.
  // Live readers still pin the reviewed artifact hash; partial profiles reject.
  check(
    result.item_ids.join() === livingTownItemIds.join() &&
      (result.supported_methods.join() === livingTownFoundationMethods.join() ||
        result.supported_methods.join() ===
          livingTownFoundationMethods.slice(0, -2).join()),
    "V2 foundation capabilities/items mismatch",
  );
  const roles = [
    result.owner_account_id,
    result.operator_account_id,
    ...Object.values(result.merchant_controllers),
  ];
  check(new Set(roles).size === 5, "V2 authority overlap");
  return result;
}
export const livingTownLimits = object({
  max_players: literal("1000"),
  max_actor_gold: literal("1000000"),
  max_actor_item: literal("1000"),
  max_listing_quantity: literal("100"),
  max_purchase_quantity: literal("100"),
  max_unit_price: literal("100"),
  max_total_price: literal("10000"),
  max_batch_quantity: literal("10"),
  max_page_size: literal("50"),
  max_expire_batch: literal("24"),
  max_name_bytes: literal("32"),
  max_command_lifetime_seconds: literal("600"),
  max_offer_lifetime_seconds: literal("600"),
  retained_command_results: literal("1"),
  retained_jobs: literal("256"),
  retained_trades: literal("256"),
  retained_events: literal("256"),
  max_active_offers: literal("12"),
  max_recipe_versions: literal("4"),
});
export const livingTownTotals = object({
  initial_gold: parseLivingTownU128,
  player_grants: parseLivingTownU128,
  customer_topups: parseLivingTownU128,
  upgrade_burns: parseLivingTownU128,
  treasury_burns: parseLivingTownU128,
  seed_items: livingTownSix(parseLivingTownU128),
  supplied_items: livingTownSix(parseLivingTownU128),
  recipe_inputs_consumed: livingTownSix(parseLivingTownU128),
  completed_outputs: livingTownSix(parseLivingTownU128),
  customer_consumed: livingTownSix(parseLivingTownU128),
});
const marketEventShape = object({
  event_id: positiveU64,
  definition_id: literal("herb_shortage_v1"),
  start_epoch: positiveU64,
  end_epoch: positiveU64,
  herb_supply_ceiling: literal("4"),
  revision: positiveU64,
});
export function livingTownMarketEvent(
  value: unknown,
): ReturnType<typeof marketEventShape> {
  const e = marketEventShape(value);
  check(
    BigInt(e.end_epoch) === BigInt(e.start_epoch) + 5n,
    "invalid market event interval",
  );
  return e;
}
export const livingTownCustomerPool = object({
  pool_id: literal("town_customers"),
  gold: bounded(0n, 200n),
  epoch: parseU64,
  last_funded_epoch: parseU64,
  potion_units_bought: bounded(0n, 2n),
  tool_units_bought: bounded(0n, 2n),
  revision: positiveU64,
});
const townShape = object({
  paused: boolean,
  registered_player_count: bounded(0n, 1000n),
  epoch: parseU64,
  genesis_time_ns: parseU64,
  npc_shops: array(livingTownShop, 3),
  npc_ledgers: array(livingTownLedger, 3),
  customer_pool: livingTownCustomerPool,
  totals: livingTownTotals,
  market_event: nullable(livingTownMarketEvent),
  next_shop_id: positiveU64,
  next_listing_id: positiveU64,
  next_job_id: positiveU64,
  next_offer_id: positiveU64,
  next_trade_id: positiveU64,
  next_market_event_id: positiveU64,
  retained_events_from: positiveU64,
  limits: livingTownLimits,
});

export function livingTownTown(value: unknown): ReturnType<typeof townShape> {
  const result = townShape(value);
  check(
    result.market_event === null
      ? result.next_market_event_id === "1"
      : BigInt(result.market_event.event_id) + 1n ===
          BigInt(result.next_market_event_id),
    "market event high-water mismatch",
  );
  const merchants = ["rex", "luna", "bolt"];
  check(
    result.npc_shops.length === 3 && result.npc_ledgers.length === 3,
    "V2 requires three NPC shops/ledgers",
  );
  merchants.forEach((name, index) => {
    const shop = result.npc_shops[index]!;
    const ledger = result.npc_ledgers[index]!;
    check(
      shop.owner.kind === "merchant" &&
        shop.owner.merchant_id === name &&
        ledger.actor.kind === "merchant" &&
        ledger.actor.merchant_id === name,
      "V2 NPC identity/order mismatch",
    );
  });
  check(
    new Set(result.npc_shops.map((shop) => shop.shop_id)).size === 3,
    "V2 duplicate NPC shop",
  );
  return result;
}

export function decodeLivingTownSnapshot<T>(
  value: unknown,
  expected: unknown,
  decode: Decoder<T>,
): ReturnType<ReturnType<typeof livingTownSnapshot<T>>> {
  const identity = parseLivingTownDeployment(expected);
  const snapshot = livingTownSnapshot(decode)(value);
  check(
    Object.keys(identity).every(
      (key) =>
        snapshot.deployment[key as keyof typeof identity] ===
        identity[key as keyof typeof identity],
    ),
    "V2 snapshot deployment/config mismatch",
  );
  return snapshot;
}

export const livingTownProductionEffectBase = object({
  principal: (v: unknown): string => {
    check(typeof v === "string", "Principal required");
    if (v.startsWith("account:")) accountId(v.slice(8));
    else
      check(
        ["merchant:rex", "merchant:luna", "merchant:bolt"].includes(v),
        "Invalid merchant principal",
      );
    return v;
  },
  command_sequence: positiveU64,
  payload_sha256: livingTownDigest,
  replayed: boolean,
  effect_revision: positiveU64,
  effect_event_sequence: positiveU64,
  outcome: (v: unknown) => v,
});
