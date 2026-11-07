import { array, bounded, check, choice, object } from "../wire.js";
const shape = object({
  recommendation_budget: bounded(0n, 10000n),
  allowed_items: array(choice(["crystal", "wood", "herb", "iron"] as const), 4),
  min_cash_reserve: bounded(0n, 1000000n),
  per_tick_limit: bounded(0n, 1000000n),
  per_day_limit: bounded(0n, 1000000n),
});
export type AssistantRestockLimits = ReturnType<typeof shape>;
export function assistantRestockLimits(value: unknown): AssistantRestockLimits {
  const p = shape(value);
  check(
    new Set(p.allowed_items).size === p.allowed_items.length,
    "duplicate restock item",
  );
  return { ...p, allowed_items: [...p.allowed_items].sort() };
}
export function defaultAssistantRestockLimits(): AssistantRestockLimits {
  return assistantRestockLimits({
    recommendation_budget: "100",
    allowed_items: ["crystal", "wood", "herb", "iron"],
    min_cash_reserve: "20",
    per_tick_limit: "100",
    per_day_limit: "500",
  });
}
