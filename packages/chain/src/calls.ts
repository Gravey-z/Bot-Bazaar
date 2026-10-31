import {
  array,
  boolean,
  bounded,
  check,
  listing,
  lastAction,
  merchantId,
  object,
  offer,
  player,
  positiveU64,
  quantity,
  resourceId,
  snapshot,
  totalPrice,
  trade,
  unitPrice,
} from "./wire.js";

const offerAction = object({ offer_id: positiveU64, action_id: positiveU64 });
export const callArguments = {
  register_player: object({}),
  buy_from_merchant: object({
    merchant_id: merchantId,
    resource: resourceId,
    quantity,
    max_total_price: totalPrice,
    listing_version: positiveU64,
  }),
  set_listing: object({
    merchant_id: merchantId,
    resource: resourceId,
    unit_price: unitPrice,
    quantity: bounded(0n, 100n),
    active: boolean,
    expected_version: positiveU64,
    action_id: positiveU64,
  }),
  propose_trade: object({
    proposer: merchantId,
    buyer: merchantId,
    seller: merchantId,
    resource: resourceId,
    quantity,
    total_price: totalPrice,
    expires_at_ns: positiveU64,
    action_id: positiveU64,
  }),
  accept_trade: offerAction,
  cancel_trade: offerAction,
  expire_offers: object({ offer_ids: array(positiveU64, 24) }),
  pause_market: object({}),
  resume_market: object({}),
};
export const callResults = {
  register_player: snapshot(player),
  buy_from_merchant: snapshot(trade),
  set_listing: snapshot(object({ listing, action: lastAction })),
  propose_trade: snapshot(object({ offer, action: lastAction })),
  accept_trade: snapshot(object({ offer, trade, action: lastAction })),
  cancel_trade: snapshot(object({ offer, action: lastAction })),
  expire_offers: snapshot(
    object({
      expired_offer_ids: array(positiveU64, 24),
      ignored_offer_ids: array(positiveU64, 24),
    }),
  ),
  pause_market: snapshot(object({ paused: boolean, changed: boolean })),
  resume_market: snapshot(object({ paused: boolean, changed: boolean })),
};
export type CallMethod = keyof typeof callArguments;
export type CallArgs<M extends CallMethod> = ReturnType<
  (typeof callArguments)[M]
>;
type WireInput<T> = T extends import("./wire.js").U64
  ? string
  : T extends readonly (infer Item)[]
    ? WireInput<Item>[]
    : T extends object
      ? { [K in keyof T]: WireInput<T[K]> }
      : T;
export type CallInput<M extends CallMethod> = WireInput<CallArgs<M>>;
export type CallResult<M extends CallMethod> = ReturnType<
  (typeof callResults)[M]
>;
export type MarketCall = {
  [M in CallMethod]: { method: M; args: CallArgs<M> };
}[CallMethod];

export function createMarketCall<M extends CallMethod>(
  method: M,
  value: unknown,
): { method: M; args: CallArgs<M>; deposit: "0" } {
  check(Object.hasOwn(callArguments, method), "unknown contract mutation");
  const args = callArguments[method](value);
  if (method === "set_listing") {
    const args = callArguments.set_listing(value);
    check(
      args.active ? args.quantity !== "0" : args.quantity === "0",
      "invalid listing activation quantity",
    );
  }
  if (method === "propose_trade") {
    const args = callArguments.propose_trade(value);
    check(
      args.buyer !== args.seller &&
        [args.buyer, args.seller].includes(args.proposer),
      "invalid proposed roles",
    );
    const count = BigInt(args.quantity),
      total = BigInt(args.total_price);
    check(
      total % count === 0n && total / count >= 1n && total / count <= 100n,
      "invalid exact total",
    );
  }
  if (method === "expire_offers") {
    const args = callArguments.expire_offers(value);
    check(
      args.offer_ids.length > 0 &&
        new Set(args.offer_ids).size === args.offer_ids.length,
      "invalid cleanup batch",
    );
  }
  return { method, args: args as CallArgs<M>, deposit: "0" };
}

export function decodeCallResult<M extends CallMethod>(
  method: M,
  value: unknown,
): CallResult<M> {
  check(Object.hasOwn(callResults, method), "unknown contract mutation");
  return callResults[method](value) as CallResult<M>;
}
