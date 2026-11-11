import { planLivingTownProduction } from "@bot-bazaar/chain";
import type {
  livingTownRecipe,
  livingTownProductionJob,
} from "@bot-bazaar/chain";
import type { TownObservation } from "./living-town-controller";

export type TownRecipe = ReturnType<typeof livingTownRecipe>;
export type TownJob = ReturnType<typeof livingTownProductionJob>;
export interface ProductionReview {
  accountId: string;
  shopId: string;
  shopRevision: string;
  ledgerRevision: string;
  recipe: TownRecipe;
  quantity: string;
  inputs: { id: string; required: string; held: string; available: string }[];
  output: string;
  durationSeconds: string;
}
export function productionQuote(
  o: TownObservation | null,
  recipe: TownRecipe,
  quantity: string,
): { review: ProductionReview | null; reason: string } {
  if (!/^(?:[1-9]|10)$/.test(quantity))
    return { review: null, reason: "Choose a whole batch from 1 to 10." };
  if (
    !o?.shop ||
    !o.ledger ||
    !o.production ||
    !o.chainTimestampNs ||
    !o.accountId ||
    o.shop.owner.kind !== "player" ||
    o.shop.owner.account_id !== o.accountId
  )
    return {
      review: null,
      reason: "Your workshop is loading.",
    };
  let terms: ReturnType<typeof planLivingTownProduction>;
  try {
    terms = planLivingTownProduction(recipe, "1", quantity, o.chainTimestampNs);
  } catch {
    return {
      review: null,
      reason:
        "Recipes are updating. Try again shortly.",
    };
  }
  const inputs = Object.entries(terms.inputs_consumed)
    .filter(([, q]) => q !== "0")
    .map(([id, required]) => ({
      id,
      required,
      held: o.ledger!.inventory.held[id as keyof typeof terms.inputs_consumed],
      available:
        o.ledger!.inventory.available[id as keyof typeof terms.inputs_consumed],
    }));
  const review: ProductionReview = {
    accountId: o.accountId,
    shopId: o.shop.shop_id,
    shopRevision: o.shop.revision,
    ledgerRevision: o.ledger.revision,
    recipe,
    quantity,
    inputs,
    output: terms.output_quantity,
    durationSeconds: (
      BigInt(recipe.duration_seconds) * BigInt(quantity)
    ).toString(),
  };
  let reason = "";
  if (o.stale) reason = "Your materials are updating. Please wait a moment.";
  else if (o.town.paused)
    reason = "Crafting is temporarily paused.";
  else if (
    o.production.items.filter((j) => j.status === "running").length >=
    Number(o.shop.production_slots)
  )
    reason = "Your workshop is busy. Collect a ready batch or wait for a free slot.";
  else if (inputs.some((i) => BigInt(i.available) < BigInt(i.required)))
    reason = "You need more available materials for this batch.";
  else if (
    BigInt(o.ledger.inventory.held[recipe.output_item]) +
      BigInt(
        o.ledger.inventory.production_output_reserved[recipe.output_item],
      ) +
      BigInt(o.ledger.inventory.trade_inbound_reserved[recipe.output_item]) +
      BigInt(terms.output_quantity) >
    1000n
  )
    reason = "Make room in your inventory before crafting this batch.";
  return { review, reason };
}
export function productionReviewMatches(
  review: ProductionReview,
  o: TownObservation | null,
): boolean {
  const recipe = o?.recipes?.find(
    (r) => r.recipe_id === review.recipe.recipe_id,
  );
  if (!recipe) return false;
  const next = productionQuote(o, recipe, review.quantity);
  return !next.reason && JSON.stringify(next.review) === JSON.stringify(review);
}
export function productionCountdown(
  job: TownJob,
  chainNs: string | undefined,
  elapsedMs: number,
): { state: "running" | "ready" | "completed"; text: string } {
  if (job.status === "completed")
    return { state: "completed", text: "Collected" };
  if (!chainNs) return { state: "running", text: "Updating crafting progress..." };
  // Elapsed time animates an estimate only. Cap it at the observation freshness
  // window; only finalized chain time may enable Claim or change inventory.
  const elapsed = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.min(30000, Math.floor(elapsedMs)))
    : 0;
  const remaining =
    BigInt(job.ready_at_ns) - BigInt(chainNs) - BigInt(elapsed) * 1000000n;
  if (remaining <= 0n)
    return {
      state: "ready",
      text:
        BigInt(chainNs) >= BigInt(job.ready_at_ns)
          ? "Ready to collect"
          : "Finishing up. Checking your batch.",
    };
  return {
    state: "running",
    text: `About ${durationText(((remaining + 999999999n) / 1000000000n).toString())} remaining`,
  };
}
export function durationText(seconds: string): string {
  const n = BigInt(seconds);
  return `${n / 60n}m ${n % 60n}s`;
}
export function itemSymbol(id: string): string {
  return (
    (
      {
        crystal: "◆",
        wood: "▰",
        herb: "❧",
        iron: "⬡",
        health_potion: "⚗",
        iron_tool: "⚒",
      } as Record<string, string>
    )[id] ?? "◇"
  );
}
