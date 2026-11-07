import type { TownObservation, TownState } from "./living-town-controller";
import { productionQuote } from "./living-town-production-ui";

export const shopManagerTabs = [
  { id: "overview", name: "Overview" },
  { id: "inventory", name: "Inventory" },
  { id: "production", name: "Production" },
  { id: "listings", name: "Listings" },
  { id: "assistant", name: "Assistant" },
  { id: "history", name: "History" },
] as const;
export type TownManagerTab = (typeof shopManagerTabs)[number]["id"];
export function ownedTownObservation(state: TownState): TownObservation | null {
  const o = state.observation;
  return o &&
    state.accountId &&
    o.accountId === state.accountId &&
    o.ownershipKnown &&
    o.shop?.owner.kind === "player" &&
    o.shop.owner.account_id === state.accountId &&
    o.player?.shop_id === o.shop.shop_id
    ? o
    : null;
}
export function townSnapshotFresh(state: TownState, now: number): boolean {
  const o = state.observation;
  return (
    !!o &&
    !o.stale &&
    now >= o.receivedAt &&
    now - o.receivedAt <= 30000 &&
    o.accountId === state.accountId
  );
}
export function townMode(
  kind: "ready" | "unconfigured" | "unavailable",
  account: string | null,
): string {
  return kind === "unconfigured"
    ? "Local preview · no saved game"
    : kind === "unavailable"
      ? "Town connection unavailable"
      : account
        ? "NEAR Testnet · player"
        : "NEAR Testnet · spectator";
}
export interface TownHud {
  available: string | null;
  reserved: string | null;
  slots: string | null;
  customers: string | null;
  fresh: boolean;
}
export function townHud(state: TownState, now: number): TownHud {
  const o = ownedTownObservation(state),
    ledger = o?.ledger;
  const matches =
    ledger?.actor.kind === "player" &&
    ledger.actor.account_id === state.accountId;
  const running = o?.production?.items.filter(
    (j) => j.shop_id === o.shop!.shop_id && j.status === "running",
  ).length;
  return {
    available: matches ? ledger.gold.available : null,
    reserved: matches ? ledger.gold.trade_reserved : null,
    slots:
      running === undefined
        ? null
        : `${running} / ${o!.shop!.production_slots}`,
    customers: state.observation?.town.customer_pool.gold ?? null,
    fresh: townSnapshotFresh(state, now),
  };
}
export interface TownNextAction {
  title: string;
  detail: string;
  target: "connect" | "manager" | "market" | "refresh";
  tab: TownManagerTab;
}
export function nextTownAction(
  state: TownState,
  kind: "ready" | "unconfigured" | "unavailable",
  now: number,
): TownNextAction {
  const action = (
    title: string,
    detail: string,
    target: TownNextAction["target"],
    tab: TownManagerTab = "overview",
  ) => ({ title, detail, target, tab });
  if (kind === "unavailable")
    return action(
      "Inspect the town layout",
      "The town connection is unavailable. Refresh the page to retry; live balances and wallet actions need a configured town.",
      "manager",
    );
  if (kind === "unconfigured")
    return action(
      "Explore your shop manager",
      "This preview creates no gold, jobs or ownership. A configured town and wallet are needed to play.",
      "manager",
    );
  if (state.pending)
    return action(
      "Resolve the saved wallet request",
      `Check the original request for ${state.pending.accountId}. An unknown outcome must be reconciled before another transaction.`,
      "manager",
    );
  if (!state.accountId)
    return action(
      "Connect to start your shop",
      "Spectators can browse the square. Connect a player wallet when you are ready.",
      "connect",
    );
  if (!townSnapshotFresh(state, now))
    return action(
      "Refresh confirmed town data",
      "Use a current snapshot before choosing your next action.",
      "refresh",
    );
  const o = state.observation!;
  if (!o.player)
    return action(
      "Register your player",
      "Review the once-only 100 game gold grant in your wallet.",
      "manager",
    );
  if (!o.shop)
    return action(
      "Give your shop a name",
      "Shop creation is a separate owner approval and does not issue another grant.",
      "manager",
    );
  const owned = ownedTownObservation(state);
  if (!owned)
    return action(
      "Confirm your shop ownership",
      "Refresh the selected account before managing this shop.",
      "refresh",
    );
  const jobs =
    owned.production?.items.filter(
      (j) => j.shop_id === owned.shop!.shop_id && j.status === "running",
    ) ?? [];
  if (
    owned.chainTimestampNs &&
    jobs.some((j) => BigInt(j.ready_at_ns) <= BigInt(owned.chainTimestampNs!))
  )
    return action(
      "Claim a ready batch",
      "The finalized network time shows a batch is ready. Review its whole output in Production.",
      "manager",
      "production",
    );
  if (owned.town.paused)
    return action(
      "Town paused: inspect your workshop",
      "New starts and purchases are paused. Ready batches can still be claimed.",
      "manager",
      "production",
    );
  if (owned.upgrade?.eligible)
    return action(
      "Unlock a second production slot",
      "Review the 150 game gold upgrade and its 30 available-gold reserve.",
      "manager",
      "production",
    );
  if (
    owned.ledger &&
    ["health_potion", "iron_tool"].some(
      (item) =>
        BigInt(
          owned.ledger!.inventory.available[
            item as "health_potion" | "iron_tool"
          ],
        ) > 0n,
    )
  )
    return action(
      "Put finished goods on your shelves",
      "Compare current offers, choose your price and review the stock you want to list.",
      "manager",
      "listings",
    );
  if (owned.recipes?.some((r) => !productionQuote(owned, r, "1").reason))
    return action(
      "Craft your next batch",
      "Your current inputs and a free slot can support a recipe. Review the exact batch terms.",
      "manager",
      "production",
    );
  if (jobs.length)
    return action(
      "Check your production queue",
      "Batches keep their pinned network timing. Refresh to confirm readiness; waiting is not a sale.",
      "manager",
      "production",
    );
  if (owned.ownListings?.some((l) => l.active && l.remaining_quantity !== "0"))
    return action(
      "Compare your listed prices",
      "Stock remains yours until a funded purchase settles. Compare loaded offers or inspect confirmed History.",
      "manager",
      "listings",
    );
  return action(
    "Review ingredients in the square",
    "Compare your available inventory with the recipes, then review supplier stock and prices.",
    "market",
  );
}
export interface TownMarketComparison {
  item: "health_potion" | "iron_tool";
  lowest: string | null;
  own: string | null;
  ownKnown: boolean;
  ownFresh: boolean;
  loaded: boolean;
  partial: boolean;
  fresh: boolean;
}
export function townMarketComparisons(
  state: TownState,
  now: number,
): TownMarketComparison[] {
  const page = state.market,
    owned = ownedTownObservation(state);
  return (["health_potion", "iron_tool"] as const).map((item) => {
    const listings =
      page?.items.filter(
        (l) => l.active && l.item_id === item && l.owner.kind === "player",
      ) ?? [];
    const prices = listings.map((l) => BigInt(l.unit_price));
    return {
      item,
      lowest: page
        ? prices.length
          ? prices.reduce((a, b) => (a < b ? a : b)).toString()
          : null
        : null,
      own:
        owned?.ownListings?.find((l) => l.active && l.item_id === item)
          ?.unit_price ?? null,
      ownKnown: !!owned?.ownListings,
      ownFresh: !!owned && townSnapshotFresh(state, now),
      loaded: !!page,
      partial: !!page?.nextCursor,
      fresh:
        !!page &&
        !page.stale &&
        now >= page.receivedAt &&
        now - page.receivedAt <= 30000,
    };
  });
}
