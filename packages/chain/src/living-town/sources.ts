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
  issued_quantity: bounded(0n, 8n),
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
export function livingTownSourceEffect(value: unknown): ReturnType<
  typeof livingTownProductionEffectBase
> & {
  outcome: ReturnType<typeof supplied> | ReturnType<typeof swept>;
} {
  const b = livingTownProductionEffectBase(value);
  const outcome =
    record(b.outcome)["kind"] === "raw_supplied"
      ? supplied(b.outcome)
      : swept(b.outcome);
  check(
    b.principal.startsWith("account:") &&
      b.effect_revision === b.effect_event_sequence &&
      outcome.ledger.actor.kind === "merchant" &&
      outcome.ledger.actor.merchant_id === outcome.merchant_id,
    "source principal/ledger mismatch",
  );
  if (outcome.kind === "raw_supplied") {
    const item = outcome.item_id,
      supplier = { crystal: "rex", wood: "bolt", herb: "luna", iron: "bolt" }[
        item
      ],
      event = outcome.market_event,
      active =
        event !== null &&
        BigInt(outcome.epoch) >= BigInt(event.start_epoch) &&
        BigInt(outcome.epoch) < BigInt(event.end_epoch),
      ceiling =
        item === "herb" && active
          ? 4n
          : { crystal: 4n, wood: 4n, herb: 8n, iron: 8n }[item],
      target = { crystal: 10n, wood: 10n, herb: 20n, iron: 20n }[item],
      held = BigInt(outcome.ledger.inventory.held[item]),
      issued = BigInt(outcome.issued_quantity),
      old = held - issued;
    const deficit = target > old ? target - old : 0n;
    const capacity =
      1000n -
      old -
      BigInt(outcome.ledger.inventory.production_output_reserved[item]) -
      BigInt(outcome.ledger.inventory.trade_inbound_reserved[item]);
    check(
      outcome.merchant_id === supplier &&
        old >= 0n &&
        capacity >= 0n &&
        issued ===
          [deficit, ceiling, capacity].reduce((a, b) => (a < b ? a : b)),
      "raw source formula mismatch",
    );
  } else {
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
