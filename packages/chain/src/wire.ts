import { merchantNames, resourceIds } from "@bot-bazaar/shared";

export type Decoder<T> = (value: unknown) => T;
export type U64 = string & { readonly __u64: unique symbol };

export class ChainValidationError extends Error {
  constructor(message: string) {
    super(`Chain validation: ${message}`);
    this.name = "ChainValidationError";
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ChainValidationError(message);
}

export function record(value: unknown): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected object",
  );
  return value as Record<string, unknown>;
}

export function parseU64(value: unknown): U64 {
  check(
    typeof value === "string" &&
      value.length <= 20 &&
      /^(0|[1-9][0-9]*)$/.test(value),
    "expected canonical decimal string",
  );
  check(BigInt(value) <= 18446744073709551615n, "u64 overflow");
  return value as U64;
}

export function rpcU64(value: unknown): U64 {
  if (typeof value === "number") {
    check(Number.isSafeInteger(value) && value >= 0, "unsafe RPC integer");
    return parseU64(String(value));
  }
  return parseU64(value);
}

export function bounded(min: bigint, max: bigint): Decoder<U64> {
  return (value) => {
    const number = parseU64(value);
    check(
      BigInt(number) >= min && BigInt(number) <= max,
      "integer outside bounds",
    );
    return number;
  };
}

export function accountId(value: unknown): string {
  check(
    typeof value === "string" &&
      value.length >= 2 &&
      value.length <= 64 &&
      /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value),
    "invalid account ID",
  );
  return value;
}

export function hash32(value: unknown): string {
  check(
    typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value),
    "invalid base58 hash",
  );
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value)
    number = number * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0;
  for (; number > 0n; number >>= 8n) bytes++;
  check(
    bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32,
    "hash must encode 32 bytes",
  );
  return value;
}

export function publicKey(value: unknown): string {
  check(
    typeof value === "string" && value.startsWith("ed25519:"),
    "expected ed25519 public key",
  );
  hash32(value.slice(8));
  return value;
}

export function choice<const T extends readonly string[]>(
  values: T,
): Decoder<T[number]> {
  return (value) => {
    check(
      typeof value === "string" && values.includes(value),
      "unexpected enum value",
    );
    return value as T[number];
  };
}

export function literal<const T extends string>(expected: T): Decoder<T> {
  return (value) => {
    check(value === expected, "unexpected literal");
    return expected;
  };
}

export const boolean: Decoder<boolean> = (value) => {
  check(typeof value === "boolean", "expected boolean");
  return value;
};

export function nullable<T>(decode: Decoder<T>): Decoder<T | null> {
  return (value) => (value === null ? null : decode(value));
}

export function array<T>(decode: Decoder<T>, maximum: number): Decoder<T[]> {
  return (value) => {
    check(
      Array.isArray(value) && value.length <= maximum,
      "invalid array length",
    );
    return value.map(decode);
  };
}

export function object<S extends Record<string, Decoder<unknown>>>(
  shape: S,
): Decoder<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (value) => {
    const input = record(value);
    const keys = Object.keys(shape);
    check(
      Object.keys(input).length === keys.length &&
        keys.every((key) => Object.hasOwn(input, key)),
      "missing or unknown fields",
    );
    const output: Record<string, unknown> = {};
    for (const key of keys) output[key] = shape[key]!(input[key]);
    return output as { [K in keyof S]: ReturnType<S[K]> };
  };
}

export const merchantId = choice(
  Object.keys(merchantNames) as (keyof typeof merchantNames)[],
);
export const resourceId = choice(resourceIds);
export const positiveU64 = bounded(1n, 18446744073709551615n);
export const quantity = bounded(1n, 100n);
export const unitPrice = bounded(1n, 100n);
export const totalPrice = bounded(1n, 10000n);
export const inventory = object({
  crystal: bounded(0n, 1000n),
  wood: bounded(0n, 1000n),
  herb: bounded(0n, 1000n),
  iron: bounded(0n, 1000n),
});
export const listing = object({
  merchant_id: merchantId,
  resource: resourceId,
  unit_price: unitPrice,
  quantity: bounded(0n, 100n),
  active: boolean,
  version: positiveU64,
});
export const lastAction = object({
  action_id: positiveU64,
  method: choice([
    "set_listing",
    "propose_trade",
    "accept_trade",
    "cancel_trade",
  ] as const),
  args_sha256: (value: unknown) => {
    check(
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
      "invalid argument digest",
    );
    return value;
  },
  market_revision: positiveU64,
  offer_id: nullable(positiveU64),
  trade_id: nullable(positiveU64),
  listing_version: nullable(positiveU64),
});
export const player = object({
  account_id: accountId,
  gold: bounded(0n, 1000000n),
  inventory,
});
const merchantShape = object({
  merchant_id: merchantId,
  controller_account_id: accountId,
  gold: bounded(0n, 1000000n),
  inventory,
  listings: array(listing, 4),
  last_action_id: parseU64,
  last_action: nullable(lastAction),
});
export function merchant(value: unknown): ReturnType<typeof merchantShape> {
  const result = merchantShape(value);
  check(
    result.listings.length === 4 &&
      result.listings.every(
        (row, index) =>
          row.merchant_id === result.merchant_id &&
          row.resource === resourceIds[index],
      ),
    "invalid merchant listings",
  );
  check(
    result.last_action === null
      ? result.last_action_id === "0"
      : result.last_action.action_id === result.last_action_id,
    "action sequence mismatch",
  );
  return result;
}

const offerShape = object({
  offer_id: positiveU64,
  proposer: merchantId,
  buyer: merchantId,
  seller: merchantId,
  counterparty: merchantId,
  resource: resourceId,
  quantity,
  unit_price: unitPrice,
  total_price: totalPrice,
  created_at_ns: parseU64,
  expires_at_ns: positiveU64,
  status: choice(["pending", "accepted", "cancelled", "expired"] as const),
  closed_at_ns: nullable(parseU64),
  settled_trade_id: nullable(positiveU64),
  proposal_action: object({ merchant_id: merchantId, action_id: positiveU64 }),
});
export function offer(value: unknown): ReturnType<typeof offerShape> {
  const result = offerShape(value);
  check(
    result.buyer !== result.seller &&
      [result.buyer, result.seller].includes(result.proposer) &&
      result.counterparty ===
        (result.proposer === result.buyer ? result.seller : result.buyer),
    "invalid stored offer roles",
  );
  check(
    BigInt(result.quantity) * BigInt(result.unit_price) ===
      BigInt(result.total_price),
    "invalid stored total",
  );
  check(
    result.proposal_action.merchant_id === result.proposer,
    "proposal action identity mismatch",
  );
  check(
    (result.status === "pending") === (result.closed_at_ns === null),
    "invalid close status",
  );
  check(
    (result.status === "accepted") === (result.settled_trade_id !== null),
    "invalid settlement status",
  );
  return result;
}

export type Actor =
  | { kind: "merchant"; merchant_id: ReturnType<typeof merchantId> }
  | { kind: "player"; account_id: string };
function actor(value: unknown): Actor {
  return record(value)["kind"] === "merchant"
    ? object({ kind: literal("merchant"), merchant_id: merchantId })(value)
    : object({ kind: literal("player"), account_id: accountId })(value);
}
const tradeShape = object({
  trade_id: positiveU64,
  kind: choice(["player_purchase", "merchant_trade"] as const),
  buyer: actor,
  seller: actor,
  resource: resourceId,
  quantity,
  unit_price: unitPrice,
  total_price: totalPrice,
  offer_id: nullable(positiveU64),
  buyer_gold_after: bounded(0n, 1000000n),
  seller_gold_after: bounded(0n, 1000000n),
  buyer_resource_after: bounded(0n, 1000n),
  seller_resource_after: bounded(0n, 1000n),
  settled_at_ns: parseU64,
  market_revision: positiveU64,
});
export function trade(value: unknown): ReturnType<typeof tradeShape> {
  const result = tradeShape(value);
  check(
    BigInt(result.quantity) * BigInt(result.unit_price) ===
      BigInt(result.total_price),
    "invalid trade total",
  );
  check(result.seller.kind === "merchant", "invalid trade seller");
  check(
    result.kind === "player_purchase"
      ? result.buyer.kind === "player" && result.offer_id === null
      : result.buyer.kind === "merchant" && result.offer_id !== null,
    "invalid trade kind/actors",
  );
  return result;
}
export type OfferLookup =
  | { kind: "found"; offer: ReturnType<typeof offer> }
  | { kind: "pruned" | "not_found"; offer_id: U64 };
export function offerLookup(value: unknown): OfferLookup {
  return record(value)["kind"] === "found"
    ? object({ kind: literal("found"), offer })(value)
    : object({
        kind: choice(["pruned", "not_found"] as const),
        offer_id: positiveU64,
      })(value);
}
export function page<T>(decode: Decoder<T>): Decoder<{
  items: T[];
  next_after_id: U64 | null;
  has_more: boolean;
  history_gap: boolean;
  pruned_through: U64;
}> {
  return object({
    items: array(decode, 50),
    next_after_id: nullable(parseU64),
    has_more: boolean,
    history_gap: boolean,
    pruned_through: parseU64,
  });
}
export function snapshot<T>(decode: Decoder<T>): Decoder<{
  market_revision: U64;
  block_height: U64;
  block_timestamp_ns: U64;
  data: T;
}> {
  return object({
    market_revision: positiveU64,
    block_height: positiveU64,
    block_timestamp_ns: parseU64,
    data: decode,
  });
}
export const market = object({
  api_version: literal("1.0.0"),
  economy_version: literal("1"),
  contract_account_id: accountId,
  owner_account_id: accountId,
  paused: boolean,
  registered_player_count: bounded(0n, 1000n),
  total_issued_gold: bounded(550n, 100550n),
  resource_supply: inventory,
  merchants: array(merchant, 3),
  next_offer_id: positiveU64,
  next_trade_id: positiveU64,
  offers_pruned_through: parseU64,
  trades_pruned_through: parseU64,
  limits: object({
    max_players: parseU64,
    starter_gold: parseU64,
    max_actor_gold: parseU64,
    max_actor_resource: parseU64,
    max_trade_quantity: parseU64,
    max_listing_quantity: parseU64,
    max_unit_price: parseU64,
    max_total_price: parseU64,
    max_pending_offers_per_merchant: parseU64,
    max_offer_lifetime_ns: parseU64,
    max_page_size: parseU64,
    retained_trade_limit: parseU64,
    retained_terminal_offer_limit: parseU64,
    max_expire_batch: parseU64,
  }),
});
export type Snapshot<T> = ReturnType<ReturnType<typeof snapshot<T>>>;
export type MarketState = ReturnType<typeof market>;
export type Merchant = ReturnType<typeof merchant>;
export type Player = ReturnType<typeof player>;
export type Offer = ReturnType<typeof offer>;
export type Trade = ReturnType<typeof trade>;
export type Page<T> = ReturnType<ReturnType<typeof page<T>>>;
