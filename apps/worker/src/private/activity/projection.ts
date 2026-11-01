import {
  createMarketCall,
  decodeCallResult,
  parseU64,
} from "@bot-bazaar/chain";
import type { MerchantId, Resource } from "@bot-bazaar/chain";
import type {
  PublicActivityEntry,
  PublicSelection,
  PublicTrade,
  PublicListing,
  ActivitySource,
  ActivityStatus,
} from "@bot-bazaar/shared";
import { parseDecisionAction } from "../decisions/schema.js";
import {
  sanitizeBriefReason,
  sha256,
  requireStorage,
} from "../storage/validation.js";
export type Draft = Omit<PublicActivityEntry, "sequence" | "id">;
export type Row = Record<string, string | number | bigint | Uint8Array | null>;
export function safeId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-zA-Z0-9:_.-]{1,128}$/.test(value) &&
    !/^(sk-|ed25519:)/i.test(value)
    ? value
    : null;
}
export function hash(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim() === value &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
    ? value
    : null;
}
export function merchant(value: unknown): MerchantId | null {
  return ["rex", "luna", "bolt"].includes(String(value))
    ? (value as MerchantId)
    : null;
}
function resource(value: unknown): Resource {
  requireStorage(
    ["crystal", "wood", "herb", "iron"].includes(String(value)),
    "invalid public resource",
  );
  return value as Resource;
}
export function stamp(value: unknown): number {
  requireStorage(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "invalid activity time",
  );
  return value;
}
export function brief(value: unknown): string | null {
  try {
    return sanitizeBriefReason(value);
  } catch {
    return null;
  }
}
export function draft(
  kind: string,
  id: string,
  source: ActivitySource,
  status: ActivityStatus,
  phase: Draft["phase"],
  at: number,
): Draft {
  return {
    domain_key: `${kind}:${sha256(id)}`,
    source,
    status,
    phase,
    observed_at: stamp(at),
    merchant_id: null,
    root_id: null,
    decision_id: null,
    intent_id: null,
    action_id: null,
    offer_id: null,
    trade_id: null,
    reason: null,
    reason_kind: null,
    code: null,
    method: null,
    selection: null,
    trade: null,
    listing: null,
    transaction: null,
    block: null,
    late_ignored: false,
    live_ai_evidence: false,
  };
}
export function selection(value: unknown): PublicSelection {
  const action = parseDecisionAction(value),
    args = "args" in action ? (action.args as Record<string, unknown>) : {};
  return {
    method: action.method,
    resource:
      args["resource"] === undefined ? null : resource(args["resource"]),
    buyer: merchant(args["buyer"]),
    seller: merchant(args["seller"]),
    quantity:
      args["quantity"] === undefined ? null : parseU64(args["quantity"]),
    unit_price:
      args["unit_price"] === undefined ? null : parseU64(args["unit_price"]),
    total_price:
      args["total_price"] === undefined ? null : parseU64(args["total_price"]),
    offer_id:
      action.method === "reject_trade"
        ? action.offer_id
        : args["offer_id"] === undefined
          ? null
          : parseU64(args["offer_id"]),
  };
}
export function publicTrade(value: unknown): PublicTrade {
  const row = value as Record<string, unknown>,
    buyer = row["buyer"] as Record<string, unknown>,
    seller = row["seller"] as Record<string, unknown>;
  const sellerId = merchant(seller["merchant_id"]);
  requireStorage(
    sellerId &&
      ["player_purchase", "merchant_trade"].includes(String(row["kind"])),
    "invalid public trade",
  );
  return {
    trade_id: parseU64(row["trade_id"]),
    kind: row["kind"] as PublicTrade["kind"],
    buyer: buyer["kind"] === "merchant" ? merchant(buyer["merchant_id"]) : null,
    seller: sellerId,
    resource: resource(row["resource"]),
    quantity: parseU64(row["quantity"]),
    unit_price: parseU64(row["unit_price"]),
    total_price: parseU64(row["total_price"]),
    settled_at_ns: parseU64(row["settled_at_ns"]),
  };
}
function publicListing(value: unknown): PublicListing {
  const row = value as Record<string, unknown>,
    owner = merchant(row["merchant_id"]);
  requireStorage(
    owner && typeof row["active"] === "boolean",
    "invalid public listing",
  );
  return {
    merchant_id: owner,
    resource: resource(row["resource"]),
    quantity: parseU64(row["quantity"]),
    unit_price: parseU64(row["unit_price"]),
    active: row["active"],
    version: parseU64(row["version"]),
  };
}
export function projectDecision(row: Row): Draft {
  const chosen = selection(JSON.parse(String(row["action_json"]))),
    status =
      chosen.method === "hold"
        ? "held"
        : chosen.method === "reject_trade"
          ? "rejected"
          : "proposed";
  return {
    ...draft(
      "decision",
      String(row["id"]),
      "model",
      status,
      "selection",
      Number(row["created_at"]),
    ),
    merchant_id: merchant(row["merchant_id"]),
    root_id: safeId(row["job_id"]),
    decision_id: safeId(row["id"]),
    reason: brief(row["reason"]),
    reason_kind: brief(row["reason"]) === null ? null : "model",
    method: chosen.method,
    selection: chosen,
    offer_id: chosen.offer_id,
    code: "model_selection",
  };
}
export function projectIntent(
  row: Row,
  attempt: Row | undefined,
  purpose: unknown,
): Draft {
  const statuses = [
    "prepared",
    "signed",
    "submitted",
    "unknown",
    "confirmed",
    "failed",
    "abandoned",
  ];
  requireStorage(
    statuses.includes(String(row["status"])),
    "invalid public intent status",
  );
  const method = String(row["method"]);
  createMarketCall(
    method as Parameters<typeof createMarketCall>[0],
    JSON.parse(String(row["args_json"])),
  );
  const status =
    row["status"] === "abandoned"
      ? "rejected"
      : (row["status"] as ActivityStatus);
  const event: Draft = {
    ...draft(
      "intent",
      String(row["id"]),
      purpose === "prerequisite" ? "policy" : "system",
      status,
      "transaction",
      Number(row["updated_at"]),
    ),
    merchant_id: merchant(row["merchant_id"]),
    root_id: safeId(row["job_id"]),
    decision_id: safeId(row["decision_id"]),
    intent_id: safeId(row["id"]),
    action_id: row["action_id"] === null ? null : parseU64(row["action_id"]),
    offer_id: row["offer_id"] === null ? null : parseU64(row["offer_id"]),
    method,
    code:
      purpose === "prerequisite" ? "policy_prerequisite" : "transaction_state",
  };
  if (attempt) {
    event.transaction = {
      signed_hash: hash(attempt["tx_hash"]),
      receipt_hash: null,
      explorer_url: null,
      evidence: "signed",
      evidence_incomplete: false,
    };
  }
  if (status === "confirmed" || status === "failed") {
    const proof = attempt?.["evidence_json"]
      ? (JSON.parse(String(attempt["evidence_json"])) as Record<
          string,
          unknown
        >)
      : null;
    event.source = "chain";
    if (proof?.["kind"] === "action_checkpoint") {
      event.transaction = {
        signed_hash: hash(attempt?.["tx_hash"]),
        receipt_hash: null,
        explorer_url: null,
        evidence: "action_checkpoint",
        evidence_incomplete: true,
      };
      const action = proof["action"] as Record<string, unknown>;
      event.trade_id =
        action["trade_id"] === null ? null : parseU64(action["trade_id"]);
      const block = proof["block"] as Record<string, unknown>;
      event.block = {
        height: parseU64(block["height"]),
        hash: hash(block["hash"]),
        timestamp_ns: parseU64(block["timestampNs"]),
        market_revision: parseU64(action["market_revision"]),
      };
    } else if (
      (proof?.["kind"] === "succeeded" || proof?.["kind"] === "failed") &&
      hash(proof["transactionHash"]) === hash(attempt?.["tx_hash"]) &&
      hash(attempt?.["tx_hash"]) !== null
    ) {
      event.transaction = {
        signed_hash: hash(attempt?.["tx_hash"]),
        receipt_hash: hash(proof["transactionHash"]),
        explorer_url: null,
        evidence: "receipt",
        evidence_incomplete: false,
      };
      if (proof["kind"] === "succeeded") {
        const result = decodeCallResult(
            method as Parameters<typeof decodeCallResult>[0],
            proof["result"],
          ),
          data = result.data as Record<string, unknown>;
        event.block = {
          height: result.block_height,
          hash: null,
          timestamp_ns: result.block_timestamp_ns,
          market_revision: result.market_revision,
        };
        if (data["trade"]) {
          event.trade = publicTrade(data["trade"]);
          event.trade_id = event.trade.trade_id;
        }
        if (data["listing"]) event.listing = publicListing(data["listing"]);
      }
    } else {
      event.source = "system";
      event.status = "unknown";
      event.code = "receipt_unavailable";
      if (event.transaction) {
        event.transaction.evidence = "unavailable";
        event.transaction.evidence_incomplete = true;
      }
    }
  }
  return event;
}

const codes = [
  "model_selection",
  "policy_prerequisite",
  "transaction_state",
  "receipt_unavailable",
  "finalized_trade_view",
  "offer_pending",
  "offer_accepted",
  "offer_expired",
  "offer_cancelled",
  "market_paused",
  "market_open",
  "inference_dispatched",
  "schema_invalid",
  "response_revoked",
  "ai_unavailable",
  "policy_approved",
  "offchain_decision",
  "policy_rejected",
  "policy_unavailable",
];
// Re-project at the public boundary as well as at capture. Future private fields
// added to persisted objects cannot accidentally become response properties.
export function publicEntry(value: unknown): Draft {
  const row = value as Draft;
  requireStorage(
    row &&
      typeof row === "object" &&
      ["model", "policy", "chain", "system"].includes(row.source) &&
      [
        "thinking",
        "proposed",
        "rejected",
        "held",
        "prepared",
        "signed",
        "submitted",
        "confirmed",
        "failed",
        "unknown",
        "expired",
        "paused",
        "resumed",
        "observed",
      ].includes(row.status) &&
      [
        "inference",
        "selection",
        "validation",
        "transaction",
        "trade",
        "offer",
        "market",
      ].includes(row.phase) &&
      typeof row.domain_key === "string" &&
      /^[a-z]+:[a-f0-9]{64}$/.test(row.domain_key),
    "invalid public activity record",
  );
  const code = row.code !== null && codes.includes(row.code) ? row.code : null;
  const result: Draft = {
    ...draft(
      "system",
      "projection",
      row.source,
      row.status,
      row.phase,
      row.observed_at,
    ),
    domain_key: row.domain_key,
    merchant_id: merchant(row.merchant_id),
    root_id: safeId(row.root_id),
    decision_id: safeId(row.decision_id),
    intent_id: safeId(row.intent_id),
    action_id: row.action_id === null ? null : parseU64(row.action_id),
    offer_id: row.offer_id === null ? null : parseU64(row.offer_id),
    trade_id: row.trade_id === null ? null : parseU64(row.trade_id),
    code,
    method: [
      "hold",
      "reject_trade",
      "set_listing",
      "propose_trade",
      "accept_trade",
      "cancel_trade",
      "expire_offers",
    ].includes(String(row.method))
      ? row.method
      : null,
    late_ignored: row.late_ignored === true,
  };
  if (row.source === "model") {
    result.reason = brief(row.reason);
    result.reason_kind = result.reason ? "model" : null;
  } else if (
    code === "ai_unavailable" ||
    code === "schema_invalid" ||
    code === "policy_rejected"
  ) {
    result.reason =
      code === "ai_unavailable" ? "AI unavailable" : "AI validation error";
    result.reason_kind = "status";
  }
  if (row.selection) {
    const s = row.selection;
    requireStorage(
      [
        "hold",
        "reject_trade",
        "set_listing",
        "propose_trade",
        "accept_trade",
      ].includes(s.method),
      "invalid public selection",
    );
    result.selection = {
      method: s.method,
      resource: s.resource === null ? null : resource(s.resource),
      buyer: merchant(s.buyer),
      seller: merchant(s.seller),
      quantity: s.quantity === null ? null : parseU64(s.quantity),
      unit_price: s.unit_price === null ? null : parseU64(s.unit_price),
      total_price: s.total_price === null ? null : parseU64(s.total_price),
      offer_id: s.offer_id === null ? null : parseU64(s.offer_id),
    };
  }
  if (row.trade) {
    requireStorage(
      row.source === "chain" && row.status === "confirmed",
      "trade confirmation needs chain evidence",
    );
    result.trade = publicTrade({
      ...row.trade,
      buyer: {
        kind: row.trade.buyer ? "merchant" : "player",
        merchant_id: row.trade.buyer,
      },
      seller: { kind: "merchant", merchant_id: row.trade.seller },
    });
  }
  if (row.listing) result.listing = publicListing(row.listing);
  if (row.transaction) {
    const t = row.transaction;
    requireStorage(
      ["signed", "receipt", "action_checkpoint", "unavailable"].includes(
        t.evidence,
      ),
      "invalid public proof",
    );
    result.transaction = {
      signed_hash: hash(t.signed_hash),
      receipt_hash: t.evidence === "receipt" ? hash(t.receipt_hash) : null,
      explorer_url: null,
      evidence: t.evidence,
      evidence_incomplete:
        t.evidence_incomplete === true ||
        t.evidence === "action_checkpoint" ||
        t.evidence === "unavailable",
    };
  }
  if (row.block)
    result.block = {
      height: parseU64(row.block.height),
      hash: hash(row.block.hash),
      timestamp_ns: parseU64(row.block.timestamp_ns),
      market_revision: parseU64(row.block.market_revision),
    };
  return result;
}
