import {
  parseU64,
  livingTownSnapshot,
  livingTownTown,
  createLivingTownCall,
} from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";
import type {
  MerchantAction,
  MerchantPolicyInput,
  LivingTownMerchantPolicy,
} from "./merchant-policy.js";
import type { TownCall } from "./town-chain.js";
const names = ["rex", "luna", "bolt"] as const;
export type ProposalMerchant = (typeof names)[number];
const items = [
  "crystal",
  "wood",
  "herb",
  "iron",
  "health_potion",
  "iron_tool",
] as const;
export type TownProposal = {
  schema: "living-town-proposal-v1";
  tick_id: string;
  market_revision: string;
  merchant_id: ProposalMerchant;
  reason: string;
  action:
    | { type: "wait" }
    | { type: "adjust_price"; item_id: string; unit_price: string }
    | { type: "restock"; item_id: string }
    | {
        type: "propose_trade";
        counterparty: ProposalMerchant;
        side: "buy" | "sell";
        item_id: string;
        quantity: string;
        unit_price: string;
      }
    | {
        type: "accept_trade";
        offer_id: string;
        expected_offer_revision: string;
      }
    | { type: "reject_trade"; offer_id: string };
};
function obj(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireStorage(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "invalid proposal object",
  );
  const d = Object.getOwnPropertyDescriptors(value);
  requireStorage(
    Reflect.ownKeys(value).length === keys.length &&
      keys.every(
        (k) =>
          Object.hasOwn(d, k) &&
          d[k]!.enumerable &&
          Object.hasOwn(d[k]!, "value"),
      ),
    "invalid proposal fields",
  );
  return value as Record<string, unknown>;
}
function decimal(value: unknown, max = 18446744073709551615n): string {
  const s = parseU64(value);
  requireStorage(
    BigInt(s) > 0n && BigInt(s) <= max,
    "proposal integer outside bounds",
  );
  return s;
}
function member<T extends string>(v: unknown, values: readonly T[]): T {
  requireStorage(values.includes(v as T), "unsupported proposal value");
  return v as T;
}
export function parseTownProposal(value: unknown): TownProposal {
  const p = obj(value, [
    "schema",
    "tick_id",
    "market_revision",
    "merchant_id",
    "reason",
    "action",
  ]);
  requireStorage(
    p["schema"] === "living-town-proposal-v1" &&
      typeof p["tick_id"] === "string" &&
      /^[a-f0-9]{64}$/.test(p["tick_id"]),
    "invalid proposal version/tick",
  );
  requireStorage(
    typeof p["reason"] === "string" && /^[\x20-\x7e]{1,240}$/.test(p["reason"]),
    "invalid proposal reason",
  );
  const raw = p["action"],
    type =
      raw && typeof raw === "object"
        ? Object.getOwnPropertyDescriptor(raw, "type")?.value
        : undefined;
  let action: TownProposal["action"];
  if (type === "wait") {
    obj(raw, ["type"]);
    action = { type };
  } else if (type === "adjust_price") {
    const a = obj(raw, ["type", "item_id", "unit_price"]);
    action = {
      type,
      item_id: member(a["item_id"], items),
      unit_price: decimal(a["unit_price"], 100n),
    };
  } else if (type === "restock") {
    const a = obj(raw, ["type", "item_id"]);
    action = { type, item_id: member(a["item_id"], items) };
  } else if (type === "propose_trade") {
    const a = obj(raw, [
      "type",
      "counterparty",
      "side",
      "item_id",
      "quantity",
      "unit_price",
    ]);
    action = {
      type,
      counterparty: member(a["counterparty"], names),
      side: member(a["side"], ["buy", "sell"]),
      item_id: member(a["item_id"], items),
      quantity: decimal(a["quantity"], 100n),
      unit_price: decimal(a["unit_price"], 100n),
    };
    requireStorage(
      action.counterparty !== p["merchant_id"],
      "self trade proposal",
    );
  } else if (type === "accept_trade") {
    const a = obj(raw, ["type", "offer_id", "expected_offer_revision"]);
    action = {
      type,
      offer_id: decimal(a["offer_id"]),
      expected_offer_revision: decimal(a["expected_offer_revision"]),
    };
  } else if (type === "reject_trade") {
    const a = obj(raw, ["type", "offer_id"]);
    action = { type, offer_id: decimal(a["offer_id"]) };
  } else throw new Error("unsupported town proposal action");
  return {
    schema: "living-town-proposal-v1",
    tick_id: p["tick_id"] as string,
    market_revision: decimal(p["market_revision"]),
    merchant_id: member(p["merchant_id"], names),
    reason: p["reason"],
    action,
  };
}
const schemaObject = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const integer = {
  type: "string",
  pattern: "^[1-9][0-9]{0,19}$(?![\\s\\S])",
  maxLength: 20,
};
const enumItem = { type: "string", enum: items },
  enumMerchant = { type: "string", enum: names };
export const townProposalSchema = schemaObject({
  schema: { const: "living-town-proposal-v1" },
  tick_id: { type: "string", pattern: "^[a-f0-9]{64}$(?![\\s\\S])" },
  market_revision: integer,
  merchant_id: enumMerchant,
  reason: {
    type: "string",
    minLength: 1,
    maxLength: 240,
    pattern: "^[ -~]+$(?![\\s\\S])",
  },
  action: {
    oneOf: [
      schemaObject({ type: { const: "wait" } }),
      schemaObject({
        type: { const: "adjust_price" },
        item_id: enumItem,
        unit_price: integer,
      }),
      schemaObject({ type: { const: "restock" }, item_id: enumItem }),
      schemaObject({
        type: { const: "propose_trade" },
        counterparty: enumMerchant,
        side: { enum: ["buy", "sell"] },
        item_id: enumItem,
        quantity: integer,
        unit_price: integer,
      }),
      schemaObject({
        type: { const: "accept_trade" },
        offer_id: integer,
        expected_offer_revision: integer,
      }),
      schemaObject({ type: { const: "reject_trade" }, offer_id: integer }),
    ],
  },
});
export interface ProposalResolution {
  kind: "command" | "no_op";
  reason: string;
  proposal: TownProposal;
  call: TownCall | null;
}
/** Strict local policy gate. Model JSON never names a chain method or supplies a command identity. */
export function resolveTownProposal(
  value: unknown,
  input: MerchantPolicyInput,
  tickId: string,
  merchant: ProposalMerchant,
  policy: LivingTownMerchantPolicy,
  identity: unknown,
  command: unknown,
): ProposalResolution {
  const proposal = parseTownProposal(value),
    town = livingTownSnapshot(livingTownTown)(input.town);
  requireStorage(
    proposal.tick_id === tickId &&
      proposal.merchant_id === merchant &&
      proposal.market_revision === town.market_revision,
    "stale proposal tick/actor/revision",
  );
  const signals = policy.evaluate(input),
    a = proposal.action;
  const no = (reason: string): ProposalResolution => ({
    kind: "no_op",
    reason,
    proposal,
    call: null,
  });
  if (!input.fresh || !input.historyComplete)
    return no("confirmed_facts_unavailable");
  if (a.type === "wait") return no("model_wait");
  if (["propose_trade", "accept_trade", "reject_trade"].includes(a.type))
    return no("v2_trade_not_available");
  const step = signals.decisions.find((d) => d.merchant === merchant)!.action;
  if (a.type === "restock") {
    const relevant =
      step.kind === "start_production"
        ? a.item_id === "iron_tool" && merchant === "bolt"
        : step.kind === "complete_production"
          ? merchant === "bolt" && a.item_id === "iron_tool"
          : step.kind === "set_listing"
            ? step.item === a.item_id ||
              (merchant === "bolt" &&
                a.item_id === "iron_tool" &&
                step.reason === "release_inputs_before_crafting")
            : true;
    if (!relevant) return no("policy_prioritizes_other_item");
    return {
      kind: step.kind === "wait" ? "no_op" : "command",
      reason: step.reason,
      proposal,
      call:
        policy.compile(input, merchant, step, identity, command)?.call ?? null,
    };
  }
  if (a.type !== "adjust_price") return no("unsupported_action");
  if (town.data.paused) return no("paused");
  const row = input.merchants.find(
    (r) =>
      (r.shop as { data: { owner: { merchant_id?: string } } }).data.owner
        .merchant_id === merchant,
  )!;
  const l = row.listings.find(
    (v) => (v as { item_id: string }).item_id === a.item_id,
  ) as
    | {
        shop_id: string;
        item_id: string;
        remaining_quantity: string;
        revision: string;
      }
    | undefined;
  const signal = signals.scarcity.find(
    (s) => s.item === a.item_id && s.supplier === merchant,
  );
  requireStorage(
    l && signal && BigInt(l.remaining_quantity) <= BigInt(signal.saleable),
    "unavailable owned price listing/reserve",
  );
  const bands: Record<string, readonly [bigint, bigint]> = {
    crystal: [4n, 6n],
    herb: [3n, 4n],
    wood: [1n, 3n],
    iron: [3n, 6n],
  };
  const price = BigInt(a.unit_price),
    band = bands[a.item_id]!;
  requireStorage(
    price >= band[0] && price <= band[1],
    "merchant price/cost band violated",
  );
  // Reuse the audited controller compiler for actor identity, then bind the reviewed price-only replacement.
  const reference: MerchantAction = step;
  policy.compile(input, merchant, reference, identity, command);
  const call = createLivingTownCall("set_listing", {
    shop_id: l.shop_id,
    item_id: l.item_id,
    quantity: l.remaining_quantity,
    unit_price: a.unit_price,
    expected_listing_revision: l.revision,
    command,
  });
  requireStorage(
    BigInt(call.args.command.valid_until_ns) >
      BigInt(town.block_timestamp_ns) &&
      BigInt(call.args.command.valid_until_ns) <=
        BigInt(town.data.genesis_time_ns) +
          (BigInt(town.data.epoch) + 1n) * 60000000000n,
    "proposal command outside epoch",
  );
  return {
    kind: "command",
    reason: "validated_price_adjustment",
    proposal,
    call,
  };
}
