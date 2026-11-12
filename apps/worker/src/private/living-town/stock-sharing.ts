import {
  canonicalLivingTownJson,
  livingTownSnapshot,
  livingTownTown,
  livingTownShop,
  livingTownListing,
  livingTownOffer,
  checkPendingOfferReservations,
  livingTownRawTrade,
  livingTownMerchantTrade,
  livingTownCustomerTrade,
  offerMaterialRules,
  parseU64,
} from "@bot-bazaar/chain";
import type { MerchantPolicyInput } from "./merchant-policy.js";
import { requireStorage, sha256 } from "../storage/validation.js";

export const stockSharingVersion = "merchant-stock-sharing-v1";
const merchants = ["rex", "luna", "bolt"] as const;
const items = ["crystal", "wood", "herb", "iron"] as const;
type Merchant = (typeof merchants)[number];
type Raw = (typeof items)[number];
const goldFloors = { rex: 80n, luna: 120n, bolt: 60n };
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b));
const nonnegative = (v: bigint) => max(v, 0n);

/** Supplied by the trusted reaction owner, never accepted from model JSON.
 * Phase 5 owns persisting/advancing this context; previews do not invent roots. */
export interface StockSharingReaction {
  id: string;
  usedMerchants: readonly Merchant[];
  followUpOnly: boolean;
}
export interface StockSharingQuantity {
  quantity: string;
  minUnitPrice: string;
  maxUnitPrice: string;
  listingRelease: null | {
    listingId: string;
    expectedRevision: string;
    currentQuantity: string;
    maxRemainingQuantity: string;
  };
}
export interface StockSharingCandidate {
  id: string;
  kind: "backup_acquisition" | "emergency_restock";
  buyer: Merchant;
  seller: Merchant;
  item: Raw;
  buyerLedgerRevision: string;
  sellerLedgerRevision: string;
  availableSurplus: string;
  potentialSurplus: string;
  buyerHeadroom: string;
  buyerSpendableGold: string;
  quantityChoices: StockSharingQuantity[];
}
export interface StockSharingSignal {
  item: Raw;
  supplier: Merchant;
  held: string;
  incoming: string;
  saleable: string;
  retailDemand: string | null;
  lowStock: boolean;
  fastSelling: boolean;
  healthyForBackups: boolean;
}
export interface StockSharingPlan {
  version: typeof stockSharingVersion;
  checkpoint: { height: string; revision: string };
  windowStartNs: string;
  windowEndNs: string;
  executionReady: boolean;
  reasons: string[];
  signals: StockSharingSignal[];
  candidates: StockSharingCandidate[];
  pendingAssessments: StockSharingOfferAssessment[];
  merchants: {
    merchant: Merchant;
    candidateIds: string[];
    reasons: string[];
  }[];
}
export interface StockSharingOfferAssessment {
  offerId: string;
  buyer: Merchant;
  seller: Merchant;
  item: Raw;
  kind: "backup_acquisition" | "emergency_restock";
  eligible: boolean;
  acceptanceReady: boolean;
  reasons: string[];
  listingRelease: StockSharingQuantity["listingRelease"];
}
export interface StockSharingChoice {
  candidateId: string;
  quantity: string;
  unitPrice: string;
}

/** Pure candidate generation. It never chooses terms, creates stock or signs. */
function evaluate(input: MerchantPolicyInput): StockSharingPlan {
  const town = livingTownSnapshot(livingTownTown)(input.town),
    now = BigInt(town.block_timestamp_ns),
    genesis = BigInt(town.data.genesis_time_ns);
const backupTarget = 3n,
  backupCap = 7n,
  peerFloor = 2n;
  requireStorage(
    town.deployment.state_schema === "2" && input.negotiatedTrading === true,
    "negotiated stock sharing requires schema 2 capability",
  );
  requireStorage(
    input.merchants.length === 3 && input.trades.length <= 2000,
    "bounded stock-sharing facts required",
  );
  const reaction = input.stockSharingReaction;
  if (reaction)
    requireStorage(
      /^[a-f0-9]{64}$/.test(reaction.id) &&
        typeof reaction.followUpOnly === "boolean" &&
        reaction.usedMerchants.length <= 3 &&
        new Set(reaction.usedMerchants).size ===
          reaction.usedMerchants.length &&
        reaction.usedMerchants.every((m) => merchants.includes(m)),
      "invalid trusted stock-sharing reaction",
    );
  const rows = merchants.map((name) => {
    const source = input.merchants.find(
      (r) =>
        livingTownSnapshot(livingTownShop)(r.shop).data.owner.kind ===
          "merchant" &&
        (
          livingTownSnapshot(livingTownShop)(r.shop).data.owner as {
            merchant_id?: string;
          }
        ).merchant_id === name,
    );
    requireStorage(source, "missing stock-sharing merchant");
    const shop = livingTownSnapshot(livingTownShop)(source.shop);
    requireStorage(
      canonicalLivingTownJson(shop.deployment) ===
        canonicalLivingTownJson(town.deployment) &&
        shop.block_height === town.block_height &&
        shop.market_revision === town.market_revision &&
        shop.block_timestamp_ns === town.block_timestamp_ns,
      "mixed stock-sharing checkpoint",
    );
    const ledger = town.data.npc_ledgers[merchants.indexOf(name)]!;
    requireStorage(
      ledger.actor.kind === "merchant" && ledger.actor.merchant_id === name,
      "stock-sharing ledger identity mismatch",
    );
    const listings = source.listings.map(livingTownListing);
    requireStorage(
      listings.length <= 6 &&
        new Set(listings.map((l) => l.item_id)).size === listings.length &&
        listings.every(
          (l) =>
            l.owner.kind === "merchant" &&
            l.owner.merchant_id === name &&
            l.shop_id === shop.data.shop_id,
        ),
      "stock-sharing listing scope mismatch",
    );
    for (const item of Object.keys(
      ledger.inventory.held,
    ) as (keyof typeof ledger.inventory.held)[])
      requireStorage(
        (listings.find((l) => l.item_id === item)?.remaining_quantity ??
          "0") === ledger.inventory.listing_reserved[item],
        "incomplete stock-sharing listing promises",
      );
    return { name, ledger, listings };
  });
  const hasPending = input.pendingOffers !== undefined;
  const pending = (input.pendingOffers ?? []).map(livingTownOffer);
  if (hasPending) checkPendingOfferReservations(town.data.npc_ledgers, pending);
  const committed = new Set(pending.flatMap((o) => [o.buyer, o.seller]));
  const used = new Set(reaction?.usedMerchants ?? []);
  const windowStart = max(genesis, now - 300000000000n),
    demand: Record<Raw, bigint> = { crystal: 0n, wood: 0n, herb: 0n, iron: 0n };
  const seen = new Map<string, string>();
  for (const raw of input.trades) {
    const kind = (raw as { kind?: unknown })?.kind;
    const t =
      kind === "merchant_trade"
        ? livingTownMerchantTrade(raw)
        : kind === "customer_sale"
          ? livingTownCustomerTrade(raw)
          : livingTownRawTrade(raw);
    requireStorage(
      BigInt(t.settled_at_ns) >= genesis &&
        BigInt(t.settled_at_ns) <= now &&
        BigInt(t.event_sequence) <= BigInt(town.event_sequence),
      "future/out-of-deployment stock-sharing history",
    );
    const encoded = canonicalLivingTownJson(t);
    requireStorage(
      !seen.has(t.trade_id) || seen.get(t.trade_id) === encoded,
      "conflicting stock-sharing trade history",
    );
    if (seen.has(t.trade_id)) continue;
    seen.set(t.trade_id, encoded);
    if (
      t.kind === "raw_purchase" &&
      t.buyer.kind === "player" &&
      BigInt(t.settled_at_ns) >= windowStart
    ) {
      const item = t.item_id;
      // Every merchant may retail non-specialty stock. These decoded, confirmed
      // player purchases count as demand regardless of which merchant sold it.
      demand[item] += BigInt(t.quantity);
    }
  }
  const reasons: string[] = [];
  if (!input.fresh) reasons.push("confirmed_facts_stale");
  if (!input.historyComplete) reasons.push("retail_history_incomplete");
  if (!hasPending) reasons.push("pending_offers_not_reconciled");
  if (town.data.paused) reasons.push("market_paused");
  if (!reaction) reasons.push("preview_without_reaction");
  if (reaction?.followUpOnly) reasons.push("follow_up_cannot_start_trade");
  const signals: StockSharingSignal[] = items.map((item) => {
    const cfg = offerMaterialRules[item],
      row = rows.find((r) => r.name === cfg.supplier)!,
      inv = row.ledger.inventory;
    const h = BigInt(inv.held[item]),
      outgoing = BigInt(inv.trade_reserved[item]),
      incoming = BigInt(inv.trade_inbound_reserved[item]),
      saleable = nonnegative(h - outgoing - BigInt(cfg.floor));
    return {
      item,
      supplier: cfg.supplier,
      held: h.toString(),
      incoming: incoming.toString(),
      saleable: saleable.toString(),
      retailDemand: input.historyComplete ? demand[item].toString() : null,
      lowStock: h - outgoing <= BigInt(cfg.floor) + 2n,
      fastSelling:
        input.historyComplete &&
        demand[item] > 0n &&
        5n * saleable <= demand[item],
      healthyForBackups: h >= BigInt(cfg.target) - 2n,
    };
  });
  const candidates: StockSharingCandidate[] = [],
    notes = new Map<Merchant, Set<string>>(
      merchants.map((m) => [m, new Set()]),
    );
  const note = (m: Merchant, s: string) => notes.get(m)!.add(s);
  for (const m of merchants) {
    if (committed.has(m)) note(m, "participant_has_pending_offer");
    if (used.has(m)) note(m, "participant_already_used_in_root");
  }
  if (input.fresh && hasPending && !town.data.paused && !reaction?.followUpOnly)
    for (const item of items) {
      const cfg = offerMaterialRules[item],
        signal = signals.find((s) => s.item === item)!;
      for (const buyer of rows) {
        const primaryBuyer = buyer.name === cfg.supplier,
          inv = buyer.ledger.inventory;
        if (committed.has(buyer.name) || used.has(buyer.name)) continue;
        if (primaryBuyer) {
          if (!signal.lowStock && !signal.fastSelling) {
            note(buyer.name, "primary_stock_does_not_need_trade");
            continue;
          }
          if (BigInt(signal.incoming) > 0n) {
            note(buyer.name, "restock_already_incoming");
            continue;
          }
        } else if (
  !signal.healthyForBackups &&
  BigInt(inv.held[item]) > 0n
) {
  note(buyer.name, "primary_not_healthy_for_backup");
  continue;
}
        const target = primaryBuyer
  ? BigInt(cfg.target)
  : min(backupTarget, backupCap);
        const headroom = min(
          nonnegative(
            target -
              BigInt(inv.held[item]) -
              BigInt(inv.trade_inbound_reserved[item]),
          ),
          nonnegative(
            1000n -
              BigInt(inv.held[item]) -
              BigInt(inv.trade_inbound_reserved[item]) -
              BigInt(inv.production_output_reserved[item]),
          ),
        );
        if (headroom === 0n) {
          note(
            buyer.name,
            primaryBuyer
              ? "primary_target_already_promised"
              : "backup_cap_already_promised",
          );
          continue;
        }
        const spendable = nonnegative(
          BigInt(buyer.ledger.gold.available) - goldFloors[buyer.name],
        );
        for (const seller of rows.filter((s) => s.name !== buyer.name)) {
          if (committed.has(seller.name) || used.has(seller.name)) {
            note(buyer.name, "eligible_supplier_committed");
            continue;
          }
          const si = seller.ledger.inventory,
            floor =
              seller.name === cfg.supplier ? BigInt(cfg.floor) : peerFloor;
          const potential = nonnegative(
            BigInt(si.held[item]) - BigInt(si.trade_reserved[item]) - floor,
          );
          const available = nonnegative(BigInt(si.available[item]) - floor);
          if (potential === 0n) {
            note(buyer.name, "no_supplier_surplus_above_floor");
            continue;
          }
          const listing = seller.listings.find((l) => l.item_id === item),
            listed = BigInt(si.listing_reserved[item]);
          // Held stock alone is not an offer to sell. Only propose purchases
          // of stock currently exposed by an active public listing.
          if (!listing?.active || BigInt(listing.remaining_quantity) === 0n) {
            note(buyer.name, "supplier_has_no_active_listing");
            continue;
          }
          let lo = primaryBuyer
            ? min(BigInt(cfg.max_price), BigInt(cfg.base_price) + 1n)
            : BigInt(cfg.min_price);
          if (listing?.active) lo = max(lo, BigInt(listing.unit_price));
          const hi = primaryBuyer
            ? BigInt(cfg.max_price)
            : BigInt(cfg.base_price);
          const goldHeadroom = nonnegative(
            1000000n -
              BigInt(seller.ledger.gold.held) -
              BigInt(seller.ledger.gold.trade_inbound_reserved),
          );
          const choices: StockSharingQuantity[] = [];
          for (let q = 1n; q <= min(2n, potential, headroom, BigInt(listing.remaining_quantity)); q++) {
            const maxPrice = min(hi, spendable / q, goldHeadroom / q);
            if (lo > maxPrice) continue;
            const remaining = nonnegative(
              BigInt(si.held[item]) -
                BigInt(si.trade_reserved[item]) -
                floor -
                q,
            );
            choices.push({
              quantity: q.toString(),
              minUnitPrice: lo.toString(),
              maxUnitPrice: maxPrice.toString(),
              listingRelease:
                listed > remaining
                  ? {
                      listingId: listing!.listing_id,
                      expectedRevision: listing!.revision,
                      currentQuantity: listed.toString(),
                      maxRemainingQuantity: remaining.toString(),
                    }
                  : null,
            });
          }
          if (!choices.length) {
            note(
              buyer.name,
              spendable < lo
                ? "operating_gold_reserve"
                : "no_mutually_eligible_price_or_capacity",
            );
            continue;
          }
          const kind = primaryBuyer
            ? "emergency_restock"
            : "backup_acquisition";
          const key = {
            version: stockSharingVersion,
            configVersion: town.deployment.config_version,
            root: reaction?.id ?? null,
            kind,
            buyer: buyer.name,
            seller: seller.name,
            item,
            availableSurplus: available.toString(),
            potentialSurplus: potential.toString(),
            buyerHeadroom: headroom.toString(),
            buyerSpendableGold: spendable.toString(),
            choices,
          };
          candidates.push({
            id: sha256(canonicalLivingTownJson(key)),
            kind,
            buyer: buyer.name,
            seller: seller.name,
            item,
            buyerLedgerRevision: buyer.ledger.revision,
            sellerLedgerRevision: seller.ledger.revision,
            availableSurplus: available.toString(),
            potentialSurplus: potential.toString(),
            buyerHeadroom: headroom.toString(),
            buyerSpendableGold: spendable.toString(),
            quantityChoices: choices,
          });
        }
      }
    }
  requireStorage(
    candidates.length <= 16,
    "stock-sharing candidate bound exceeded",
  );
  candidates.sort(
    (a, b) =>
      merchants.indexOf(a.buyer) - merchants.indexOf(b.buyer) ||
      items.indexOf(a.item) - items.indexOf(b.item) ||
      merchants.indexOf(a.seller) - merchants.indexOf(b.seller),
  );
  const pendingAssessments: StockSharingOfferAssessment[] = pending
    .map((o): StockSharingOfferAssessment => {
      const cfg = offerMaterialRules[o.item_id],
        signal = signals.find((s) => s.item === o.item_id)!;
      const buyer = rows.find((r) => r.name === o.buyer)!,
        seller = rows.find((r) => r.name === o.seller)!,
        primary = o.buyer === cfg.supplier;
      const bi = buyer.ledger.inventory,
        si = seller.ledger.inventory,
        q = BigInt(o.quantity),
        cost = BigInt(o.total_price),
        floor = seller.name === cfg.supplier ? BigInt(cfg.floor) : peerFloor;
      const why: string[] = [];
      if (!input.fresh) why.push("confirmed_facts_stale");
      if (!input.historyComplete) why.push("retail_history_incomplete");
      if (town.data.paused) why.push("market_paused");
      if (now >= BigInt(o.expires_at_ns))
        why.push("offer_expired_requires_cleanup");
      if (primary) {
        if (!signal.lowStock && !signal.fastSelling)
          why.push("source_or_stock_removed_shortage");
        if (
          BigInt(o.unit_price) <
          min(BigInt(cfg.max_price), BigInt(cfg.base_price) + 1n)
        )
          why.push("emergency_price_below_donor_band");
      } else {
        if (
          !signal.healthyForBackups &&
          BigInt(bi.held[o.item_id]) > 0n
        ) {
          why.push("primary_no_longer_healthy_for_backup");
        }
        if (BigInt(o.unit_price) > BigInt(cfg.base_price))
          why.push("backup_price_above_base");
      }
      if (
        BigInt(buyer.ledger.gold.available) < goldFloors[o.buyer] ||
        BigInt(buyer.ledger.gold.trade_reserved) < cost
      )
        why.push("buyer_operating_gold_or_commitment");
      if (
        BigInt(bi.held[o.item_id]) +
          BigInt(bi.trade_inbound_reserved[o.item_id]) >
          (primary ? BigInt(cfg.target) : backupCap) ||
        BigInt(bi.held[o.item_id]) +
          BigInt(bi.trade_inbound_reserved[o.item_id]) +
          BigInt(bi.production_output_reserved[o.item_id]) >
          1000n
      )
        why.push("buyer_target_or_capacity");
      const potential = nonnegative(
        BigInt(si.held[o.item_id]) -
          BigInt(si.trade_reserved[o.item_id]) -
          floor,
      );
      if (potential < q) why.push("seller_floor_or_stock");
      if (
        BigInt(seller.ledger.gold.held) +
          BigInt(seller.ledger.gold.trade_inbound_reserved) +
          cost >
        1000000n
      )
        why.push("seller_gold_capacity");
      const listing = seller.listings.find((l) => l.item_id === o.item_id),
        listed = BigInt(si.listing_reserved[o.item_id]);
      const remaining = nonnegative(potential - q);
      const release =
        potential >= q && listed > remaining
          ? {
              listingId: listing!.listing_id,
              expectedRevision: listing!.revision,
              currentQuantity: listed.toString(),
              maxRemainingQuantity: remaining.toString(),
            }
          : null;
      return {
        offerId: o.offer_id,
        buyer: o.buyer,
        seller: o.seller,
        item: o.item_id,
        kind: primary ? "emergency_restock" : "backup_acquisition",
        eligible: why.length === 0,
        acceptanceReady: why.length === 0 && release === null,
        reasons: why,
        listingRelease: release,
      };
    })
    .sort((a, b) => (BigInt(a.offerId) < BigInt(b.offerId) ? -1 : 1));
  return {
    version: stockSharingVersion,
    checkpoint: { height: town.block_height, revision: town.market_revision },
    windowStartNs: windowStart.toString(),
    windowEndNs: now.toString(),
    executionReady: reasons.length === 0,
    reasons,
    signals,
    candidates,
    pendingAssessments,
    merchants: merchants.map((merchant) => ({
      merchant,
      candidateIds: candidates
        .filter((c) => c.buyer === merchant)
        .map((c) => c.id),
      reasons: [...new Set([...reasons, ...notes.get(merchant)!])].sort(),
    })),
  };
}

export function buildStockSharingPlan(
  input: MerchantPolicyInput,
): StockSharingPlan {
  return evaluate(input);
}
export function selectStockSharingTerms(
  plan: StockSharingPlan,
  buyer: Merchant,
  choice: StockSharingChoice,
): { candidate: StockSharingCandidate; quantity: StockSharingQuantity } {
  requireStorage(
    plan.executionReady,
    "stock-sharing execution requires fresh complete facts and a trusted reaction",
  );
  parseU64(choice.quantity);
  parseU64(choice.unitPrice);
  const candidate = plan.candidates.find(
    (c) => c.id === choice.candidateId && c.buyer === buyer,
  );
  requireStorage(candidate, "stale or unavailable stock-sharing candidate");
  const quantity = candidate.quantityChoices.find(
    (q) => q.quantity === choice.quantity,
  );
  requireStorage(
    quantity &&
      BigInt(choice.unitPrice) >= BigInt(quantity.minUnitPrice) &&
      BigInt(choice.unitPrice) <= BigInt(quantity.maxUnitPrice),
    "stock-sharing terms outside eligible range",
  );
  return { candidate, quantity };
}
