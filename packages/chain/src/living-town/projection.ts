import {
  array,
  boolean,
  check,
  hash32,
  literal,
  nullable,
  object,
  parseU64,
  positiveU64,
  record,
  accountId,
} from "../wire.js";
import type { Decoder } from "../wire.js";
import {
  livingTownSnapshot,
  parseLivingTownDeployment,
  livingTownDigest,
} from "./wire.js";
import { canonicalLivingTownJson, parseLivingTownJson } from "./json.js";
import type { LivingTownProof, LivingTownReceiptStatus } from "./receipts.js";
export const livingTownCheckpoint = object({
  network_id: literal("testnet"),
  genesis_hash: hash32,
  contract_id: accountId,
  projection_schema_version: literal("1"),
  verified_code_hash: hash32,
  config_sha256: livingTownDigest,
  baseline_event_sequence: parseU64,
  through_event_sequence: positiveU64,
  through_market_revision: positiveU64,
  finalized_block_hash: hash32,
  finalized_block_height: positiveU64,
  last_receipt_id: nullable(hash32),
  last_log_index: nullable(parseU64),
  history_complete: boolean,
  gap_from_sequence: nullable(positiveU64),
  feed_generation: (v: unknown): string => {
    check(
      typeof v === "string" && /^[a-f0-9-]{36}$/.test(v),
      "invalid projection generation",
    );
    return v;
  },
});
export type LivingTownCheckpoint = ReturnType<typeof livingTownCheckpoint>;
export function livingTownReadEnvelope<T>(decode: Decoder<T>): Decoder<{
  schema: "living-town-read-v1";
  deployment: ReturnType<typeof parseLivingTownDeployment>;
  source: "confirmed_projection";
  snapshot: ReturnType<ReturnType<typeof livingTownSnapshot<T>>>;
  checkpoint: LivingTownCheckpoint;
  observed_at_ms: ReturnType<typeof parseU64>;
  stale: boolean;
  history_complete: boolean;
}> {
  const shape = object({
    schema: literal("living-town-read-v1"),
    deployment: parseLivingTownDeployment,
    source: literal("confirmed_projection"),
    snapshot: livingTownSnapshot(decode),
    checkpoint: livingTownCheckpoint,
    observed_at_ms: parseU64,
    stale: boolean,
    history_complete: boolean,
  });
  return (value) => {
    const r = shape(value),
      c = r.checkpoint;
    check(
      canonicalLivingTownJson(r.deployment) ===
        canonicalLivingTownJson(r.snapshot.deployment) &&
        c.network_id === r.deployment.network_id &&
        c.genesis_hash === r.deployment.genesis_hash &&
        c.contract_id === r.deployment.contract_id &&
        c.config_sha256 === r.deployment.config_sha256 &&
        c.through_event_sequence === r.snapshot.event_sequence &&
        c.through_market_revision === r.snapshot.market_revision &&
        c.finalized_block_height === r.snapshot.block_height &&
        BigInt(c.baseline_event_sequence) <= BigInt(c.through_event_sequence) &&
        c.history_complete === r.history_complete,
      "V2 projection envelope identity mismatch",
    );
    check(
      c.history_complete
        ? c.baseline_event_sequence === "0" && c.gap_from_sequence === null
        : c.gap_from_sequence !== null,
      "V2 projection history mismatch",
    );
    check(
      (c.last_receipt_id === null) === (c.last_log_index === null) &&
        (c.last_receipt_id === null) ===
          (c.baseline_event_sequence === c.through_event_sequence),
      "V2 projection receipt cursor mismatch",
    );
    return r;
  };
}
export type ConfirmedLivingTownStatus = Extract<
  LivingTownReceiptStatus,
  { kind: "succeeded" | "failed" }
>;
export interface LivingTownIndexedReceipt {
  proof: LivingTownProof;
  status: ConfirmedLivingTownStatus;
  event: unknown | null;
  logIndex: string | null;
}
// Consumes the same response just verified by LivingTownClient.receiptEvidence.
export function livingTownIndexedReceipt(
  proof: LivingTownProof,
  evidence: { status: LivingTownReceiptStatus; response: unknown },
): LivingTownIndexedReceipt | null {
  const status = evidence.status;
  if (status.kind !== "succeeded" && status.kind !== "failed") return null;
  if (status.kind === "failed")
    return { proof, status, event: null, logIndex: null };
  const r = record(evidence.response);
  check(Array.isArray(r["receipts_outcome"]), "missing event receipts");
  const row = r["receipts_outcome"]
    .map(record)
    .find((v) => v["id"] === status.executionReceiptId);
  check(
    row && row["block_hash"] === status.block.hash,
    "V2 event receipt identity mismatch",
  );
  const logs = array((v: unknown): string => {
    check(typeof v === "string" && v.length <= 32768, "invalid event log");
    return v;
  }, 128)(record(row["outcome"])["logs"]);
  const events = logs
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.startsWith("EVENT_JSON:"));
  if (status.result.data.replayed) {
    check(events.length === 0, "replayed command emitted event");
    return { proof, status, event: null, logIndex: null };
  }
  check(events.length === 1, "expected one confirmed effect event");
  const entry = events[0]!;
  const event = object({
    standard: literal("bot_bazaar_living_town"),
    version: literal("2.0.0"),
    event: (v: unknown): string => {
      check(v === proof.call.method, "V2 event method mismatch");
      return String(v);
    },
    data: array(
      object({
        contract_id: accountId,
        config_version: positiveU64,
        event_sequence: positiveU64,
        market_revision: positiveU64,
        block_height: positiveU64,
        block_timestamp_ns: parseU64,
        predecessor_account_id: accountId,
        principal: (v: unknown): string => {
          check(
            v === status.result.data.principal,
            "V2 event principal mismatch",
          );
          return String(v);
        },
        command_sequence: positiveU64,
        payload_sha256: livingTownDigest,
        outcome: record,
      }),
      1,
    ),
  })(parseLivingTownJson(entry.v.slice(11)));
  check(event.data.length === 1, "V2 effect event cardinality");
  const d = event.data[0]!,
    s = status.result;
  check(
    d.contract_id === proof.deployment.contract_id &&
      d.config_version === proof.deployment.config_version &&
      d.event_sequence === s.event_sequence &&
      d.market_revision === s.market_revision &&
      d.block_height === s.block_height &&
      d.block_timestamp_ns === s.block_timestamp_ns &&
      d.predecessor_account_id === proof.signerId &&
      d.command_sequence === s.data.command_sequence &&
      d.payload_sha256 === s.data.payload_sha256 &&
      canonicalLivingTownJson(d.outcome) ===
        canonicalLivingTownJson(s.data.outcome),
    "V2 effect event/result mismatch",
  );
  return { proof, status, event, logIndex: String(entry.i) };
}
