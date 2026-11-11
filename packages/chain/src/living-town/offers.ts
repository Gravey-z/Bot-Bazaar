import {
  array,
  boolean,
  bounded,
  check,
  choice,
  literal,
  nullable,
  object,
  parseU64,
  positiveU64,
  record,
} from "../wire.js";
import { livingTownLedger, livingTownProductionEffectBase } from "./wire.js";
import { canonicalLivingTownJson } from "./json.js";

export const offerMerchants = ["rex", "luna", "bolt"] as const;
export const offerItems = ["crystal", "wood", "herb", "iron"] as const;
export const offerMerchant = choice(offerMerchants);
export const offerItem = choice(offerItems);
export const offerMethodNames = [
  "propose_trade",
  "accept_trade",
  "reject_trade",
  "cancel_trade",
  "expire_offers",
] as const;
export const isLivingTownOfferMethod = (
  v: string,
): v is (typeof offerMethodNames)[number] =>
  (offerMethodNames as readonly string[]).includes(v);
export const offerMaterialRules = {
  crystal: {
    supplier: "rex",
    floor: "2",
    target: "12",
    base_price: "4",
    min_price: "3",
    max_price: "6",
  },
  wood: {
    supplier: "bolt",
    floor: "2",
    target: "12",
    base_price: "2",
    min_price: "1",
    max_price: "3",
  },
  herb: {
    supplier: "luna",
    floor: "4",
    target: "12",
    base_price: "3",
    min_price: "2",
    max_price: "4",
  },
  iron: {
    supplier: "bolt",
    floor: "4",
    target: "12",
    base_price: "5",
    min_price: "3",
    max_price: "6",
  },
} as const;
const offerShape = object({
  offer_id: positiveU64,
  proposer: offerMerchant,
  buyer: offerMerchant,
  seller: offerMerchant,
  item_id: offerItem,
  quantity: bounded(1n, 2n),
  unit_price: bounded(1n, 6n),
  total_price: bounded(1n, 12n),
  created_at_ns: parseU64,
  expires_at_ns: positiveU64,
  status: choice([
    "pending",
    "accepted",
    "rejected",
    "cancelled",
    "expired",
  ] as const),
  expired: boolean,
  revision: bounded(1n, 2n),
  trade_id: nullable(positiveU64),
  proposal_command_sequence: positiveU64,
  closed_at_ns: nullable(parseU64),
  closing_principal: nullable(
    choice(["merchant:rex", "merchant:luna", "merchant:bolt"] as const),
  ),
  closing_command_sequence: nullable(positiveU64),
});
function decodeOffer(value: unknown) {
  const o = offerShape(value),
    cfg = offerMaterialRules[o.item_id],
    pending = o.status === "pending";
  check(
    o.proposer === o.buyer &&
      o.buyer !== o.seller &&
      (o.buyer === cfg.supplier) !== (o.seller === cfg.supplier),
    "offer participants/direction mismatch",
  );
  check(
    BigInt(o.unit_price) >= BigInt(cfg.min_price) &&
      BigInt(o.unit_price) <= BigInt(cfg.max_price) &&
      BigInt(o.total_price) === BigInt(o.quantity) * BigInt(o.unit_price),
    "offer price/total mismatch",
  );
  const ttl = BigInt(o.expires_at_ns) - BigInt(o.created_at_ns);
  check(ttl >= 60000000000n && ttl <= 600000000000n, "offer lifetime mismatch");
  check(
    o.revision === (pending ? "1" : "2") &&
      (o.trade_id !== null) === (o.status === "accepted"),
    "offer revision/trade mismatch",
  );
  check(
    pending
      ? o.closed_at_ns === null &&
          o.closing_principal === null &&
          o.closing_command_sequence === null
      : o.closed_at_ns !== null &&
          o.closing_principal !== null &&
          o.closing_command_sequence !== null,
    "offer closure metadata mismatch",
  );
  if (!pending) {
    const at = BigInt(o.closed_at_ns!);
    check(
      at >= BigInt(o.created_at_ns) &&
        (o.status === "expired"
          ? at >= BigInt(o.expires_at_ns)
          : at < BigInt(o.expires_at_ns)),
      "offer closure time mismatch",
    );
    check(
      o.expired === (o.status === "expired"),
      "terminal offer expiry mismatch",
    );
    const actor = o.closing_principal!.slice(9);
    check(
      o.status === "expired"
        ? [o.buyer, o.seller].includes(actor as typeof o.buyer)
        : actor === (o.status === "cancelled" ? o.buyer : o.seller),
      "offer closing authority mismatch",
    );
  }
  return o;
}
export type LivingTownOffer = ReturnType<typeof livingTownOffer>;
export function checkPendingOfferReservations(
  ledgers: ReturnType<typeof livingTownLedger>[],
  offers: LivingTownOffer[],
): void {
  check(
    offers.length <= 12 &&
      new Set(offers.map((o) => o.offer_id)).size === offers.length &&
      offers.every((o) => o.status === "pending"),
    "pending offer cardinality mismatch",
  );
  check(ledgers.length === 3, "three NPC ledgers required");
  for (const m of offerMerchants) {
    const owned = offers.filter((o) => o.buyer === m),
      l = livingTownLedger(ledgers[offerMerchants.indexOf(m)]);
    check(
      l.actor.kind === "merchant" &&
        l.actor.merchant_id === m &&
        offers.filter((o) => o.buyer === m || o.seller === m).length <= 8 &&
        BigInt(l.gold.trade_reserved) ===
          owned.reduce((s, o) => s + BigInt(o.total_price), 0n),
      "pending offer gold/count mismatch",
    );
    for (const item of [
      "crystal",
      "wood",
      "herb",
      "iron",
      "health_potion",
      "iron_tool",
    ] as const)
      check(
        BigInt(l.inventory.trade_inbound_reserved[item]) ===
          owned
            .filter((o) => o.item_id === item)
            .reduce((s, o) => s + BigInt(o.quantity), 0n),
        "pending offer item promises mismatch",
      );
  }
}
const merchantActor = object({
  kind: literal("merchant"),
  merchant_id: offerMerchant,
});
const nil = (v: unknown): null => {
  check(v === null, "expected null");
  return null;
};
function decodeMerchantTrade(value: unknown) {
  const t = object({
    trade_id: positiveU64,
    kind: literal("merchant_trade"),
    buyer: merchantActor,
    seller: merchantActor,
    customer_pool_id: nil,
    item_id: offerItem,
    quantity: bounded(1n, 2n),
    unit_price: bounded(1n, 6n),
    total_price: bounded(1n, 12n),
    listing_id: nil,
    offer_id: positiveU64,
    consumed_quantity: literal("0"),
    settled_at_ns: positiveU64,
    command_principal: choice([
      "merchant:rex",
      "merchant:luna",
      "merchant:bolt",
    ] as const),
    command_sequence: positiveU64,
    event_sequence: positiveU64,
  })(value);
  const cfg = offerMaterialRules[t.item_id];
  check(
    t.buyer.merchant_id !== t.seller.merchant_id &&
      (t.buyer.merchant_id === cfg.supplier) !==
        (t.seller.merchant_id === cfg.supplier) &&
      t.command_principal === `merchant:${t.seller.merchant_id}` &&
      BigInt(t.quantity) * BigInt(t.unit_price) === BigInt(t.total_price) &&
      BigInt(t.unit_price) >= BigInt(cfg.min_price) &&
      BigInt(t.unit_price) <= BigInt(cfg.max_price),
    "merchant settlement terms/authority mismatch",
  );
  return t;
}
function decodeOfferOutcome(value: unknown) {
  const k = record(value)["kind"];
  if (k === "offers_expired")
    return object({
      kind: literal("offers_expired"),
      offers: array(livingTownOffer, 12),
      skipped_offer_ids: array(positiveU64, 24),
      ledgers: array(livingTownLedger, 3),
    })(value);
  if (k === "trade_accepted")
    return object({
      kind: literal("trade_accepted"),
      offer: livingTownOffer,
      trade: livingTownMerchantTrade,
      buyer: livingTownLedger,
      seller: livingTownLedger,
    })(value);
  return object({
    kind: choice([
      "trade_proposed",
      "trade_rejected",
      "trade_cancelled",
    ] as const),
    offer: livingTownOffer,
    buyer: livingTownLedger,
  })(value);
}
function decodeOfferEffect(value: unknown) {
  const base = livingTownProductionEffectBase(value),
    o = livingTownOfferOutcome(base.outcome);
  const r = { ...base, outcome: o };
  check(
    /^merchant:(rex|luna|bolt)$/.test(base.principal),
    "offer effect merchant principal required",
  );
  check(
    base.effect_revision === base.effect_event_sequence,
    "offer effect revision mismatch",
  );
  if (o.kind === "offers_expired") {
    const ids = o.offers.map((v) => v.offer_id),
      skipped = o.skipped_offer_ids;
    check(
      new Set([...ids, ...skipped]).size === ids.length + skipped.length &&
        ids.length + skipped.length <= 24,
      "expiry IDs duplicated/oversized",
    );
    for (const list of [ids, skipped])
      check(
        list.every((v, i) => i === 0 || BigInt(list[i - 1]!) < BigInt(v)),
        "expiry IDs unordered",
      );
    const buyers = new Set(o.offers.map((v) => v.buyer));
    check(
      o.ledgers.length === buyers.size &&
        new Set(o.ledgers.map((l) => canonicalLivingTownJson(l.actor))).size ===
          o.ledgers.length,
      "expiry ledger cardinality mismatch",
    );
    let previous = -1;
    for (const l of o.ledgers) {
      check(
        l.actor.kind === "merchant" && buyers.has(l.actor.merchant_id),
        "expiry buyer mismatch",
      );
      const i = offerMerchants.indexOf(l.actor.merchant_id);
      check(i > previous, "expiry ledgers unordered");
      previous = i;
    }
    for (const v of o.offers)
      check(
        v.status === "expired" &&
          v.closing_principal === base.principal &&
          v.closing_command_sequence === base.command_sequence,
        "expiry closing identity mismatch",
      );
  } else {
    const v = o.offer;
    check(
      o.buyer.actor.kind === "merchant" &&
        o.buyer.actor.merchant_id === v.buyer,
      "offer buyer ledger mismatch",
    );
    if (o.kind === "trade_proposed")
      check(
        v.status === "pending" &&
          !v.expired &&
          base.principal === `merchant:${v.buyer}` &&
          base.command_sequence === v.proposal_command_sequence &&
          BigInt(o.buyer.gold.trade_reserved) >= BigInt(v.total_price) &&
          BigInt(o.buyer.inventory.trade_inbound_reserved[v.item_id]) >=
            BigInt(v.quantity),
        "proposal reservation/identity mismatch",
      );
    else
      check(
        v.status ===
          (
            {
              trade_accepted: "accepted",
              trade_rejected: "rejected",
              trade_cancelled: "cancelled",
            } as const
          )[o.kind] &&
          v.closing_principal === base.principal &&
          v.closing_command_sequence === base.command_sequence,
        "offer terminal identity mismatch",
      );
    if (o.kind === "trade_accepted") {
      const t = o.trade;
      check(
        o.seller.actor.kind === "merchant" &&
          o.seller.actor.merchant_id === v.seller &&
          t.offer_id === v.offer_id &&
          t.trade_id === v.trade_id &&
          t.buyer.merchant_id === v.buyer &&
          t.seller.merchant_id === v.seller &&
          t.item_id === v.item_id &&
          t.quantity === v.quantity &&
          t.unit_price === v.unit_price &&
          t.total_price === v.total_price &&
          t.settled_at_ns === v.closed_at_ns &&
          t.command_principal === base.principal &&
          t.command_sequence === base.command_sequence &&
          t.event_sequence === base.effect_event_sequence,
        "accepted offer/trade binding mismatch",
      );
    }
  }
  return r;
}
export const livingTownOfferPageArgs = object({
  merchant_id: nullable(offerMerchant),
  status: choice(["pending", "terminal", "all"] as const),
  after_id: nullable(positiveU64),
  limit: bounded(1n, 50n),
  expected_market_revision: positiveU64,
});
export const livingTownOfferPage = object({
  items: array(livingTownOffer, 50),
  next_after_id: nullable(positiveU64),
  has_more: boolean,
  history_gap: boolean,
  pruned_through: parseU64,
});
function decodeOfferLookup(value: unknown) {
  if (record(value)["kind"] === "found")
    return object({ kind: literal("found"), offer: livingTownOffer })(value);
  return object({
    kind: choice(["pruned", "not_found"] as const),
    offer_id: positiveU64,
  })(value);
}
function decodeTradingRules(value: unknown) {
  const material = object({
    supplier: offerMerchant,
    floor: parseU64,
    target: positiveU64,
    base_price: positiveU64,
    min_price: positiveU64,
    max_price: positiveU64,
  });
  const r = object({
    schema: literal("merchant-offers-v1"),
    items: array(offerItem, 4),
    quantity_cap: literal("2"),
    backup_cap: literal("7"),
    operating_gold: object({
      rex: literal("80"),
      luna: literal("120"),
      bolt: literal("60"),
    }),
    max_pending_global: literal("12"),
    max_pending_per_merchant: literal("8"),
    terminal_retention: literal("128"),
    min_offer_lifetime_seconds: literal("60"),
    max_offer_lifetime_seconds: literal("600"),
    materials: object({
      crystal: material,
      wood: material,
      herb: material,
      iron: material,
    }),
  })(value);
  check(
    r.items.join() === offerItems.join() &&
      canonicalLivingTownJson(r.materials) ===
        canonicalLivingTownJson(offerMaterialRules),
    "unreviewed trading rules",
  );
  return r;
}

export function livingTownOffer(
  value: unknown,
): ReturnType<typeof decodeOffer> {
  return decodeOffer(value);
}

export function livingTownMerchantTrade(
  value: unknown,
): ReturnType<typeof decodeMerchantTrade> {
  return decodeMerchantTrade(value);
}

export function livingTownOfferOutcome(
  value: unknown,
): ReturnType<typeof decodeOfferOutcome> {
  return decodeOfferOutcome(value);
}

export function livingTownOfferEffect(
  value: unknown,
): ReturnType<typeof decodeOfferEffect> {
  return decodeOfferEffect(value);
}

export function livingTownOfferLookup(
  value: unknown,
): ReturnType<typeof decodeOfferLookup> {
  return decodeOfferLookup(value);
}

export function livingTownTradingRules(
  value: unknown,
): ReturnType<typeof decodeTradingRules> {
  return decodeTradingRules(value);
}
