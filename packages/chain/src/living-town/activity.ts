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
export const townAgentData = object({
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
export const townAgentInput = object({
  source: choice(["deterministic_rule", "model_proposal"] as const),
  transaction_hint: nullable(hash32),
  checkpoint: townActivityCheckpoint,
  data: townAgentData,
});
const common = { event_id: townActivityId, checkpoint: townActivityCheckpoint };
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
export type TownActivity =
  | ReturnType<typeof market>
  | ReturnType<typeof sale>
  | ReturnType<typeof ready>
  | ReturnType<typeof agent>;
export function livingTownActivity(value: unknown): TownActivity {
  const r = record(value),
    v =
      r["type"] === "market_event"
        ? market(value)
        : r["type"] === "sale_confirmed"
          ? sale(value)
          : r["type"] === "production_ready"
            ? ready(value)
            : agent(value);
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
