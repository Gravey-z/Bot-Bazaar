import { array, boolean, check, nullable, object } from "../wire.js";
import { livingTownSnapshot, livingTownShop, livingTownLedger, livingTownListing } from "./wire.js";
import { livingTownProductionJob } from "./production.js";
import { livingTownOffer } from "./offers.js";

export const merchantContextMaxBytes = 8 * 1024 * 1024;

const shape = object({
  merchants: array(object({ shop: livingTownSnapshot(livingTownShop),
    listings: array(livingTownListing, 6), job: nullable(livingTownProductionJob) }), 3),
  listings: array(livingTownListing, 18),
  candidates: array(object({ listing: livingTownListing, shop: livingTownSnapshot(livingTownShop),
    ledger: livingTownSnapshot(livingTownLedger) }), 2000),
  pendingOffers: array(livingTownOffer, 12),
  negotiatedTrading: boolean,
});

/** Current database facts only. The runtime retains its own verified trade cursor. */
export function livingTownMerchantContext(value: unknown): ReturnType<typeof shape> {
  const context = shape(value);
  check(context.merchants.length === 3, "incomplete merchant context");
  const owners = new Set<string>();
  for (const row of context.merchants) {
    const shop = row.shop.data;
    check(shop.owner.kind === "merchant", "merchant context owner");
    const merchant = shop.owner.merchant_id;
    owners.add(merchant);
    check(row.listings.every(l => l.shop_id === shop.shop_id && l.owner.kind === "merchant" &&
      l.owner.merchant_id === merchant), "merchant listing scope");
    check(row.job === null || row.job.shop_id === shop.shop_id, "merchant job scope");
  }
  check(owners.size === 3, "duplicate merchant context");
  for (const candidate of context.candidates) {
    const owner = candidate.shop.data.owner;
    check(owner.kind === "player" && candidate.listing.shop_id === candidate.shop.data.shop_id &&
      candidate.listing.owner.kind === "player" && candidate.listing.owner.account_id === owner.account_id &&
      candidate.ledger.data.actor.kind === "player" && candidate.ledger.data.actor.account_id === owner.account_id,
      "candidate context scope");
  }
  check(context.pendingOffers.every(o => o.status === "pending"), "pending offer context scope");
  return context;
}
