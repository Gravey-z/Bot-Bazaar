import type { MerchantId, Resource, Merchant, Offer } from "@bot-bazaar/chain";
import { parseDecisionAction } from "../decisions/schema.js";
import type { DecisionAction } from "../decisions/schema.js";
import type { DiscoveryState } from "../discovery/types.js";
import { profiles, rexShortageSaleBand } from "../prompts/profiles.js";
import { StorageError } from "../storage/validation.js";
export class PolicyError extends StorageError {
  constructor(readonly code: string) {
    super(`Merchant policy: ${code}`);
    this.name = "PolicyError";
  }
}
function requirePolicy(value: unknown, code: string): asserts value {
  if (!value) throw new PolicyError(code);
}
export interface TradeTerms {
  buyer: MerchantId;
  seller: MerchantId;
  resource: Resource;
  quantity: string;
  total_price: string;
  offerId: string | null;
}
export interface PolicyContext {
  state: DiscoveryState;
  merchantId: MerchantId;
  phase: "decision" | "followup";
  rootDeadline: number;
  rexShortageMode: boolean;
  mutationsRemaining: number;
  commitments: readonly TradeTerms[];
  rejectedOfferIds: readonly string[];
  changedResources: readonly Resource[];
  continuation?: boolean;
}
export type EconomicAction = Extract<DecisionAction, { args: unknown }>;
export interface PolicyResult {
  action: DecisionAction;
  preparations: EconomicAction[];
  requiredSlots: number;
  trade: TradeTerms | null;
}
const names = ["rex", "luna", "bolt"] as const;
type BuyRule = {
  below: string;
  target: string;
  price: readonly [string, string];
  maxQuantity: string;
};
function saleBand(
  name: MerchantId,
  resource: Resource,
  context: PolicyContext,
): readonly string[] {
  return name === "rex" &&
    resource === "crystal" &&
    (context.rexShortageMode ||
      BigInt(
        context.state.market.data.merchants.find(
          (m) => m.merchant_id === "rex",
        )!.inventory.crystal,
      ) < 5n)
    ? rexShortageSaleBand
    : profiles[name].sells[resource];
}
function inBand(price: bigint, band: readonly string[]): boolean {
  return price >= BigInt(band[0]!) && price <= BigInt(band[1]!);
}
function live(offer: Offer, c: PolicyContext, now: number): boolean {
  return (
    offer.status === "pending" &&
    BigInt(offer.expires_at_ns) >
      BigInt(
        Math.max(now, Number(BigInt(c.state.block.timestampNs) / 1000000n)),
      ) *
        1000000n
  );
}
function checkTrade(
  terms: TradeTerms,
  c: PolicyContext,
): { buyer: Merchant; seller: Merchant } {
  const buyer = c.state.market.data.merchants.find(
      (m) => m.merchant_id === terms.buyer,
    )!,
    seller = c.state.market.data.merchants.find(
      (m) => m.merchant_id === terms.seller,
    )!;
  requirePolicy(buyer && seller && buyer !== seller, "invalid_parties");
  const count = BigInt(terms.quantity),
    total = BigInt(terms.total_price),
    price = total / count;
  const rule = (
    profiles[terms.buyer].buys as Partial<Record<Resource, BuyRule>>
  )[terms.resource];
  requirePolicy(
    rule && BigInt(buyer.inventory[terms.resource]) < BigInt(rule.below),
    "purchase_trigger_unmet",
  );
  requirePolicy(
    inBand(price, rule.price) &&
      inBand(price, saleBand(terms.seller, terms.resource, c)),
    "price_outside_band",
  );
  requirePolicy(
    count <= BigInt(rule.maxQuantity) &&
      count <= BigInt(profiles[terms.seller].maxSaleQuantity) &&
      count <= BigInt(rule.target) - BigInt(buyer.inventory[terms.resource]),
    "quantity_outside_target",
  );
  requirePolicy(
    BigInt(buyer.gold) - total >= BigInt(profiles[terms.buyer].goldFloor),
    "gold_reserve",
  );
  requirePolicy(
    BigInt(seller.inventory[terms.resource]) - count >=
      BigInt(profiles[terms.seller].stockFloors[terms.resource]),
    "stock_reserve",
  );
  requirePolicy(
    c.commitments.every(
      (t) =>
        !(
          [t.buyer, t.seller].includes(terms.buyer) ||
          [t.buyer, t.seller].includes(terms.seller)
        ) ||
        (terms.offerId !== null &&
          t.offerId === terms.offerId &&
          JSON.stringify(t) === JSON.stringify(terms)),
    ),
    "competing_commitment",
  );
  requirePolicy(
    c.state.offers.every(
      (o) =>
        o.status !== "pending" ||
        o.offer_id === terms.offerId ||
        (![o.buyer, o.seller].includes(terms.buyer) &&
          ![o.buyer, o.seller].includes(terms.seller)),
    ),
    "competing_offer",
  );
  return { buyer, seller };
}
export function evaluateDecision(
  value: unknown,
  c: PolicyContext,
  now = Date.now(),
): PolicyResult {
  const action = parseDecisionAction(value),
    state = c.state,
    own = state.market.data.merchants.find(
      (m) => m.merchant_id === c.merchantId,
    );
  requirePolicy(own && names.includes(c.merchantId), "caller_identity");
  requirePolicy(
    !state.market.data.paused &&
      now >= state.observedAt &&
      now - state.observedAt <= 15000 &&
      c.rootDeadline > now,
    "stale_paused_or_expired",
  );
  requirePolicy(
    state.market.block_height === state.block.height &&
      state.market.block_timestamp_ns === state.block.timestampNs &&
      Math.abs(now - Number(BigInt(state.block.timestampNs) / 1000000n)) <=
        15000,
    "invalid_finalized_time",
  );
  if (action.method === "hold")
    return { action, preparations: [], requiredSlots: 0, trade: null };
  requirePolicy(
    c.phase !== "followup" || action.method === "set_listing",
    "followup_listing_only",
  );
  const incoming = state.offers
    .filter(
      (o) =>
        o.counterparty === c.merchantId &&
        live(o, c, now) &&
        !c.rejectedOfferIds.includes(o.offer_id),
    )
    .sort((a, b) =>
      BigInt(a.created_at_ns) !== BigInt(b.created_at_ns)
        ? BigInt(a.created_at_ns) < BigInt(b.created_at_ns)
          ? -1
          : 1
        : BigInt(a.offer_id) < BigInt(b.offer_id)
          ? -1
          : 1,
    );
  if (incoming.length && c.phase !== "followup")
    requirePolicy(
      (action.method === "accept_trade" &&
        action.args.offer_id === incoming[0]!.offer_id) ||
        (action.method === "reject_trade" &&
          action.offer_id === incoming[0]!.offer_id),
      "incoming_offer_priority",
    );
  if (action.method === "reject_trade") {
    requirePolicy(
      incoming[0]?.offer_id === action.offer_id,
      "offer_not_rejectable",
    );
    return { action, preparations: [], requiredSlots: 0, trade: null };
  }
  const expected = BigInt(own.last_action_id) + 1n;
  if (!c.continuation)
    requirePolicy(
      BigInt(action.args.action_id) === expected,
      "action_sequence",
    );
  const preparations: EconomicAction[] = [];
  let trade: TradeTerms | null = null;
  if (action.method === "set_listing") {
    const args = action.args,
      current = own.listings.find((l) => l.resource === args.resource)!;
    requirePolicy(args.merchant_id === c.merchantId, "caller_identity");
    requirePolicy(
      c.changedResources.includes(args.resource) || c.phase === "followup",
      "idle_repricing",
    );
    requirePolicy(current.version === args.expected_version, "stale_listing");
    requirePolicy(
      !args.active ||
        inBand(
          BigInt(args.unit_price),
          saleBand(c.merchantId, args.resource, c),
        ),
      "price_outside_band",
    );
    const committed = c.commitments
      .filter((t) => t.seller === c.merchantId && t.resource === args.resource)
      .reduce((sum, t) => sum + BigInt(t.quantity), 0n);
    requirePolicy(
      !args.active ||
        BigInt(args.quantity) + committed <=
          BigInt(own.inventory[args.resource]) -
            BigInt(profiles[c.merchantId].stockFloors[args.resource]),
      "stock_reserve",
    );
    requirePolicy(
      current.active !== args.active ||
        current.unit_price !== args.unit_price ||
        current.quantity !== args.quantity,
      "listing_noop",
    );
  } else {
    if (action.method === "propose_trade") {
      requirePolicy(action.args.proposer === c.merchantId, "caller_identity");
      const args = action.args,
        expiry = BigInt(args.expires_at_ns),
        time = BigInt(state.block.timestampNs);
      requirePolicy(
        expiry >= BigInt(now + 30000) * 1000000n &&
          expiry <= time + 120000000000n &&
          expiry <= BigInt(c.rootDeadline) * 1000000n &&
          expiry <=
            time + BigInt(state.market.data.limits.max_offer_lifetime_ns),
        "offer_lifetime",
      );
      trade = {
        buyer: args.buyer,
        seller: args.seller,
        resource: args.resource,
        quantity: args.quantity,
        total_price: args.total_price,
        offerId: null,
      };
      if (c.merchantId === args.buyer) {
        const listing = state.market.data.merchants
          .find((m) => m.merchant_id === args.seller)!
          .listings.find((l) => l.resource === args.resource)!;
        requirePolicy(
          listing.active &&
            BigInt(args.total_price) / BigInt(args.quantity) >=
              BigInt(listing.unit_price),
          "public_quote_required",
        );
      }
      for (const name of [args.buyer, args.seller])
        requirePolicy(
          state.offers.filter(
            (o) =>
              o.status === "pending" && (o.buyer === name || o.seller === name),
          ).length <
            Number(state.market.data.limits.max_pending_offers_per_merchant),
          "offer_rate_limit",
        );
    } else {
      const offer = state.offers.find(
        (o) => o.offer_id === action.args.offer_id,
      );
      requirePolicy(
        offer &&
          offer.counterparty === c.merchantId &&
          live(offer, c, now) &&
          !c.rejectedOfferIds.includes(offer.offer_id),
        "offer_unavailable",
      );
      requirePolicy(
        BigInt(offer.expires_at_ns) >= BigInt(now + 30000) * 1000000n,
        "acceptance_too_late",
      );
      trade = {
        buyer: offer.buyer,
        seller: offer.seller,
        resource: offer.resource,
        quantity: offer.quantity,
        total_price: offer.total_price,
        offerId: offer.offer_id,
      };
    }
    const { seller } = checkTrade(trade, c);
    if (c.merchantId === trade.seller) {
      const listing = seller.listings.find(
        (l) => l.resource === trade!.resource,
      )!;
      const available =
        BigInt(seller.inventory[trade.resource]) -
        BigInt(profiles[trade.seller].stockFloors[trade.resource]) -
        BigInt(trade.quantity);
      if (listing.active && BigInt(listing.quantity) > available)
        preparations.push({
          method: "set_listing",
          args: {
            merchant_id: c.merchantId,
            resource: trade.resource,
            unit_price: listing.unit_price,
            quantity: String(available) as typeof listing.quantity,
            active: available > 0n,
            expected_version: listing.version,
            action_id: String(expected) as typeof listing.version,
          },
        });
    }
    if (
      c.merchantId === "rex" &&
      trade.buyer === "rex" &&
      trade.resource === "crystal"
    ) {
      const listing = own.listings.find((l) => l.resource === "crystal")!;
      if (
        listing.active &&
        BigInt(listing.unit_price) < BigInt(rexShortageSaleBand[0])
      )
        preparations.push({
          method: "set_listing",
          args: {
            merchant_id: "rex",
            resource: "crystal",
            unit_price: listing.unit_price,
            quantity: "0" as typeof listing.quantity,
            active: false,
            expected_version: listing.version,
            action_id: String(expected) as typeof listing.version,
          },
        });
    }
  }
  const requiredSlots =
    preparations.length + 1 + (action.method === "propose_trade" ? 2 : 0);
  requirePolicy(c.mutationsRemaining >= requiredSlots, "reaction_capacity");
  return { action, preparations, requiredSlots, trade };
}
