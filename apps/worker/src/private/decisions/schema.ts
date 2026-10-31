import { createMarketCall, parseU64 } from "@bot-bazaar/chain";
import type { CallArgs } from "@bot-bazaar/chain";

export const decisionSchemaVersion = "merchant-decision-v1";
export type DecisionAction =
  | { method: "hold" }
  | { method: "reject_trade"; offer_id: string }
  | { method: "set_listing"; args: CallArgs<"set_listing"> }
  | { method: "propose_trade"; args: CallArgs<"propose_trade"> }
  | { method: "accept_trade"; args: CallArgs<"accept_trade"> };
export interface Decision {
  action: DecisionAction;
  reason: string;
}
export class DecisionValidationError extends Error {
  constructor() {
    super("invalid merchant decision");
    this.name = "DecisionValidationError";
  }
}

// Require the absolute end: JavaScript's $ alone accepts a final line terminator.
const positive = {
  type: "string",
  pattern: "^[1-9][0-9]{0,19}$(?![\\s\\S])",
  maxLength: 20,
} as const;
const quantity = {
  type: "string",
  pattern: "^([1-9][0-9]?|100)$(?![\\s\\S])",
} as const;
const listingQuantity = {
  type: "string",
  pattern: "^(0|[1-9][0-9]?|100)$(?![\\s\\S])",
} as const;
const total = {
  type: "string",
  pattern: "^([1-9][0-9]{0,3}|10000)$(?![\\s\\S])",
} as const;
const merchantId = { type: "string", enum: ["rex", "luna", "bolt"] } as const;
const resource = {
  type: "string",
  enum: ["crystal", "wood", "herb", "iron"],
} as const;
function object<const T extends Record<string, unknown>>(properties: T) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const;
}
const actions = {
  hold: object({ method: { const: "hold" } }),
  reject_trade: object({
    method: { const: "reject_trade" },
    offer_id: positive,
  }),
  set_listing: object({
    method: { const: "set_listing" },
    args: object({
      merchant_id: merchantId,
      resource,
      unit_price: quantity,
      quantity: listingQuantity,
      active: { type: "boolean" },
      expected_version: positive,
      action_id: positive,
    }),
  }),
  propose_trade: object({
    method: { const: "propose_trade" },
    args: object({
      proposer: merchantId,
      buyer: merchantId,
      seller: merchantId,
      resource,
      quantity,
      total_price: total,
      expires_at_ns: positive,
      action_id: positive,
    }),
  }),
  accept_trade: object({
    method: { const: "accept_trade" },
    args: object({ offer_id: positive, action_id: positive }),
  }),
} as const;

// Provider-neutral JSON Schema. Exact u64 bounds and cross-field contract rules
// are additionally checked locally; provider structured output never grants authority.
export const decisionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...object({
    action: { oneOf: Object.values(actions) },
    reason: { type: "string", minLength: 1, maxLength: 240 },
  }),
} as const;

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new DecisionValidationError();
  const own = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    own.length !== keys.length ||
    !keys.every(
      (key) =>
        Object.hasOwn(descriptors, key) &&
        descriptors[key]!.enumerable &&
        Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    throw new DecisionValidationError();
  return value as Record<string, unknown>;
}
export function parseDecisionAction(value: unknown): DecisionAction {
  try {
    // Inspect the discriminator without invoking an accessor or accepting inheritance.
    const method =
      value !== null && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "method")?.value
        : undefined;
    if (typeof method !== "string" || !Object.hasOwn(actions, method))
      throw new DecisionValidationError();
    const shape = actions[method as keyof typeof actions];
    const fields = exactObject(value, shape.required);
    if (method === "hold") return { method };
    if (method === "reject_trade") {
      const offer_id = parseU64(fields["offer_id"]);
      if (offer_id === "0") throw new DecisionValidationError();
      return { method, offer_id };
    }
    if (
      method === "set_listing" ||
      method === "propose_trade" ||
      method === "accept_trade"
    ) {
      const args = exactObject(
        fields["args"],
        Object.keys(actions[method].properties.args.properties),
      );
      // The chain decoder checks unknown fields, canonical strings, exact bounds,
      // roles, listing activation and divisible totals, and returns a detached copy.
      switch (method) {
        case "set_listing":
          return { method, args: createMarketCall(method, args).args };
        case "propose_trade":
          return { method, args: createMarketCall(method, args).args };
        case "accept_trade":
          return { method, args: createMarketCall(method, args).args };
      }
    }
    throw new DecisionValidationError();
  } catch {
    throw new DecisionValidationError();
  }
}
export function parseDecision(value: unknown): Decision {
  try {
    const fields = exactObject(value, decisionSchema.required),
      reason = fields["reason"];
    if (
      typeof reason !== "string" ||
      reason.length < 1 ||
      reason.length > 480 ||
      Array.from(reason).length > 240
    )
      throw new DecisionValidationError();
    return { action: parseDecisionAction(fields["action"]), reason };
  } catch {
    throw new DecisionValidationError();
  }
}
