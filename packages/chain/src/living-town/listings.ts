import { object, choice, check, array } from "../wire.js";
import {
  livingTownProductionEffectBase,
  livingTownListing,
  livingTownLedger,
} from "./wire.js";
import { canonicalLivingTownJson } from "./json.js";
function decode(value: unknown) {
  const base = livingTownProductionEffectBase(value);
  const r = {
    ...base,
    outcome:
      (base.outcome as { kind?: unknown }).kind === "listings_set"
        ? object({
            kind: choice(["listings_set"] as const),
            listings: array(livingTownListing, 6),
            ledger: livingTownLedger,
          })(base.outcome)
        : object({
            kind: choice(["listing_set", "listing_cancelled"] as const),
            listing: livingTownListing,
            ledger: livingTownLedger,
          })(base.outcome),
  };
  const { ledger } = r.outcome;
  const listings =
    "listings" in r.outcome ? r.outcome.listings : [r.outcome.listing];
  check(
    listings.length > 0 &&
      new Set(listings.map((l) => l.item_id)).size === listings.length &&
      new Set(listings.map((l) => l.listing_id)).size === listings.length,
    "Batch listings must be nonempty and distinct",
  );
  for (const l of listings) {
    check(
      !("listings" in r.outcome) ||
        (l.owner.kind === "merchant" && l.shop_id === listings[0]!.shop_id),
      "Batch listings require one merchant shop",
    );
    const principal =
      l.owner.kind === "player"
        ? `account:${l.owner.account_id}`
        : `merchant:${l.owner.merchant_id}`;
    check(
      r.principal === principal &&
        canonicalLivingTownJson(l.owner) ===
          canonicalLivingTownJson(ledger.actor) &&
        r.effect_revision === r.effect_event_sequence &&
        ledger.inventory.listing_reserved[l.item_id] === l.remaining_quantity,
      "Listing effect owner/reservation mismatch",
    );
    check(
      l.owner.kind === "player"
        ? BigInt(l.shop_id) > 3n &&
            ["health_potion", "iron_tool"].includes(l.item_id)
        : l.shop_id ===
            String(["rex", "luna", "bolt"].indexOf(l.owner.merchant_id) + 1),
      "Listing shop/item mismatch",
    );
    check(
      r.outcome.kind !== "listing_cancelled" || !l.active,
      "Cancelled listing must release stock",
    );
  }
  return r;
}
export function livingTownListingEffect(
  value: unknown,
): ReturnType<typeof decode> {
  return decode(value);
}
