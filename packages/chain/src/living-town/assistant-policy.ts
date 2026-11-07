import {
  accountId,
  array,
  bounded,
  check,
  choice,
  literal,
  nullable,
  object,
  parseU64,
  positiveU64,
} from "../wire.js";
import { livingTownProductionEffectBase, livingTownShop } from "./wire.js";

const settings = {
  mode: choice(["off", "recommendations", "auto_reprice"] as const),
  operator_account_id: nullable(accountId),
  allowed_items: array(choice(["health_potion", "iron_tool"] as const), 2),
  min_price: bounded(1n, 100n),
  max_price: bounded(1n, 100n),
  expires_at_ns: nullable(parseU64),
};
const input = object(settings);
function validate(p: ReturnType<typeof input>): void {
  check(
    new Set(p.allowed_items).size === p.allowed_items.length,
    "duplicate assistant policy item",
  );
  check(
    BigInt(p.min_price) <= BigInt(p.max_price),
    "invalid assistant price band",
  );
  if (p.mode === "off") {
    check(
      p.operator_account_id === null &&
        p.allowed_items.length === 0 &&
        p.min_price === "1" &&
        p.max_price === "1" &&
        p.expires_at_ns === null,
      "noncanonical assistant off policy",
    );
  } else {
    check(p.allowed_items.length > 0, "assistant policy items required");
    check(
      p.mode === "auto_reprice"
        ? p.operator_account_id !== null && p.expires_at_ns !== null
        : p.operator_account_id === null,
      "invalid assistant operator/expiry scope",
    );
  }
}
export function livingTownAssistantPolicyInput(
  value: unknown,
): ReturnType<typeof input> {
  const p = input(value);
  validate(p);
  return p;
}
const row = object({
  shop_id: positiveU64,
  revision: positiveU64,
  ...settings,
});
export function livingTownAssistantPolicy(
  value: unknown,
): ReturnType<typeof row> {
  const p = row(value);
  validate(p);
  check(
    BigInt(p.shop_id) >= 4n &&
      p.allowed_items.join() === [...p.allowed_items].sort().join(),
    "invalid player policy identity/order",
  );
  return p;
}
export type LivingTownAssistantPolicy = ReturnType<
  typeof livingTownAssistantPolicy
>;

export function livingTownAssistantPolicyEffect(value: unknown): ReturnType<
  typeof livingTownProductionEffectBase
> & {
  outcome: {
    kind: "assistant_policy_set";
    policy: LivingTownAssistantPolicy;
    shop: ReturnType<typeof livingTownShop>;
  };
} {
  const base = livingTownProductionEffectBase(value),
    outcome = object({
      kind: literal("assistant_policy_set"),
      policy: livingTownAssistantPolicy,
      shop: livingTownShop,
    })(base.outcome);
  check(
    outcome.shop.owner.kind === "player" &&
      base.principal === `account:${outcome.shop.owner.account_id}` &&
      outcome.policy.shop_id === outcome.shop.shop_id &&
      outcome.policy.revision === outcome.shop.policy_revision &&
      BigInt(outcome.policy.revision) <= BigInt(outcome.shop.revision) &&
      base.effect_revision === base.effect_event_sequence,
    "assistant policy effect binding mismatch",
  );
  return { ...base, outcome };
}
