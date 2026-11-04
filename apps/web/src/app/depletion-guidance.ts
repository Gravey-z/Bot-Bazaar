import type { MarketViewState } from "./market-reader";

export interface DepletionGuidance {
  code: "stock" | "inactive" | "quantity" | "price" | "stocked";
  title: string;
  detail: string;
}

// This describes the opening purchase only. Stock cannot establish provider
// availability, the player's affordability or a guaranteed merchant response.
export function shortageGuidance(
  state: MarketViewState,
): DepletionGuidance | null {
  if (
    state.status !== "ready" ||
    state.readFailed ||
    !state.observation ||
    state.observation.market.data.paused
  )
    return null;
  const rex = state.observation.market.data.merchants.find(
    (merchant) => merchant.merchant_id === "rex",
  );
  const listing = rex?.listings.find((row) => row.resource === "crystal");
  if (!rex || !listing) return null;
  if (BigInt(rex.inventory.crystal) < 12n)
    return {
      code: "stock",
      title: "Rex’s crystal stock has changed.",
      detail: `Rex now owns ${rex.inventory.crystal} crystals. The demo’s opening purchase needs twelve, so it cannot start from this snapshot.`,
    };
  if (!listing.active)
    return {
      code: "inactive",
      title: "Rex’s crystals aren’t currently listed.",
      detail:
        "Rex’s crystal listing is inactive. His inventory is not all available to buy, so the demo’s opening purchase cannot start from this snapshot.",
    };
  if (BigInt(listing.quantity) < 12n)
    return {
      code: "quantity",
      title: "Fewer than twelve crystals are for sale.",
      detail: `Rex lists ${listing.quantity} crystals for sale. The demo’s opening purchase needs twelve in one purchase; owned stock and listed stock are different.`,
    };
  if (listing.unit_price !== "4")
    return {
      code: "price",
      title: "The opening crystal price has changed.",
      detail: `Rex now lists crystals at ${listing.unit_price} virtual gold each. The demo starts with twelve at four each, for 48 gold. Other live purchases use their current quote.`,
    };
  // Merchant policy v1 starts Rex's shortage below five crystals. A market
  // that has since restocked may sell twelve without reaching that trigger.
  const remaining = BigInt(rex.inventory.crystal) - 12n;
  if (remaining >= 5n)
    return {
      code: "stocked",
      title: "Rex has enough crystals to stay above the shortage trigger.",
      detail: `Rex owns ${rex.inventory.crystal} crystals. Buying twelve would leave ${remaining}, while his shortage starts below five. The purchase can use a current quote, but it would not recreate the opening shortage.`,
    };
  return null;
}

export type ArchiveAvailability =
  "loading" | "available" | "empty" | "unavailable";
export function historicalAlternative(status: ArchiveAvailability): {
  label: string;
  message: string;
} {
  switch (status) {
    case "available":
      return {
        label: "Watch a recorded example",
        message:
          "A reviewed historical session is available. Its original market, decisions and balances are separate from your live progress.",
      };
    case "empty":
      return {
        label: "Open historical archive",
        message:
          "No verified recording has been published yet. The historical archive explains what is still pending.",
      };
    case "unavailable":
      return {
        label: "Check historical archive",
        message:
          "Recording availability could not be checked. You can retry in the archive or keep browsing the live market.",
      };
    case "loading":
      return {
        label: "Open historical archive",
        message:
          "Checking whether a reviewed historical recording is available. Playback is read-only.",
      };
  }
}
