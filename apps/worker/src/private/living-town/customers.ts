import { createHash } from "node:crypto";
import {
  canonicalLivingTownJson,
  livingTownSnapshot,
  livingTownTown,
  livingTownListing,
  livingTownShop,
  livingTownLedger,
  parseU64,
} from "@bot-bazaar/chain";
import { livingTownRecipeIds } from "@bot-bazaar/shared";
import type { LivingTownRecipeId } from "@bot-bazaar/shared";

const policy = "living-town-demand-v1" as const;
const hash = (value: unknown): string =>
  createHash("sha256").update(canonicalLivingTownJson(value)).digest("hex");
/** A newer finalized block may reuse collected facts only when every economic field is unchanged. */
export function sameCustomerCheckpointState(
  previous: unknown,
  current: unknown,
): boolean {
  const decode = livingTownSnapshot(livingTownTown),
    a = decode(previous),
    b = decode(current);
  return (
    BigInt(b.block_height) >= BigInt(a.block_height) &&
    BigInt(b.block_timestamp_ns) >= BigInt(a.block_timestamp_ns) &&
    canonicalLivingTownJson(a.deployment) ===
      canonicalLivingTownJson(b.deployment) &&
    a.market_revision === b.market_revision &&
    a.event_sequence === b.event_sequence &&
    canonicalLivingTownJson(a.data) === canonicalLivingTownJson(b.data)
  );
}
function requireDemand(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Customer demand: ${message}`);
}
const record = (v: unknown): Record<string, unknown> => {
  requireDemand(
    v && typeof v === "object" && !Array.isArray(v),
    "object required",
  );
  return v as Record<string, unknown>;
};
const compare = (a: string, b: string): number =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

export interface CustomerDemandInput {
  /** One verified finalized checkpoint; candidates must come from its complete market scan. */
  town: unknown;
  seed: string;
  tick: string;
  arrivalIndex: string;
  fresh: boolean;
  marketComplete: boolean;
  historyComplete: boolean;
  candidates: readonly {
    listing: unknown;
    shop: unknown;
    ledger: unknown;
    /** Confirmed customer-sale event for this product/shop; null means never sold. */
    lastSaleEventSequence: string | null;
  }[];
}
export type CustomerNoSaleReason =
  | "paused"
  | "stale_snapshot"
  | "market_incomplete"
  | "history_unavailable"
  | "quota_exhausted"
  | "no_stock"
  | "above_willingness_to_pay"
  | "insufficient_budget"
  | "seller_capacity"
  | "no_eligible_listing";
interface Arrival {
  policy: typeof policy;
  customerId: string;
  tick: string;
  arrivalIndex: string;
  itemId: LivingTownRecipeId;
  willingnessToPay: string;
}
export type CustomerDemandDecision = Arrival & {
  checkpoint: { blockHeight: string; marketRevision: string };
  diagnostics: { listingId: string; reason: CustomerNoSaleReason }[];
} & (
    | { kind: "no_purchase"; reason: CustomerNoSaleReason }
    | {
        kind: "purchase";
        reason: "lowest_price_then_oldest_sale_then_shop";
        terms: {
          listing_id: string;
          expected_listing_revision: string;
          epoch: string;
          max_total_price: string;
        };
        shopId: string;
      }
  );

/** Pure proposal policy. No journal, signer, funding, RPC or optimistic ledger updates. */
export class LivingTownCustomerDemand {
  private readonly configHash: string;
  private readonly epochNs: bigint;
  private readonly quota: bigint;
  private readonly goldCap: bigint;
  private readonly prices: Record<LivingTownRecipeId, string>;
  constructor(config: unknown) {
    const c = record(config),
      economy = record(c["economy"]);
    requireDemand(
      c["schema"] === "bot-bazaar-living-town-config-v1" &&
        c["version"] === "1" &&
        economy["epochSeconds"] === "60" &&
        economy["customerQuota"] === "2" &&
        economy["customerCap"] === "200" &&
        economy["goldCap"] === "1000000",
      "unsupported economic policy",
    );
    const recipes = record(economy["recipes"]);
    this.prices = {
      health_potion: parseU64(record(recipes["health_potion"])["salePrice"]),
      iron_tool: parseU64(record(recipes["iron_tool"])["salePrice"]),
    };
    requireDemand(
      this.prices.health_potion === "18" && this.prices.iron_tool === "24",
      "unsupported willingness to pay",
    );
    this.epochNs = BigInt(economy["epochSeconds"] as string) * 1_000_000_000n;
    this.quota = BigInt(economy["customerQuota"] as string);
    this.goldCap = BigInt(economy["goldCap"] as string);
    this.configHash = hash(config);
  }

  private context(townValue: unknown, seedValue: string, tickValue: string) {
    const town = livingTownSnapshot(livingTownTown)(townValue),
      seed = parseU64(seedValue),
      tick = parseU64(tickValue);
    const elapsed =
      BigInt(town.block_timestamp_ns) - BigInt(town.data.genesis_time_ns);
    requireDemand(
      town.deployment.config_sha256 === this.configHash,
      "configuration digest mismatch",
    );
    requireDemand(
      elapsed >= 0n &&
        (elapsed / this.epochNs).toString() === tick &&
        town.data.epoch === tick &&
        town.data.customer_pool.epoch === tick,
      "only the current finalized epoch is eligible",
    );
    return { town, seed, tick };
  }

  arrivals(
    townValue: unknown,
    seedValue: string,
    tickValue: string,
  ): Arrival[] {
    const { town, seed, tick } = this.context(townValue, seedValue, tickValue);
    // Four bounded opportunities, two per product. Seed affects arrival order only.
    const slots = livingTownRecipeIds.flatMap((itemId) =>
      ["0", "1"].map((unit) => ({
        itemId,
        unit,
        order: hash([policy, town.deployment, seed, tick, itemId, unit]),
      })),
    );
    slots.sort((a, b) =>
      a.order < b.order
        ? -1
        : a.order > b.order
          ? 1
          : a.itemId < b.itemId
            ? -1
            : a.itemId > b.itemId
              ? 1
              : compare(a.unit, b.unit),
    );
    return slots.map((slot, i) => ({
      policy,
      customerId: hash([policy, town.deployment, seed, tick, String(i)]),
      tick,
      arrivalIndex: String(i),
      itemId: slot.itemId,
      willingnessToPay: this.prices[slot.itemId],
    }));
  }

  select(input: CustomerDemandInput): CustomerDemandDecision {
    const { town } = this.context(input.town, input.seed, input.tick);
    const index = parseU64(input.arrivalIndex);
    requireDemand(BigInt(index) < 4n, "arrival index outside epoch");
    const arrival = this.arrivals(input.town, input.seed, input.tick)[
      Number(index)
    ]!;
    const base = {
      ...arrival,
      checkpoint: {
        blockHeight: town.block_height,
        marketRevision: town.market_revision,
      },
      diagnostics: [] as CustomerDemandDecision["diagnostics"],
    };
    const no = (reason: CustomerNoSaleReason): CustomerDemandDecision => ({
      ...base,
      kind: "no_purchase",
      reason,
    });
    if (!input.fresh) return no("stale_snapshot");
    if (!input.marketComplete) return no("market_incomplete");
    if (!input.historyComplete) return no("history_unavailable");
    if (town.data.paused) return no("paused");
    requireDemand(
      input.candidates.length <= 2000,
      "market candidate bound exceeded",
    );
    const seen = new Set<string>(),
      slots = new Set<string>();
    const rows = input.candidates.map((candidate) => {
      const listing = livingTownListing(candidate.listing);
      const shop = livingTownSnapshot(livingTownShop)(candidate.shop);
      const ledger = livingTownSnapshot(livingTownLedger)(candidate.ledger);
      for (const snapshot of [shop, ledger]) {
        requireDemand(
          canonicalLivingTownJson(snapshot.deployment) ===
            canonicalLivingTownJson(town.deployment) &&
            snapshot.block_height === town.block_height &&
            snapshot.block_timestamp_ns === town.block_timestamp_ns &&
            snapshot.market_revision === town.market_revision,
          "mixed candidate checkpoints",
        );
      }
      requireDemand(
        listing.owner.kind === "player" &&
          BigInt(listing.shop_id) > 3n &&
          livingTownRecipeIds.includes(listing.item_id as LivingTownRecipeId),
        "only player products are candidates",
      );
      requireDemand(
        shop.data.shop_id === listing.shop_id &&
          canonicalLivingTownJson(shop.data.owner) ===
            canonicalLivingTownJson(listing.owner) &&
          canonicalLivingTownJson(ledger.data.actor) ===
            canonicalLivingTownJson(listing.owner),
        "candidate owner mismatch",
      );
      requireDemand(
        ledger.data.inventory.listing_reserved[listing.item_id] ===
          listing.remaining_quantity,
        "candidate stock/reservation mismatch",
      );
      const slot = `${listing.shop_id}:${listing.item_id}`;
      requireDemand(
        !seen.has(listing.listing_id) && !slots.has(slot),
        "duplicate candidate",
      );
      seen.add(listing.listing_id);
      slots.add(slot);
      const last =
        candidate.lastSaleEventSequence === null
          ? "0"
          : parseU64(candidate.lastSaleEventSequence);
      requireDemand(
        (candidate.lastSaleEventSequence === null || last !== "0") &&
          BigInt(last) <= BigInt(town.event_sequence),
        "invalid confirmed fulfillment sequence",
      );
      return { listing, ledger: ledger.data, last };
    });
    const bought =
      arrival.itemId === "health_potion"
        ? town.data.customer_pool.potion_units_bought
        : town.data.customer_pool.tool_units_bought;
    if (BigInt(bought) >= this.quota) return no("quota_exhausted");
    const eligible = rows.filter(({ listing: l, ledger }) => {
      if (l.item_id !== arrival.itemId) return false;
      const reason = !l.active
        ? "no_stock"
        : BigInt(l.unit_price) > BigInt(arrival.willingnessToPay)
          ? "above_willingness_to_pay"
          : BigInt(l.unit_price) > BigInt(town.data.customer_pool.gold)
            ? "insufficient_budget"
            : BigInt(ledger.gold.held) +
                  BigInt(ledger.gold.trade_inbound_reserved) +
                  BigInt(l.unit_price) >
                this.goldCap
              ? "seller_capacity"
              : null;
      if (reason) base.diagnostics.push({ listingId: l.listing_id, reason });
      return reason === null;
    });
    base.diagnostics.sort((a, b) => compare(a.listingId, b.listingId));
    if (!eligible.length) {
      const reasons = new Set(base.diagnostics.map((r) => r.reason));
      return no(
        reasons.size === 1
          ? base.diagnostics[0]!.reason
          : reasons.size === 0
            ? "no_stock"
            : "no_eligible_listing",
      );
    }
    eligible.sort(
      (a, b) =>
        compare(a.listing.unit_price, b.listing.unit_price) ||
        compare(a.last, b.last) ||
        compare(a.listing.shop_id, b.listing.shop_id) ||
        compare(a.listing.listing_id, b.listing.listing_id),
    );
    const chosen = eligible[0]!.listing;
    return {
      ...base,
      kind: "purchase",
      reason: "lowest_price_then_oldest_sale_then_shop",
      shopId: chosen.shop_id,
      terms: {
        listing_id: chosen.listing_id,
        expected_listing_revision: chosen.revision,
        epoch: input.tick,
        max_total_price: chosen.unit_price,
      },
    };
  }
}
