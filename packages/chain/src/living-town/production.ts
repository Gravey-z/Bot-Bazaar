import {
  object,
  positiveU64,
  literal,
  choice,
  bounded,
  nullable,
  parseU64,
  check,
} from "../wire.js";
import {
  livingTownActor,
  livingTownLedger,
  livingTownProductionEffectBase,
} from "./wire.js";
import { livingTownProductionTerms } from "./recipes.js";

function decodeJob(value: unknown) {
  // Parse the immutable P2.1 terms separately from job identity/lifecycle fields.
  const row = object({
    job_id: positiveU64,
    shop_id: positiveU64,
    owner: livingTownActor,
    recipe_id: (v: unknown) => v,
    recipe_version: (v: unknown) => v,
    config_version: (v: unknown) => v,
    quantity: (v: unknown) => v,
    inputs_consumed: (v: unknown) => v,
    output_item: (v: unknown) => v,
    output_quantity: (v: unknown) => v,
    start_at_ns: (v: unknown) => v,
    ready_at_ns: (v: unknown) => v,
    completed_at_ns: nullable(parseU64),
    status: choice(["running", "completed"] as const),
    start_command_sequence: positiveU64,
    revision: bounded(1n, 2n),
  })(value);
  const {
    job_id,
    shop_id,
    owner,
    completed_at_ns,
    status,
    start_command_sequence,
    revision,
    ...raw
  } = row;
  const terms = livingTownProductionTerms(raw);
  check(
    owner.kind === "player"
      ? BigInt(shop_id) > 3n
      : shop_id ===
          String(["rex", "luna", "bolt"].indexOf(owner.merchant_id) + 1),
    "Production shop owner mismatch",
  );
  check(
    status === "running"
      ? completed_at_ns === null && revision === "1"
      : completed_at_ns !== null &&
          BigInt(completed_at_ns) >= BigInt(terms.ready_at_ns) &&
          revision === "2",
    "Production lifecycle mismatch",
  );
  return {
    ...terms,
    job_id,
    shop_id,
    owner,
    completed_at_ns,
    status,
    start_command_sequence,
    revision,
  };
}
export function livingTownProductionJob(
  value: unknown,
): ReturnType<typeof decodeJob> {
  return decodeJob(value);
}
const outcome = object({
  kind: literal("production_started"),
  job: livingTownProductionJob,
  ledger: livingTownLedger,
});
function decodeEffect(value: unknown) {
  const base = livingTownProductionEffectBase(value),
    result = { ...base, outcome: outcome(base.outcome) };
  const j = result.outcome.job,
    l = result.outcome.ledger;
  const principal =
    j.owner.kind === "player"
      ? `account:${j.owner.account_id}`
      : `merchant:${j.owner.merchant_id}`;
  check(
    j.status === "running" &&
      result.principal === principal &&
      JSON.stringify(j.owner) === JSON.stringify(l.actor) &&
      result.command_sequence === j.start_command_sequence &&
      result.effect_revision === result.effect_event_sequence &&
      BigInt(l.inventory.production_output_reserved[j.output_item]) >=
        BigInt(j.output_quantity),
    "Production effect identity or reservation mismatch",
  );
  return result;
}

export function livingTownProductionEffect(
  value: unknown,
): ReturnType<typeof decodeEffect> {
  return decodeEffect(value);
}
