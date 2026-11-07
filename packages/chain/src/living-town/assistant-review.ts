import {
  accountId,
  array,
  bounded,
  check,
  choice,
  hash32,
  literal,
  object,
  parseU64,
  positiveU64,
  record,
} from "../wire.js";
import { livingTownDigest, parseLivingTownDeployment } from "./wire.js";
import { canonicalLivingTownJson, livingTownJsonDigest } from "./json.js";
import { createLivingTownCall } from "./calls.js";
import type { LivingTownCall } from "./calls.js";

const reason = (v: unknown): string => {
  check(
    typeof v === "string" && /^[\x20-\x7e]{1,240}$/.test(v) && !/[<>]/.test(v),
    "invalid assistant reason",
  );
  return v;
};
const price = object({
  type: literal("suggest_price"),
  item_id: choice(["health_potion", "iron_tool"] as const),
  listing_id: positiveU64,
  expected_listing_revision: positiveU64,
  current_unit_price: bounded(1n, 100n),
  suggested_unit_price: bounded(1n, 100n),
});
const restock = object({
  type: literal("suggest_restock"),
  item_id: choice(["crystal", "wood", "herb", "iron"] as const),
  listing_id: positiveU64,
  expected_listing_revision: positiveU64,
  seller_shop_id: bounded(1n, 3n),
  quantity: bounded(1n, 100n),
  unit_price: bounded(1n, 100n),
  total_price: bounded(1n, 10000n),
});
const proposalShape = object({
  schema: literal("living-town-assistant-proposal-v1"),
  proposal_id: livingTownDigest,
  shop_id: positiveU64,
  owner_account_id: accountId,
  snapshot: object({
    deployment: parseLivingTownDeployment,
    block_hash: hash32,
    block_height: positiveU64,
    block_timestamp_ns: parseU64,
    market_revision: positiveU64,
    event_sequence: positiveU64,
  }),
  expected_shop_revision: positiveU64,
  expected_ledger_revision: positiveU64,
  expected_policy_revision: positiveU64,
  config_revision: positiveU64,
  created_at_ns: parseU64,
  expires_at_ns: parseU64,
  source: choice(["model", "rules_fallback"] as const),
  reason,
  action: (v: unknown) =>
    record(v)["type"] === "suggest_price" ? price(v) : restock(v),
});
export function assistantProposal(
  value: unknown,
): ReturnType<typeof proposalShape> {
  const p = proposalShape(value);
  check(
    p.created_at_ns === p.snapshot.block_timestamp_ns &&
      BigInt(p.expires_at_ns) > BigInt(p.created_at_ns) &&
      BigInt(p.expires_at_ns) - BigInt(p.created_at_ns) <= 600000000000n,
    "invalid assistant lifetime",
  );
  if (p.action.type === "suggest_restock")
    check(
      BigInt(p.action.total_price) ===
        BigInt(p.action.quantity) * BigInt(p.action.unit_price),
      "assistant purchase total mismatch",
    );
  return p;
}
export type AssistantPublicProposal = ReturnType<typeof assistantProposal>;
export interface AssistantManualReview {
  schema: "living-town-assistant-review-v1";
  review_id: string;
  proposal: AssistantPublicProposal;
  call: {
    method: "set_listing" | "buy_from_merchant";
    args: Record<string, unknown>;
  };
}
export const assistantReviewLink = object({
  review_id: livingTownDigest,
  proposal_id: livingTownDigest,
  shop_id: positiveU64,
  owner_account_id: accountId,
  expires_at_ns: parseU64,
});
export type AssistantReviewLink = ReturnType<typeof assistantReviewLink>;
export function assistantReviewReference(
  review: AssistantManualReview,
): AssistantReviewLink {
  return assistantReviewLink({
    review_id: review.review_id,
    proposal_id: review.proposal.proposal_id,
    shop_id: review.proposal.shop_id,
    owner_account_id: review.proposal.owner_account_id,
    expires_at_ns: review.proposal.expires_at_ns,
  });
}
export function assistantManualReview(value: unknown): AssistantManualReview {
  const r = object({
    schema: literal("living-town-assistant-review-v1"),
    review_id: livingTownDigest,
    proposal: assistantProposal,
    call: object({
      method: choice(["set_listing", "buy_from_merchant"] as const),
      args: record,
    }),
  })(value);
  const decoded = createLivingTownCall(r.call.method, {
    ...r.call.args,
    command: {
      sequence: "1",
      config_version: r.proposal.snapshot.deployment.config_version,
      valid_until_ns: r.proposal.expires_at_ns,
    },
  });
  const { command: _command, ...rawArgs } = decoded.args;
  void _command;
  const args: Record<string, unknown> = rawArgs;
  check(
    canonicalLivingTownJson(args) === canonicalLivingTownJson(r.call.args),
    "unexpected assistant command fields",
  );
  const a = r.proposal.action;
  check(
    args["expected_listing_revision"] === a.expected_listing_revision &&
      args["item_id"] === a.item_id,
    "assistant listing mismatch",
  );
  if (a.type === "suggest_price")
    check(
      r.call.method === "set_listing" &&
        args["shop_id"] === r.proposal.shop_id &&
        args["unit_price"] === a.suggested_unit_price &&
        BigInt(String(args["quantity"])) > 0n,
      "assistant price mismatch",
    );
  else
    check(
      r.call.method === "buy_from_merchant" &&
        args["merchant_id"] ===
          ["rex", "luna", "bolt"][Number(a.seller_shop_id) - 1] &&
        args["quantity"] === a.quantity &&
        args["max_total_price"] === a.total_price,
      "assistant restock mismatch",
    );
  return { ...r, call: { method: r.call.method, args } };
}
export async function verifyAssistantReview(
  value: unknown,
): Promise<AssistantManualReview> {
  const r = assistantManualReview(value),
    { review_id, ...body } = r;
  check(
    review_id === (await livingTownJsonDigest(body)),
    "assistant review digest mismatch",
  );
  const { proposal_id, ...terms } = r.proposal;
  check(
    proposal_id === (await livingTownJsonDigest(terms)),
    "assistant proposal digest mismatch",
  );
  return r;
}
export function assistantCallMatches(
  review: AssistantManualReview,
  call: LivingTownCall,
): boolean {
  const { command, ...args } = call.args;
  return (
    call.method === review.call.method &&
    canonicalLivingTownJson(args) ===
      canonicalLivingTownJson(review.call.args) &&
    BigInt(command.valid_until_ns) <= BigInt(review.proposal.expires_at_ns) &&
    BigInt(command.valid_until_ns) > BigInt(review.proposal.created_at_ns)
  );
}
export const assistantDecision = object({
  proposal_id: livingTownDigest,
  status: choice(["reviewed", "accepted", "dismissed"] as const),
  attempt_id: (v: unknown): string | null => {
    if (v === null) return null;
    check(
      typeof v === "string" && /^[a-f0-9-]{36}$/.test(v),
      "invalid assistant attempt",
    );
    return v;
  },
});
/** Decode only actionable, bounded private history fields; never execute audit text. */
export function assistantHistory(value: unknown): {
  stale: boolean;
  mode: string;
  proposals: AssistantPublicProposal[];
  decisions: ReturnType<typeof assistantDecision>[];
} {
  const r = record(value),
    config = record(r["configuration"]);
  check(
    typeof r["stale"] === "boolean" &&
      ["off", "recommendations"].includes(String(config["mode"])) &&
      Array.isArray(r["history"]) &&
      r["history"].length <= 4,
    "invalid assistant history",
  );
  const proposals: AssistantPublicProposal[] = [],
    decisions: ReturnType<typeof assistantDecision>[] = [];
  for (const raw of r["history"]) {
    const row = record(raw);
    decisions.push(...array(assistantDecision, 2)(row["decisions"] ?? []));
    if (row["status"] === "proposed")
      proposals.push(...array(assistantProposal, 2)(row["proposals"]));
  }
  return {
    stale: r["stale"],
    mode: String(config["mode"]),
    proposals,
    decisions,
  };
}
