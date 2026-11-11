import {
  array,
  boolean,
  bounded,
  check,
  choice,
  hash32,
  literal,
  nullable,
  object,
  parseU64,
  positiveU64,
  record,
} from "../wire.js";
import {
  livingTownItem,
  livingTownMarketEvent,
  parseLivingTownDeployment,
} from "./wire.js";
import { livingTownOffer } from "./offers.js";
const text = (v: unknown): string => {
  check(
    typeof v === "string" && /^[\x20-\x7e]{1,240}$/.test(v),
    "invalid public activity text",
  );
  return v;
};
export const townActivityId = (v: unknown): string => {
  check(
    typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    "invalid activity id",
  );
  return v;
};
export const townActivityCursor = (v: unknown): string => {
  check(
    typeof v === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(v),
    "invalid activity cursor",
  );
  return v;
};
const reference = (v: unknown): string => {
  check(
    typeof v === "string" && /^[a-zA-Z0-9:_.-]{1,128}$/.test(v),
    "invalid activity reference",
  );
  return v;
};
export const townActivityCheckpoint = object({
  block_hash: hash32,
  block_height: positiveU64,
  block_timestamp_ns: parseU64,
  market_revision: positiveU64,
  event_sequence: positiveU64,
});
const agentDataShape = object({
  action_id: townActivityId,
  tick_id: townActivityId,
  merchant: choice(["rex", "luna", "bolt"] as const),
  proposal_type: choice([
    "adjust_price",
    "propose_trade",
    "accept_trade",
    "reject_trade",
    "restock",
    "wait",
  ] as const),
  reason: text,
  validation: text,
  outcome: choice([
    "proposal",
    "awaiting_confirmation",
    "local_no_op",
    "rejected",
    "expired",
    "confirmed",
    "thinking",
    "submitted",
    "unknown",
  ] as const),
  command_digest: nullable(townActivityId),
  inference_ref: nullable(reference),
  signals: array(
    object({
      item_id: livingTownItem,
      held: bounded(0n, 1000n),
      reserved: bounded(0n, 1000n),
      scarcity_bps: bounded(0n, 10000n),
      confirmed_demand: nullable(parseU64),
      suggested_price: nullable(bounded(1n, 100n)),
    }),
    4,
  ),
  transaction_hash: nullable(hash32),
  receipt_id: nullable(hash32),
});
export function townAgentData(
  value: unknown,
): ReturnType<typeof agentDataShape> & { offer_id?: string | null } {
  const r = record(value),
    { offer_id, ...rest } = r,
    b = agentDataShape(rest);
  return Object.hasOwn(r, "offer_id")
    ? { ...b, offer_id: nullable(positiveU64)(offer_id) }
    : b;
}
export const townAgentInput = object({
  source: choice(["deterministic_rule", "model_proposal"] as const),
  transaction_hint: nullable(hash32),
  checkpoint: townActivityCheckpoint,
  data: townAgentData,
});
const common = { event_id: townActivityId, checkpoint: townActivityCheckpoint };
const transaction = object({
  ...common,
  type: literal("transaction_confirmed"),
  source: literal("confirmed"),
  data: object({ title: text, transaction_hash: hash32, receipt_id: hash32 }),
});
const market = object({
  ...common,
  type: literal("market_event"),
  source: choice(["confirmed", "chain_boundary_observation"] as const),
  data: object({
    event: livingTownMarketEvent,
    boundary: choice(["scheduled", "start", "end"] as const),
    observed_epoch: parseU64,
    delayed: boolean,
    transaction_hash: nullable(hash32),
    receipt_id: nullable(hash32),
  }),
});
const sale = object({
  ...common,
  type: literal("sale_confirmed"),
  source: literal("confirmed"),
  data: object({
    trade_id: positiveU64,
    listing_id: positiveU64,
    item_id: livingTownItem,
    quantity: bounded(1n, 100n),
    total_price: bounded(1n, 10000n),
    transaction_hash: hash32,
    receipt_id: hash32,
    effect_event_sequence: positiveU64,
  }),
});
const ready = object({
  ...common,
  type: literal("production_ready"),
  source: literal("production_ready_hint"),
  data: object({
    job_id: positiveU64,
    shop_id: positiveU64,
    recipe_id: choice(["health_potion", "iron_tool"] as const),
    ready_at_ns: parseU64,
  }),
});
const agent = object({
  ...common,
  type: literal("agent_action"),
  source: choice([
    "deterministic_rule",
    "model_proposal",
    "confirmed",
  ] as const),
  data: townAgentData,
});
const economy = object({
  ...common,
  type: literal("merchant_economy"),
  source: literal("confirmed"),
  data: object({
    merchant: choice(["rex", "luna", "bolt"] as const),
    kind: choice([
      "source",
      "proposed",
      "accepted",
      "rejected",
      "cancelled",
      "expired",
    ] as const),
    offer: nullable(livingTownOffer),
    item_id: livingTownItem,
    quantity: bounded(0n, 100n),
    trade_id: nullable(positiveU64),
    transaction_hash: hash32,
    receipt_id: hash32,
  }),
});
export type TownActivity =
  | ReturnType<typeof transaction>
  | ReturnType<typeof market>
  | ReturnType<typeof sale>
  | ReturnType<typeof ready>
  | ReturnType<typeof agent>
  | ReturnType<typeof economy>;
export function livingTownActivity(value: unknown): TownActivity {
  const r = record(value),
    v =
      r["type"] === "transaction_confirmed"
        ? transaction(value)
        : r["type"] === "market_event"
        ? market(value)
        : r["type"] === "sale_confirmed"
          ? sale(value)
          : r["type"] === "production_ready"
            ? ready(value)
            : r["type"] === "merchant_economy"
              ? economy(value)
              : agent(value);
  if (v.type === "merchant_economy") {
    const d = v.data,
      o = d.offer;
    check(
      d.kind === "source"
        ? o === null &&
            d.trade_id === null &&
            ["crystal", "wood", "herb", "iron"].includes(d.item_id) &&
            BigInt(d.quantity) <= 2n
        : !!o &&
            [o.buyer, o.seller].includes(d.merchant) &&
            o.item_id === d.item_id &&
            o.quantity === d.quantity &&
            o.status === (d.kind === "proposed" ? "pending" : d.kind) &&
            d.trade_id === o.trade_id,
      "merchant economy evidence mismatch",
    );
  }
  if (v.type === "market_event")
    check(
      v.data.boundary === "scheduled"
        ? v.source === "confirmed" &&
            v.data.transaction_hash !== null &&
            v.data.receipt_id !== null
        : v.source === "chain_boundary_observation" &&
            v.data.transaction_hash === null &&
            v.data.receipt_id === null,
      "invalid market activity provenance",
    );
  if (v.type === "agent_action")
    check(
      v.data.outcome === "confirmed"
        ? v.source === "confirmed" &&
            v.data.transaction_hash !== null &&
            v.data.receipt_id !== null
        : v.source !== "confirmed" &&
            v.data.transaction_hash === null &&
            v.data.receipt_id === null,
      "invalid agent activity provenance",
    );
  return v;
}
export function townActivityPosition(value: unknown): {
  generation: string;
  identity: string;
  sequence: number;
} {
  const cursor = townActivityCursor(value),
    raw = cursor.replaceAll("-", "+").replaceAll("_", "/");
  let c: Record<string, unknown>;
  try {
    c = record(JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))));
  } catch {
    throw new Error("invalid activity cursor");
  }
  check(
    Object.keys(c).sort().join() === "generation,identity,sequence",
    "invalid activity cursor fields",
  );
  check(
    typeof c["sequence"] === "number" &&
      Number.isSafeInteger(c["sequence"]) &&
      c["sequence"] >= 0,
    "invalid activity position",
  );
  return {
    generation: reference(c["generation"]),
    identity: townActivityId(c["identity"]),
    sequence: c["sequence"],
  };
}
const activityPageShape = object({
  schema: literal("living-town-activity-v1"),
  deployment: parseLivingTownDeployment,
  code_hash: hash32,
  feed_generation: reference,
  events: array(
    object({ cursor: townActivityCursor, event: livingTownActivity }),
    50,
  ),
  next_cursor: townActivityCursor,
  has_more: boolean,
});
export function livingTownActivityPage(
  value: unknown,
): ReturnType<typeof activityPageShape> {
  const p = activityPageShape(value),
    end = townActivityPosition(p.next_cursor);
  let last = -1;
  check(end.generation === p.feed_generation, "activity generation mismatch");
  for (const row of p.events) {
    const c = townActivityPosition(row.cursor);
    check(
      c.generation === p.feed_generation &&
        c.identity === end.identity &&
        c.sequence > last,
      "activity cursor order/binding mismatch",
    );
    last = c.sequence;
  }
  check(
    p.events.length === 0 || p.events.at(-1)!.cursor === p.next_cursor,
    "activity page cursor mismatch",
  );
  return p;
}
