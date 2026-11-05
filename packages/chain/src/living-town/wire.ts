import { livingTownItemIds, livingTownVersions } from "@bot-bazaar/shared";
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
      typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(v),
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
    choice(["initialize_town", "get_foundation", "get_town"] as const),
    3,
  ),
});
export function livingTownFoundation(
  value: unknown,
): ReturnType<typeof foundationShape> {
  const result = foundationShape(value);
  check(
    result.item_ids.join() === livingTownItemIds.join() &&
      result.supported_methods.join() ===
        "initialize_town,get_foundation,get_town",
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
const marketEvent = object({
  event_id: positiveU64,
  definition_id: literal("herb_shortage_v1"),
  start_epoch: positiveU64,
  end_epoch: positiveU64,
  herb_supply_ceiling: literal("4"),
  revision: positiveU64,
});
const townShape = object({
  paused: boolean,
  registered_player_count: bounded(0n, 1000n),
  epoch: parseU64,
  genesis_time_ns: parseU64,
  npc_shops: array(livingTownShop, 3),
  npc_ledgers: array(livingTownLedger, 3),
  customer_pool: object({
    pool_id: literal("town_customers"),
    gold: bounded(0n, 200n),
    epoch: parseU64,
    last_funded_epoch: parseU64,
    potion_units_bought: bounded(0n, 2n),
    tool_units_bought: bounded(0n, 2n),
    revision: positiveU64,
  }),
  totals: livingTownTotals,
  market_event: nullable(marketEvent),
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
