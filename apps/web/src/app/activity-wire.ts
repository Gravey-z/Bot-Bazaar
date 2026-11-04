import { parseU64 } from "@bot-bazaar/chain";
import type {
  ActivityPage,
  PublicActivityEntry,
  PublicDeployment,
  PublicTrade,
} from "@bot-bazaar/shared";

function check(value: unknown): asserts value {
  if (!value) throw new Error("Invalid public activity response");
}
type Decode<T> = (value: unknown) => T;
const text =
  (max: number): Decode<string> =>
  (value) => {
    check(typeof value === "string" && value.length <= max);
    return value;
  };
const choice =
  <T extends string>(values: readonly T[]): Decode<T> =>
  (value) => {
    check(values.includes(value as T));
    return value as T;
  };
const nullable =
  <T>(decode: Decode<T>): Decode<T | null> =>
  (value) =>
    value === null ? null : decode(value);
function bool(value: unknown): boolean {
  check(typeof value === "boolean");
  return value;
}
function stamp(value: unknown): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  check(
    Object.keys(row).length === keys.length &&
      keys.every((key) => Object.hasOwn(row, key)),
  );
  return row;
}
function hash(value: unknown): string {
  const result = text(44)(value);
  check(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result));
  return result;
}
function digest(value: unknown): string {
  const result = text(64)(value);
  check(/^[a-f0-9]{64}$/.test(result));
  return result;
}
function id(value: unknown): string {
  const result = text(128)(value);
  check(/^[a-zA-Z0-9:_.-]+$/.test(result) && !/^(sk-|ed25519:)/i.test(result));
  return result;
}
const merchant = choice(["rex", "luna", "bolt"] as const);
const resource = choice(["crystal", "wood", "herb", "iron"] as const);
export function decodeDeployment(value: unknown): PublicDeployment {
  const row = shape(value, [
    "id",
    "network_id",
    "contract_id",
    "expected_code_hash",
    "identity_kind",
  ]);
  const contract = text(64)(row["contract_id"]);
  check(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(contract));
  check(
    row["network_id"] === "testnet" && row["identity_kind"] === "configured",
  );
  return {
    id: digest(row["id"]),
    network_id: "testnet",
    contract_id: contract,
    expected_code_hash: hash(row["expected_code_hash"]),
    identity_kind: "configured",
  };
}
function decodeTrade(value: unknown): PublicTrade {
  const row = shape(value, [
    "trade_id",
    "kind",
    "buyer",
    "seller",
    "resource",
    "quantity",
    "unit_price",
    "total_price",
    "settled_at_ns",
  ]);
  const result: PublicTrade = {
    trade_id: parseU64(row["trade_id"]),
    kind: choice(["player_purchase", "merchant_trade"] as const)(row["kind"]),
    buyer: nullable(merchant)(row["buyer"]),
    seller: merchant(row["seller"]),
    resource: resource(row["resource"]),
    quantity: parseU64(row["quantity"]),
    unit_price: parseU64(row["unit_price"]),
    total_price: parseU64(row["total_price"]),
    settled_at_ns: parseU64(row["settled_at_ns"]),
  };
  check(
    BigInt(result.trade_id) > 0n &&
      BigInt(result.quantity) > 0n &&
      BigInt(result.quantity) <= 100n &&
      BigInt(result.unit_price) > 0n &&
      BigInt(result.unit_price) <= 100n &&
      BigInt(result.quantity) * BigInt(result.unit_price) ===
        BigInt(result.total_price),
  );
  check(
    result.kind === "player_purchase"
      ? result.buyer === null
      : result.buyer !== null && result.buyer !== result.seller,
  );
  return result;
}
function decodeEntry(value: unknown): PublicActivityEntry {
  const row = shape(value, [
    "sequence",
    "id",
    "domain_key",
    "source",
    "status",
    "phase",
    "observed_at",
    "merchant_id",
    "root_id",
    "decision_id",
    "intent_id",
    "action_id",
    "offer_id",
    "trade_id",
    "reason",
    "reason_kind",
    "code",
    "method",
    "selection",
    "trade",
    "listing",
    "transaction",
    "block",
    "late_ignored",
    "live_ai_evidence",
  ]);
  check(new TextEncoder().encode(JSON.stringify(value)).length <= 4096);
  const domain = text(140)(row["domain_key"]);
  check(/^[a-z]+:[a-f0-9]{64}$/.test(domain));
  const result: PublicActivityEntry = {
    sequence: parseU64(row["sequence"]),
    id: digest(row["id"]),
    domain_key: domain,
    source: choice(["model", "policy", "chain", "system"] as const)(
      row["source"],
    ),
    status: choice([
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
    ] as const)(row["status"]),
    phase: choice([
      "inference",
      "selection",
      "validation",
      "transaction",
      "trade",
      "offer",
      "market",
    ] as const)(row["phase"]),
    observed_at: stamp(row["observed_at"]),
    merchant_id: nullable(merchant)(row["merchant_id"]),
    root_id: nullable(id)(row["root_id"]),
    decision_id: nullable(id)(row["decision_id"]),
    intent_id: nullable(id)(row["intent_id"]),
    action_id: nullable(parseU64)(row["action_id"]),
    offer_id: nullable(parseU64)(row["offer_id"]),
    trade_id: nullable(parseU64)(row["trade_id"]),
    reason: nullable(text(960))(row["reason"]),
    reason_kind: nullable(choice(["model", "status"] as const))(
      row["reason_kind"],
    ),
    code: nullable(id)(row["code"]),
    method: nullable(
      choice([
        "hold",
        "reject_trade",
        "set_listing",
        "propose_trade",
        "accept_trade",
        "cancel_trade",
        "expire_offers",
      ] as const),
    )(row["method"]),
    selection: null,
    trade: nullable(decodeTrade)(row["trade"]),
    listing: null,
    transaction: null,
    block: null,
    late_ignored: bool(row["late_ignored"]),
    live_ai_evidence: false,
  };
  check(row["live_ai_evidence"] === false && BigInt(result.sequence) > 0n);
  check(result.reason === null || Array.from(result.reason).length <= 240);
  check(result.reason_kind !== "model" || result.source === "model");
  check(result.status !== "confirmed" || result.source === "chain");
  if (result.trade)
    check(
      result.source === "chain" &&
        result.status === "confirmed" &&
        result.trade_id === result.trade.trade_id,
    );
  if (row["selection"] !== null) {
    const item = shape(row["selection"], [
      "method",
      "resource",
      "buyer",
      "seller",
      "quantity",
      "unit_price",
      "total_price",
      "offer_id",
    ]);
    result.selection = {
      method: choice([
        "hold",
        "reject_trade",
        "set_listing",
        "propose_trade",
        "accept_trade",
      ])(item["method"]),
      resource: nullable(resource)(item["resource"]),
      buyer: nullable(merchant)(item["buyer"]),
      seller: nullable(merchant)(item["seller"]),
      quantity: nullable(parseU64)(item["quantity"]),
      unit_price: nullable(parseU64)(item["unit_price"]),
      total_price: nullable(parseU64)(item["total_price"]),
      offer_id: nullable(parseU64)(item["offer_id"]),
    };
  }
  if (row["listing"] !== null) {
    const item = shape(row["listing"], [
      "merchant_id",
      "resource",
      "quantity",
      "unit_price",
      "active",
      "version",
    ]);
    result.listing = {
      merchant_id: merchant(item["merchant_id"]),
      resource: resource(item["resource"]),
      quantity: parseU64(item["quantity"]),
      unit_price: parseU64(item["unit_price"]),
      active: bool(item["active"]),
      version: parseU64(item["version"]),
    };
  }
  if (row["transaction"] !== null) {
    const item = shape(row["transaction"], [
      "signed_hash",
      "receipt_hash",
      "explorer_url",
      "evidence",
      "evidence_incomplete",
    ]);
    result.transaction = {
      signed_hash: nullable(hash)(item["signed_hash"]),
      receipt_hash: nullable(hash)(item["receipt_hash"]),
      explorer_url: nullable(text(256))(item["explorer_url"]),
      evidence: choice([
        "signed",
        "receipt",
        "action_checkpoint",
        "unavailable",
      ] as const)(item["evidence"]),
      evidence_incomplete: bool(item["evidence_incomplete"]),
    };
    check(
      result.transaction.evidence !== "action_checkpoint" ||
        (result.transaction.evidence_incomplete &&
          result.transaction.receipt_hash === null),
    );
  }
  if (row["block"] !== null) {
    const item = shape(row["block"], [
      "height",
      "hash",
      "timestamp_ns",
      "market_revision",
    ]);
    result.block = {
      height: parseU64(item["height"]),
      hash: nullable(hash)(item["hash"]),
      timestamp_ns: parseU64(item["timestamp_ns"]),
      market_revision: parseU64(item["market_revision"]),
    };
  }
  if (result.trade) check(result.block !== null);
  if (result.trade && result.block) {
    check(
      BigInt(result.trade.settled_at_ns) <= BigInt(result.block.timestamp_ns),
    );
    check(
      (result.phase === "trade" &&
        result.code === "finalized_trade_view" &&
        result.block.hash !== null) ||
        (result.phase === "transaction" &&
          result.transaction?.evidence === "receipt" &&
          result.transaction.receipt_hash !== null &&
          result.transaction.receipt_hash === result.transaction.signed_hash),
    );
  }
  return result;
}
export function decodeActivityPage(value: unknown): ActivityPage {
  const row = shape(value, [
    "api_version",
    "deployment",
    "feed_generation",
    "captured_at",
    "heartbeat_at",
    "chain",
    "entries",
    "next_after",
    "has_more",
    "history_gap",
    "high_water_sequence",
    "pruned_through",
  ]);
  check(row["api_version"] === "1");
  const generation = text(36)(row["feed_generation"]);
  check(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(generation));
  const cursor = text(1024)(row["next_after"]);
  check(/^[A-Za-z0-9_-]+$/.test(cursor));
  const chain = shape(row["chain"], [
    "block_height",
    "block_hash",
    "market_revision",
    "observed_at",
    "age_ms",
    "stale",
    "paused",
  ]);
  const age = chain["age_ms"];
  check(age === null || (typeof age === "number" && Number.isSafeInteger(age)));
  check(Array.isArray(row["entries"]) && row["entries"].length <= 50);
  const entries = row["entries"].map(decodeEntry),
    high = parseU64(row["high_water_sequence"]),
    pruned = parseU64(row["pruned_through"]);
  check(new Set(entries.map((entry) => entry.id)).size === entries.length);
  let previous = BigInt(pruned);
  for (const entry of entries) {
    check(
      BigInt(entry.sequence) > previous &&
        BigInt(entry.sequence) <= BigInt(high),
    );
    previous = BigInt(entry.sequence);
  }
  check(
    BigInt(pruned) <= BigInt(high) &&
      (!bool(row["has_more"]) || entries.length > 0),
  );
  return {
    api_version: "1",
    deployment: decodeDeployment(row["deployment"]),
    feed_generation: generation,
    captured_at: stamp(row["captured_at"]),
    heartbeat_at: stamp(row["heartbeat_at"]),
    chain: {
      block_height: nullable(parseU64)(chain["block_height"]),
      block_hash: nullable(hash)(chain["block_hash"]),
      market_revision: nullable(parseU64)(chain["market_revision"]),
      observed_at: nullable(stamp)(chain["observed_at"]),
      age_ms: age as number | null,
      stale: bool(chain["stale"]),
      paused: nullable(bool)(chain["paused"]),
    },
    entries,
    next_after: cursor,
    has_more: bool(row["has_more"]),
    history_gap: bool(row["history_gap"]),
    high_water_sequence: high,
    pruned_through: pruned,
  };
}
