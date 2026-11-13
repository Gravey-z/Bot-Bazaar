import {
  parseU64,
  livingTownSnapshot,
  livingTownTown,
  createLivingTownCall,
  livingTownOffer,
} from "@bot-bazaar/chain";
import {
  negotiationAvailable,
  assertNegotiationActor,
  compileSellerTradeApproval,
} from "./negotiation.js";
import type { SellerTradeApproval, SellerTradeStep } from "./negotiation.js";
import { requireStorage } from "../storage/validation.js";
import type {
  MerchantAction,
  MerchantPolicyInput,
  LivingTownMerchantPolicy,
} from "./merchant-policy.js";
import type { TownCall } from "./town-chain.js";
const names = ["rex", "luna", "bolt"] as const;
export type ProposalMerchant = (typeof names)[number];
const items = [
  "crystal",
  "wood",
  "herb",
  "iron",
  "health_potion",
  "iron_tool",
] as const;
export type TownProposal = {
  schema: "living-town-proposal-v1";
  tick_id: string;
  market_revision: string;
  merchant_id: ProposalMerchant;
  reason: string;
  action:
    | { type: "wait" }
    | { type: "adjust_price"; item_id: string; unit_price: string }
    | { type: "restock"; item_id: string }
    | {
    type: "start_production";
    recipe_id: "iron_tool";
    quantity: "1";
  }
| {
    type: "complete_production";
    job_id: string;
  }
| {
    type: "set_listing";
    item_id: string;
    quantity: string;
    unit_price: string;
    reserve_quantity: string;
  }
    | {
        type: "propose_trade";
        counterparty: ProposalMerchant;
        side: "buy" | "sell";
        item_id: string;
        quantity: string;
        unit_price: string;
      }
    | {
        type: "accept_trade";
        offer_id: string;
        expected_offer_revision: string;
      }
    | { type: "reject_trade"; offer_id: string };
};
function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireStorage(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "invalid proposal object",
  );
  const d = Object.getOwnPropertyDescriptors(value);
  requireStorage(
    Reflect.ownKeys(value).length === keys.length &&
      keys.every(
        (k) =>
          Object.hasOwn(d, k) &&
          d[k]!.enumerable &&
          Object.hasOwn(d[k]!, "value"),
      ),
    "invalid proposal fields",
  );
  return value as Record<string, unknown>;
}
function decimal(value: unknown, max = 18446744073709551615n): string {
  const s = parseU64(value);
  requireStorage(
    BigInt(s) > 0n && BigInt(s) <= max,
    "proposal integer outside bounds",
  );
  return s;
}
function listingQuantity(value: unknown): string {
  const parsed = parseU64(value);
  requireStorage(
    BigInt(parsed) <= 100n,
    "listing quantity exceeds limit",
  );
  return parsed;
}
function member<T extends string>(v: unknown, values: readonly T[]): T {
  requireStorage(values.includes(v as T), "unsupported proposal value");
  return v as T;
}
export function parseTownProposal(value: unknown): TownProposal {
  const p = obj(value, [
    "schema",
    "tick_id",
    "market_revision",
    "merchant_id",
    "reason",
    "action",
  ]);
  requireStorage(
    p["schema"] === "living-town-proposal-v1" &&
      typeof p["tick_id"] === "string" &&
      /^[a-f0-9]{64}$/.test(p["tick_id"]),
    "invalid proposal version/tick",
  );
  requireStorage(
    typeof p["reason"] === "string" && /^[\x20-\x7e]{1,240}$/.test(p["reason"]),
    "invalid proposal reason",
  );
  const raw = p["action"],
    type =
      raw && typeof raw === "object"
        ? Object.getOwnPropertyDescriptor(raw, "type")?.value
        : undefined;
  let action: TownProposal["action"];
  if (type === "wait") {
    obj(raw, ["type"]);
    action = { type };
  } else if (type === "adjust_price") {
    const a = obj(raw, ["type", "item_id", "unit_price"]);
    action = {
      type,
      item_id: member(a["item_id"], items),
      unit_price: decimal(a["unit_price"], 100n),
    };
  } else if (type === "restock") {
    const a = obj(raw, ["type", "item_id"]);
    action = { type, item_id: member(a["item_id"], items) };
    } else if (type === "set_listing") {
  const a = obj(raw, [
    "type",
    "item_id",
    "quantity",
    "unit_price",
    "reserve_quantity",
  ]);

  action = {
    type,
    item_id: member(a["item_id"], [
      "crystal", "wood", "herb", "iron",
    ]),
    quantity: listingQuantity(a["quantity"]),
    unit_price: decimal(a["unit_price"], 100n),
    reserve_quantity: listingQuantity(
      a["reserve_quantity"],
    ),
  };
  } else if (type === "start_production") {
  const a = obj(raw, [
    "type",
    "recipe_id",
    "quantity",
  ]);

  requireStorage(
    a["recipe_id"] === "iron_tool" &&
      a["quantity"] === "1",
    "unsupported production recipe",
  );

  action = {
    type: "start_production",
    recipe_id: "iron_tool",
    quantity: "1",
  };
} else if (type === "complete_production") {
  const a = obj(raw, ["type", "job_id"]);

  action = {
    type: "complete_production",
    job_id: decimal(a["job_id"]),
  };
  } else if (type === "propose_trade") {
    const a = obj(raw, [
      "type",
      "counterparty",
      "side",
      "item_id",
      "quantity",
      "unit_price",
    ]);
    action = {
      type,
      counterparty: member(a["counterparty"], names),
      side: member(a["side"], ["buy", "sell"]),
      item_id: member(a["item_id"], items),
      quantity: decimal(a["quantity"], 100n),
      unit_price: decimal(a["unit_price"], 100n),
    };
    requireStorage(
      action.counterparty !== p["merchant_id"],
      "self trade proposal",
    );
  } else if (type === "accept_trade") {
    const a = obj(raw, ["type", "offer_id", "expected_offer_revision"]);
    action = {
      type,
      offer_id: decimal(a["offer_id"]),
      expected_offer_revision: decimal(a["expected_offer_revision"]),
    };
  } else if (type === "reject_trade") {
    const a = obj(raw, ["type", "offer_id"]);
    action = { type, offer_id: decimal(a["offer_id"]) };
  } else throw new Error("unsupported town proposal action");
  return {
    schema: "living-town-proposal-v1",
    tick_id: p["tick_id"] as string,
    market_revision: decimal(p["market_revision"]),
    merchant_id: member(p["merchant_id"], names),
    reason: p["reason"],
    action,
  };
}
const schemaObject = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const integer = {
  type: "string",
  pattern: "^[1-9][0-9]{0,19}$(?![\\s\\S])",
  maxLength: 20,
};
const enumItem = { type: "string", enum: items },
  enumMerchant = { type: "string", enum: names };
export const townProposalSchema = schemaObject({
  schema: { const: "living-town-proposal-v1" },
  tick_id: { type: "string", pattern: "^[a-f0-9]{64}$(?![\\s\\S])" },
  market_revision: integer,
  merchant_id: enumMerchant,
  reason: {
    type: "string",
    minLength: 1,
    maxLength: 240,
    pattern: "^[ -~]+$(?![\\s\\S])",
  },
  action: {
    oneOf: [
      schemaObject({ type: { const: "wait" } }),
      schemaObject({
        type: { const: "adjust_price" },
        item_id: enumItem,
        unit_price: integer,
      }),
      schemaObject({ type: { const: "restock" }, item_id: enumItem }),
      schemaObject({
  type: { const: "start_production" },
  recipe_id: { const: "iron_tool" },
  quantity: { const: "1" },
}),
schemaObject({
  type: { const: "complete_production" },
  job_id: integer,
}),
schemaObject({
  type: { const: "set_listing" },
  item_id: {
    type: "string",
    enum: ["crystal", "wood", "herb", "iron"],
  },
  quantity: {
    type: "string",
    pattern: "^(0|[1-9][0-9]{0,2})$(?![\\s\\S])",
  },
  unit_price: integer,
  reserve_quantity: {
    type: "string",
    pattern: "^(0|[1-9][0-9]{0,2})$(?![\\s\\S])",
  },
}),
      schemaObject({
        type: { const: "propose_trade" },
        counterparty: enumMerchant,
        side: { enum: ["buy", "sell"] },
        item_id: enumItem,
        quantity: integer,
        unit_price: integer,
      }),
      schemaObject({
        type: { const: "accept_trade" },
        offer_id: integer,
        expected_offer_revision: integer,
      }),
      schemaObject({ type: { const: "reject_trade" }, offer_id: integer }),
    ],
  },
});
export interface ProposalResolution {
  kind: "command" | "no_op";
  reason: string;
  proposal: TownProposal;
  call: TownCall | null;
  tradeApproval?: SellerTradeApproval;
  tradePhase?: SellerTradeStep["phase"];
}
/** Strict local policy gate. Model JSON never names a chain method or supplies a command identity. */
export function resolveTownProposal(
  value: unknown,
  input: MerchantPolicyInput,
  tickId: string,
  merchant: ProposalMerchant,
  policy: LivingTownMerchantPolicy,
  identity: unknown,
  command: unknown,
  offerExpiryNs?: string,
): ProposalResolution {
  const proposal = parseTownProposal(value),
    town = livingTownSnapshot(livingTownTown)(input.town);
  requireStorage(
    proposal.tick_id === tickId &&
      proposal.merchant_id === merchant &&
      proposal.market_revision === town.market_revision,
    "stale proposal tick/actor/revision",
  );
  const signals = policy.evaluate(input),
    a = proposal.action;
  const no = (reason: string): ProposalResolution => ({
    kind: "no_op",
    reason,
    proposal,
    call: null,
  });
  if (!input.fresh || !input.historyComplete)
    return no("confirmed_facts_unavailable");
  if (a.type === "wait") return no("model_wait");
  if (["propose_trade", "accept_trade", "reject_trade"].includes(a.type)) {
    if (!negotiationAvailable(input)) return no("negotiation_unavailable");
    assertNegotiationActor(input, merchant, identity);
    if (a.type === "propose_trade") {
      requireStorage(
        a.side === "buy",
        "only buyer-initiated raw trades supported",
      );
      const candidate = signals.stockSharing?.candidates.find(
        (c) =>
          c.buyer === merchant &&
          c.seller === a.counterparty &&
          c.item === a.item_id,
      );
      requireStorage(candidate, "no eligible supplier for model trade");
      const compiled = policy.compileStockSharingProposal(
        input,
        merchant,
        {
          candidateId: candidate.id,
          quantity: a.quantity,
          unitPrice: a.unit_price,
        },
        identity,
        command,
        offerExpiryNs,
      );
      requireStorage(compiled, "buyer proposal unavailable");
      return {
        kind: "command",
        reason: "validated_buyer_trade_proposal",
        proposal,
        call: compiled.call,
      };
    }
    requireStorage(
      a.type === "accept_trade" || a.type === "reject_trade",
      "unsupported trade action",
    );
    const offer = (input.pendingOffers ?? [])
      .map(livingTownOffer)
      .find((o) => o.offer_id === a.offer_id);
    requireStorage(
      offer?.seller === merchant,
      "offer is not an incoming seller offer",
    );
    if (a.type === "reject_trade") {
      // Recipient refusal remains possible when an economic opportunity disappeared.
      const call = createLivingTownCall("reject_trade", {
        merchant_id: merchant,
        offer_id: offer.offer_id,
        expected_offer_revision: offer.revision,
        command,
      });
      requireStorage(
        call.args.command.config_version === town.deployment.config_version &&
          BigInt(call.args.command.valid_until_ns) >
            BigInt(town.block_timestamp_ns) &&
          BigInt(call.args.command.valid_until_ns) <=
            BigInt(town.block_timestamp_ns) + 600000000000n,
        "seller command outside lifetime",
      );
      return {
        kind: "command",
        reason: "independent_seller_rejection",
        proposal,
        call,
      };
    }
    const step = compileSellerTradeApproval(
      input,
      { proposal, offer, rootId: input.stockSharingReaction!.id },
      policy,
      identity,
      command,
    );
    return {
      kind: "command",
      reason: step.phase,
      proposal,
      call: step.call,
      tradeApproval: step.approval,
      tradePhase: step.phase,
    };
  }
  if (
  a.type === "start_production" ||
  a.type === "complete_production"
) {
  requireStorage(
    merchant === "bolt",
    "only Bolt may produce iron tools",
  );

  const compiled = policy.compileAiProduction(
    input,
    merchant,
    a,
    identity,
    command,
  );

  requireStorage(
    compiled !== null,
    "production command unavailable",
  );

  return {
    kind: "command",
    reason:
      a.type === "start_production"
        ? "validated_ai_production_start"
        : "validated_ai_production_completion",
    proposal,
    call: compiled.call,
  };
}
  const step = signals.decisions.find((d) => d.merchant === merchant)!.action;
  if (a.type === "set_listing") {
  requireStorage(!town.data.paused, "town paused");

  const row = input.merchants.find(
    (m) =>
      (m.shop as {
        data: {
          owner: { merchant_id?: string };
        };
      }).data.owner.merchant_id === merchant,
  );

  requireStorage(row, "merchant shop missing");

  const shop = row.shop as {
    data: { shop_id: string };
  };

  const listing = row.listings.find(
    (l) =>
      (l as { item_id: string }).item_id === a.item_id,
  ) as
    | {
        remaining_quantity: string;
        unit_price: string;
        revision: string;
      }
    | undefined;

  const ledger = town.data.npc_ledgers.find(
    (l) =>
      l.actor.kind === "merchant" &&
      l.actor.merchant_id === merchant,
  );

  requireStorage(ledger, "merchant ledger missing");

  const item = a.item_id as
    "crystal" | "wood" | "herb" | "iron";

  const held = BigInt(ledger.inventory.held[item]);
  const tradeReserved = BigInt(
    ledger.inventory.trade_reserved[item],
  );

  const quantity = BigInt(a.quantity);
  const reserve = BigInt(a.reserve_quantity);
  const saleable = held - tradeReserved;

  requireStorage(
    saleable >= 0n &&
      quantity + reserve <= saleable,
    "listing exceeds available inventory",
  );

  // Preserve the configured supplier safety floor.
  const supplierSignal = signals.scarcity.find(
    (s) =>
      s.item === item &&
      s.supplier === merchant,
  );

  const minimumReserve = supplierSignal
    ? BigInt(supplierSignal.floor)
    : 0n;

  requireStorage(
    saleable - quantity >= minimumReserve,
    "listing violates supplier reserve",
  );

  // A running job is authoritative. A deterministic preference to craft
  // cannot override an AI decision to release or reserve listed materials.
  requireStorage(row.job === null, "running production job");

  const pricing = signals.pricing.find(
    (p) =>
      p.merchant === merchant &&
      p.item === item,
  );

  requireStorage(
    pricing !== undefined,
    "listing price policy unavailable",
  );

  const price = BigInt(a.unit_price);

  requireStorage(
    price >= BigInt(pricing.minPrice) &&
      price <= BigInt(pricing.maxPrice),
    "listing price outside allowed range",
  );

  if (listing && listing.unit_price !== a.unit_price) {
    const previous = BigInt(listing.unit_price);
    const difference =
      price > previous
        ? price - previous
        : previous - price;

    requireStorage(
      difference <= 1n,
      "price change exceeds one gold",
    );

    requireStorage(
      pricing.cooldownUntilNs === null ||
        BigInt(town.block_timestamp_ns) >=
          BigInt(pricing.cooldownUntilNs),
      "price cooldown active",
    );
  }

  if (
    listing?.remaining_quantity === a.quantity &&
    listing.unit_price === a.unit_price
  ) {
    return no("listing_unchanged");
  }

  if (!listing && quantity === 0n) {
    return no("empty_new_listing");
  }

  // Reuse the established policy compiler's
  // identity and deployment verification.
  policy.compile(
    input,
    merchant,
    step,
    identity,
    command,
  );

  const call = createLivingTownCall("set_listing", {
    shop_id: shop.data.shop_id,
    item_id: item,
    quantity: a.quantity,
    unit_price: a.unit_price,
    expected_listing_revision:
      listing?.revision ?? null,
    command,
  });

  requireStorage(
    call.args.command.config_version ===
      town.deployment.config_version &&
      BigInt(call.args.command.valid_until_ns) >
        BigInt(town.block_timestamp_ns) &&
      BigInt(call.args.command.valid_until_ns) <=
        BigInt(town.block_timestamp_ns) +
          120000000000n,
    "listing command outside lifetime",
  );

  return {
    kind: "command",
    reason: "validated_ai_listing",
    proposal,
    call,
  };
}
  // Historical deterministic restock proposals remain parseable for replay,
  // but cannot authorize a new listing, purchase or production transaction.
  if (a.type === "restock") return no("automatic_restock_disabled");
  if (a.type !== "adjust_price") return no("unsupported_action");
  if (town.data.paused) return no("paused");
  const row = input.merchants.find(
    (r) =>
      (r.shop as { data: { owner: { merchant_id?: string } } }).data.owner
        .merchant_id === merchant,
  )!;
    const l = row.listings.find(
    (v) => (v as { item_id: string }).item_id === a.item_id,
  ) as
    | {
        shop_id: string;
        item_id: string;
        remaining_quantity: string;
        unit_price: string;
        revision: string;
      }
    | undefined;
  const signal = signals.scarcity.find(
    (s) => s.item === a.item_id,
  );
  const ledger = town.data.npc_ledgers.find(l => l.actor.kind === "merchant" && l.actor.merchant_id === merchant)!;
  const saleable = signal ? BigInt(ledger.inventory.held[signal.item]) -
    BigInt(ledger.inventory.trade_reserved[signal.item]) : 0n;
  requireStorage(
    l && signal && BigInt(l.remaining_quantity) <= saleable,
    "unavailable owned price listing/reserve",
  );
  const bands: Record<string, readonly [bigint, bigint]> = {
    crystal: [merchant === "rex" ? 4n : 3n, 6n],
    herb: [merchant === "luna" ? 3n : 2n, 4n],
    wood: [1n, 3n],
    iron: [3n, 6n],
  };
  const price = BigInt(a.unit_price),
    band = bands[a.item_id]!;
  requireStorage(
    price >= band[0] && price <= band[1],
    "merchant price/cost band violated",
  );
  
  const pricing = signals.pricing.find(
    (p) => p.merchant === merchant && p.item === a.item_id,
  );

  requireStorage(
    l !== undefined && pricing !== undefined,
    "price context unavailable",
  );

  const currentPrice = BigInt(l.unit_price);
  const proposedPrice = BigInt(a.unit_price);

  requireStorage(
    proposedPrice !== currentPrice,
    "price unchanged",
  );

  // AI can increase or decrease by at most 1 gold.
  const difference =
    proposedPrice > currentPrice
      ? proposedPrice - currentPrice
      : currentPrice - proposedPrice;

  requireStorage(
    difference <= 1n,
    "price change exceeds one gold",
  );

  // Keep the existing three-minute cooldown.
  requireStorage(
    pricing.cooldownUntilNs === null ||
      BigInt(town.block_timestamp_ns) >=
        BigInt(pricing.cooldownUntilNs),
    "price cooldown active",
  );

  // Reuse the audited controller compiler for actor identity, then bind the reviewed price-only replacement.
  const reference: MerchantAction = step;
  policy.compile(input, merchant, reference, identity, command);
  const call = createLivingTownCall("set_listing", {
    shop_id: l.shop_id,
    item_id: l.item_id,
    quantity: l.remaining_quantity,
    unit_price: a.unit_price,
    expected_listing_revision: l.revision,
    command,
  });
  requireStorage(
    BigInt(call.args.command.valid_until_ns) >
      BigInt(town.block_timestamp_ns) &&
      BigInt(call.args.command.valid_until_ns) <=
        (input.stockSharingReaction
          ? BigInt(town.block_timestamp_ns) + 60000000000n
          : BigInt(town.data.genesis_time_ns) +
            (BigInt(town.data.epoch) + 1n) * 60000000000n),
    "proposal command outside epoch",
  );
  return {
    kind: "command",
    reason: "validated_price_adjustment",
    proposal,
    call,
  };
}

export interface TownProposalContext {
  purpose?: "trading" | "pricing";
  reaction?: { rootId: string; stepId: string };
  tickId: string;
  merchant: ProposalMerchant;
  facts: MerchantPolicyInput;
  schemaVersion: "living-town-proposal-v1";
}
const deliveries = new WeakSet<object>();
/** Trusted adapter wrapper; raw model JSON cannot attach its own origin/accounting identity. */
export class TownProposalDelivery {
  readonly proposal: TownProposal;
  constructor(
    proposal: unknown,
    readonly origin: "rules" | "model_proposal",
    readonly inferenceRef: string,
  ) {
    this.proposal = parseTownProposal(proposal);
    requireStorage(
      ["rules", "model_proposal"].includes(origin) &&
        /^[a-zA-Z0-9:_.-]{1,128}$/.test(inferenceRef),
      "invalid proposal delivery",
    );
    deliveries.add(this);
    Object.freeze(this);
  }
}
export function isTownProposalDelivery(
  value: unknown,
): value is TownProposalDelivery {
  return !!value && typeof value === "object" && deliveries.has(value);
}
export function rulesTownProposal(
  context: TownProposalContext,
  _policy: LivingTownMerchantPolicy,
  reason = "AI unavailable; no automatic business decision",
  _wait = false,
): TownProposal {
  const town = livingTownSnapshot(livingTownTown)(context.facts.town);
  return parseTownProposal({
    schema: "living-town-proposal-v1",
    tick_id: context.tickId,
    market_revision: town.market_revision,
    merchant_id: context.merchant,
    reason,
    // The fallback must never select an economic action without AI consent.
    action: { type: "wait" },
  });
}
