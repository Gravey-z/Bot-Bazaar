import type { MarketViewState } from "./market-reader";
import type { RegistrationObservation } from "./registration-reader";

export function playerReadStale(
  value: RegistrationObservation | null,
  now: number,
): boolean {
  if (!value) return true;
  const chainTime = Number(BigInt(value.market.block_timestamp_ns) / 1000000n);
  return (
    now < value.receivedAt ||
    now - value.receivedAt > 15000 ||
    now - chainTime > 15000 ||
    chainTime - now > 5000
  );
}

export function marketNotice(state: MarketViewState): string {
  if (!state.observation) return "";
  if (state.status !== "ready")
    return "These are previous market values. Refresh before relying on stock, prices or pause status.";
  if (state.observation.market.data.paused)
    return "The contract is paused. New purchases and registration are unavailable. Browsing and checking original transactions remain available.";
  if (
    !state.observation.market.data.merchants.some((merchant) =>
      merchant.listings.some(
        (listing) => listing.active && BigInt(listing.quantity) > 0n,
      ),
    )
  )
    return "No resources are currently listed for sale. You can inspect inventories or refresh the market; a restock is not guaranteed.";
  return "";
}
