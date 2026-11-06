import { canonicalLivingTownJson } from "@bot-bazaar/chain";
import type {
  livingTownListing,
  livingTownHistoryEntry,
  livingTownCostSummary,
} from "@bot-bazaar/chain";
import type { TownObservation } from "./living-town-controller";

export type TownListing = ReturnType<typeof livingTownListing>;
export type TownHistoryEntry = ReturnType<typeof livingTownHistoryEntry>;
export interface TownMarketPage {
  items: TownListing[];
  nextCursor: string | null;
  stale: boolean;
  receivedAt: number;
}
export interface TownHistoryPage {
  shopId: string;
  items: TownHistoryEntry[];
  costs: ReturnType<typeof livingTownCostSummary>;
  nextCursor: string | null;
  stale: boolean;
  receivedAt: number;
  historyComplete: boolean;
}
export interface ListingReview {
  accountId: string;
  shopId: string;
  ledgerRevision: string;
  itemId: string;
  listingId: string | null;
  revision: string | null;
  quantity: string;
  price: string;
  previousQuantity: string;
}
export function listingQuote(
  o: TownObservation | null,
  itemId: string,
  quantity: string,
  price: string,
): { review: ListingReview | null; reason: string } {
  if (
    !o?.shop ||
    !o.ledger ||
    !o.accountId ||
    o.shop.owner.kind !== "player" ||
    o.shop.owner.account_id !== o.accountId ||
    !o.ownListings
  )
    return {
      review: null,
      reason: "Load your confirmed shop and listings first.",
    };
  if (!["health_potion", "iron_tool"].includes(itemId))
    return {
      review: null,
      reason: "Only crafted potions and tools can be listed.",
    };
  if (
    typeof quantity !== "string" ||
    !/^[1-9][0-9]{0,2}$/.test(quantity) ||
    BigInt(quantity) > 100n
  )
    return {
      review: null,
      reason: "Choose a remaining quantity from 1 to 100.",
    };
  if (
    typeof price !== "string" ||
    !/^[1-9][0-9]{0,2}$/.test(price) ||
    BigInt(price) > 100n
  )
    return { review: null, reason: "Choose a whole price from 1 to 100 gold." };
  const current = o.ownListings.find((l) => l.item_id === itemId),
    item = itemId as "health_potion" | "iron_tool";
  const reusable =
    BigInt(o.ledger.inventory.available[item]) +
    BigInt(current?.remaining_quantity ?? "0");
  const review = {
    accountId: o.accountId,
    shopId: o.shop.shop_id,
    ledgerRevision: o.ledger.revision,
    itemId,
    listingId: current?.listing_id ?? null,
    revision: current?.revision ?? null,
    quantity,
    price,
    previousQuantity: current?.remaining_quantity ?? "0",
  };
  return {
    review,
    reason: o.stale
      ? "Refresh your confirmed stock before listing."
      : o.town.paused
        ? "New listings are paused. Existing listings can still be cancelled."
        : BigInt(quantity) > reusable
          ? "That quantity exceeds available stock plus this listing's remaining stock."
          : "",
  };
}
export function listingReviewMatches(
  review: ListingReview,
  observation: TownObservation | null,
): boolean {
  const next = listingQuote(
    observation,
    review.itemId,
    review.quantity,
    review.price,
  );
  return (
    !next.reason &&
    !!next.review &&
    canonicalLivingTownJson(next.review) === canonicalLivingTownJson(review)
  );
}
export function productDemandText(item: string, price: string): string {
  const cap = item === "health_potion" ? 18n : 24n;
  return BigInt(price) > cap
    ? `Above the ${cap} gold customer price limit: no baseline customer will buy at this price.`
    : `Within the ${cap} gold customer price limit. Sales still depend on stock, competing offers, quotas, funded demand and an available customer worker.`;
}
export function historyLabel(kind: TownHistoryEntry["kind"]): string {
  return {
    material_purchase: "Materials purchased",
    material_sale: "Materials sold",
    customer_sale: "Customer sale",
    player_grant: "Starter grant",
    production_started: "Production started",
    production_completed: "Production completed",
  }[kind];
}
