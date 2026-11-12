import {
  object,
  choice,
  parseU64,
  bounded,
  positiveU64,
  literal,
  nullable,
  record,
  check,
  array,
} from "../wire.js";
import {
  livingTownProductionEffectBase,
  livingTownLedger,
  livingTownMarketEvent,
} from "./wire.js";
export const rawSourceItem = choice([
  "crystal",
  "wood",
  "herb",
  "iron",
] as const);
export const sourceMerchant = choice(["rex", "luna", "bolt"] as const);
export const livingTownSourceState = object({
  raw_epochs: object({
    crystal: parseU64,
    wood: parseU64,
    herb: parseU64,
    iron: parseU64,
  }),
  treasury_epochs: object({ rex: parseU64, luna: parseU64, bolt: parseU64 }),
});
const supplied = object({
  kind: literal("raw_supplied"),
  item_id: rawSourceItem,
  merchant_id: sourceMerchant,
  epoch: positiveU64,
  issued_quantity: bounded(0n, 2n),
  market_event: nullable(livingTownMarketEvent),
  ledger: livingTownLedger,
});
const swept = object({
  kind: literal("treasury_swept"),
  merchant_id: sourceMerchant,
  epoch: positiveU64,
  burned_gold: bounded(0n, 100n),
  ledger: livingTownLedger,
});
const suppliedBatch = object({
  kind: literal("raw_supplies"),
  trigger_item_id: rawSourceItem,
  epoch: positiveU64,
  allocations: array(supplied, 4),
});
export function livingTownSourceEffect(value: unknown): ReturnType<
  typeof livingTownProductionEffectBase
> & {
  outcome: ReturnType<typeof supplied> | ReturnType<typeof swept> | ReturnType<typeof suppliedBatch>;
} {
  const b = livingTownProductionEffectBase(value);
  const outcome =
    record(b.outcome)["kind"] === "raw_supplied"
      ? supplied(b.outcome)
      : record(b.outcome)["kind"] === "raw_supplies" ? suppliedBatch(b.outcome) : swept(b.outcome);
  check(
    b.principal.startsWith("account:") &&
      b.effect_revision === b.effect_event_sequence,
    "source principal/ledger mismatch",
  );
  const allocations = outcome.kind === "raw_supplies" ? outcome.allocations : outcome.kind === "raw_supplied" ? [outcome] : [];
  if (outcome.kind === "raw_supplies")
    check(allocations.length > 0 && new Set(allocations.map(a => a.item_id)).size === allocations.length &&
      allocations.some(a => a.item_id === outcome.trigger_item_id) &&
      allocations.every(a => a.epoch === outcome.epoch && BigInt(a.issued_quantity) > 0n), "invalid batch supply scope");
  for (const allocation of allocations) {
    check(allocation.ledger.actor.kind === "merchant" && allocation.ledger.actor.merchant_id === allocation.merchant_id,
      "source ledger mismatch");
    const item = allocation.item_id,
      supplier = { crystal: "rex", wood: "bolt", herb: "luna", iron: "bolt" }[
        item
      ],
      event = allocation.market_event,
      active =
        event !== null &&
        BigInt(allocation.epoch) >= BigInt(event.start_epoch) &&
        BigInt(allocation.epoch) < BigInt(event.end_epoch),
      ceiling =
        BigInt(allocation.epoch) % 5n !== 0n
          ? 0n
          : item === "herb" && active
            ? 1n
            : 2n,
      target = 20n,
      held = BigInt(allocation.ledger.inventory.held[item]),
      issued = BigInt(allocation.issued_quantity),
      old = held - issued;
    const promised =
      old +
      BigInt(allocation.ledger.inventory.production_output_reserved[item]) +
      BigInt(allocation.ledger.inventory.trade_inbound_reserved[item]);
    const deficit = target > promised ? target - promised : 0n;
    const capacity =
      1000n -
      old -
      BigInt(allocation.ledger.inventory.production_output_reserved[item]) -
      BigInt(allocation.ledger.inventory.trade_inbound_reserved[item]);
    check(
      allocation.merchant_id === supplier &&
        old >= 0n &&
        capacity >= 0n &&
        issued ===
          [deficit, ceiling, capacity].reduce((a, b) => (a < b ? a : b)),
      "raw source formula mismatch",
    );
  }
  if (outcome.kind === "treasury_swept") {
    check(outcome.ledger.actor.kind === "merchant" && outcome.ledger.actor.merchant_id === outcome.merchant_id,
      "source ledger mismatch");
    const after = BigInt(outcome.ledger.gold.available),
      burn = BigInt(outcome.burned_gold),
      excess = after + burn - 200n;
    check(
      burn === (excess <= 0n ? 0n : excess < 100n ? excess : 100n),
      "treasury sink formula mismatch",
    );
  }
  return { ...b, outcome };
}
