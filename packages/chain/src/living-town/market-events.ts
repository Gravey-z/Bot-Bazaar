import { array, check, literal, object, parseU64 } from "../wire.js";
import {
  livingTownMarketEvent,
  livingTownProductionEffectBase,
} from "./wire.js";

export function livingTownMarketEventEffect(value: unknown): ReturnType<
  typeof livingTownProductionEffectBase
> & {
  outcome: {
    kind: "market_event_scheduled";
    event: ReturnType<typeof livingTownMarketEvent>;
  };
} {
  const base = livingTownProductionEffectBase(value),
    outcome = object({
      kind: literal("market_event_scheduled"),
      event: livingTownMarketEvent,
    })(base.outcome);
  check(
    base.principal.startsWith("account:") &&
      base.effect_revision === base.effect_event_sequence &&
      base.effect_revision === outcome.event.revision,
    "market event effect mismatch",
  );
  return { ...base, outcome };
}
const historyShape = object({
  items: array(livingTownMarketEvent, 32),
  pruned_through: parseU64,
});
export function livingTownMarketEventHistory(
  value: unknown,
): ReturnType<typeof historyShape> {
  const h = historyShape(value);
  h.items.forEach((e, i) =>
    check(
      BigInt(e.event_id) === BigInt(h.pruned_through) + BigInt(i) + 1n &&
        (i === 0 || BigInt(e.start_epoch) > BigInt(h.items[i - 1]!.end_epoch)),
      "market event history gap/overlap",
    ),
  );
  return h;
}
export function describeLivingTownMarketEvent(
  event: unknown,
  epoch: string,
): {
  status: "scheduled" | "active" | "ended";
  baseline: string;
  current: string;
  explanation: string;
} {
  const e = livingTownMarketEvent(event),
    n = BigInt(parseU64(epoch));
  const status =
    n < BigInt(e.start_epoch)
      ? "scheduled"
      : n < BigInt(e.end_epoch)
        ? "active"
        : "ended";
  return {
    status,
    baseline: "8",
    current: status === "active" ? "4" : "8",
    explanation: `Herb shortage ${status}. Epochs ${e.start_epoch} through ${BigInt(e.end_epoch) - 1n}: herb replenishment is capped at 4 instead of 8 units per epoch. Normal replenishment resumes at epoch ${e.end_epoch}; stock already held is preserved.`,
  };
}
