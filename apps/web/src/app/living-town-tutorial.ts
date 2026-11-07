import type { TownState } from "./living-town-controller";
import {
  ownedTownObservation,
  townSnapshotFresh,
  nextTownAction,
} from "./living-town-layout";
import type { TownNextAction } from "./living-town-layout";

export const firstLoopSteps = [
  {
    id: "register",
    title: "Register",
    detail:
      "Register once for the 100 game gold starter grant. Native NEAR pays wallet fees separately.",
  },
  {
    id: "shop",
    title: "Claim your shop",
    detail:
      "Create and name your shop in a separate owner approval. Shop creation does not issue another grant.",
  },
  {
    id: "buy",
    title: "Buy ingredients",
    detail:
      "Read a recipe's inputs, then review supplier stock, quantity and maximum game-gold cost before signing.",
  },
  {
    id: "craft",
    title: "Craft and claim",
    detail:
      "Starting consumes inputs once. Wait for finalized network readiness, then claim the whole batch. An estimated countdown alone cannot enable Claim.",
  },
  {
    id: "list",
    title: "List a product",
    detail:
      "Choose available finished stock, compare offers and review its price. Listed stock stays reserved until sold or cancelled.",
  },
  {
    id: "sale",
    title: "Confirm a sale",
    detail:
      "History must confirm a funded customer purchase. An offer, an empty listing or a cancelled listing does not prove a sale.",
  },
  {
    id: "upgrade",
    title: "Unlock a second slot",
    detail:
      "Complete and sell both products and earn 180 available gold. The upgrade burns 150 and retains 30. Repeat profitable production/sales as needed.",
  },
] as const;
export interface FirstLoopStep {
  id: string;
  title: string;
  detail: string;
  status: "confirmed" | "not_confirmed" | "unknown";
  evidence: string;
}
export interface FirstLoopTutorial {
  scope: string | null;
  steps: FirstLoopStep[];
  completed: number;
  current: FirstLoopStep | null;
  fresh: boolean;
  blocked: boolean;
  action: TownNextAction;
}

/** Read-only milestones: no click counters, local storage or wallet assertions. */
export function firstLoopTutorial(
  state: TownState,
  kind: "ready" | "unconfigured" | "unavailable",
  now: number,
): FirstLoopTutorial {
  const o = state.observation,
    account = state.accountId;
  const inScope = kind === "ready" && !!account && o?.accountId === account;
  const owned = inScope ? ownedTownObservation(state) : null;
  const history =
    owned && state.history?.shopId === owned.shop!.shop_id
      ? state.history
      : null;
  const rows = history?.items ?? [];
  const fullHistory =
    !!history &&
    !history.stale &&
    history.historyComplete &&
    history.nextCursor === null;
  const upgraded = !!owned && owned.shop!.production_slots === "2";
  const sold =
    upgraded ||
    !!owned?.upgrade?.sold_both ||
    rows.some((r) => r.kind === "customer_sale") ||
    (!!history && BigInt(history.costs.recorded_sales_revenue) > 0n);
  const listed =
    sold ||
    !!owned?.ownListings?.some(
      (l) =>
        l.shop_id === owned.shop!.shop_id &&
        l.owner.kind === "player" &&
        l.owner.account_id === account,
    );
  const crafted =
    listed ||
    !!owned?.upgrade?.completed_both ||
    rows.some((r) => r.kind === "production_completed") ||
    !!owned?.production?.items.some(
      (j) =>
        j.shop_id === owned.shop!.shop_id &&
        j.owner.kind === "player" &&
        j.owner.account_id === account &&
        j.status === "completed",
    );
  const started =
    rows.some((r) => r.kind === "production_started") ||
    !!owned?.production?.items.some(
      (j) =>
        j.shop_id === owned.shop!.shop_id &&
        j.owner.kind === "player" &&
        j.owner.account_id === account &&
        j.status === "running",
    );
  const bought =
    crafted ||
    started ||
    rows.some((r) => r.kind === "material_purchase") ||
    (!!history && BigInt(history.costs.recorded_material_spending) > 0n);
  const registered =
    inScope &&
    !!o?.player &&
    o.player.account_id === account &&
    o.player.grant_issued;
  const done = [registered, !!owned, bought, crafted, listed, sold, upgraded];
  const known = [
    inScope,
    inScope,
    fullHistory,
    fullHistory || (!!owned?.production && !owned.production.historyGap),
    !!owned?.ownListings,
    fullHistory,
    !!owned,
  ];
  const steps: FirstLoopStep[] = firstLoopSteps.map((step, i) => ({
    ...step,
    status: done[i] ? "confirmed" : known[i] ? "not_confirmed" : "unknown",
    evidence: done[i]
      ? i >= 2 && ((i < 5 && sold) || (i < 4 && listed) || (i < 3 && crafted))
        ? "Confirmed by a later workflow prerequisite."
        : "Confirmed shop state or recorded receipt history."
      : known[i]
        ? "No confirmation in the observed state."
        : "Earlier or additional confirmed history may be unavailable. Do not repeat a purchase just to satisfy the guide.",
  }));
  const current = steps.find((s) => s.status !== "confirmed") ?? null;
  let action = nextTownAction(state, kind, now);
  const fresh = inScope && townSnapshotFresh(state, now);
  if (fresh && !state.pending && !owned?.town.paused && current) {
    const set = (
      title: string,
      detail: string,
      target: TownNextAction["target"],
      tab: TownNextAction["tab"] = "overview",
    ) => ({ title, detail, target, tab });
    if (current.id === "buy")
      action =
        current.status === "unknown"
          ? set(
              "Check your recorded progress",
              "Open History or load more confirmed activity before repeating an earlier purchase.",
              "manager",
              "history",
            )
          : set("Review your first ingredients", current.detail, "market");
    if (current.id === "list")
      action = set(
        "List your first product",
        current.detail,
        "manager",
        "listings",
      );
    if (current.id === "sale")
      action =
        current.status === "unknown"
          ? set(
              "Check for your first confirmed sale",
              "Open History to confirm earlier sales before assuming stock has never sold.",
              "manager",
              "history",
            )
          : set(
              "Review unsold stock and demand",
              "No sale is confirmed in the loaded history. Check listed stock, prices, shared customer budgets and quotas; adjust or wait for funded demand.",
              "manager",
              "listings",
            );
    // Upgrade preparation reuses the safe current next action: buy/craft/list to earn it.
  }
  return {
    scope: inScope ? `${account}:${owned?.shop?.shop_id ?? "unclaimed"}` : null,
    steps,
    completed: steps.filter((s) => s.status === "confirmed").length,
    current,
    fresh,
    blocked: !!state.pending,
    action,
  };
}

/** Notifications are ephemeral and deduped; they never become progress authority. */
export class TutorialGoalTracker {
  private scope: string | null = null;
  private highest = 0;
  observe(view: FirstLoopTutorial): string | null {
    if (view.scope !== this.scope) {
      this.scope = view.scope;
      this.highest = view.completed;
      return null;
    }
    if (
      !view.scope ||
      !view.fresh ||
      view.blocked ||
      view.completed <= this.highest
    )
      return null;
    this.highest = view.completed;
    return view.current
      ? `Confirmed progress updated. Next goal: ${view.current.title}.`
      : "First loop confirmed: your second production slot is unlocked.";
  }
}
