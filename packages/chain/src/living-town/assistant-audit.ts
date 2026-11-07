import {
  accountId,
  array,
  check,
  choice,
  hash32,
  nullable,
  object,
  parseU64,
  positiveU64,
} from "../wire.js";
const text = (v: unknown): string => {
  check(
    typeof v === "string" && /^[\x20-\x7e]{1,240}$/.test(v),
    "invalid assistant audit text",
  );
  return v;
};
const time = (v: unknown): string => {
  const n = parseU64(v);
  check(BigInt(n) <= 8640000000000000n, "invalid audit time");
  return n;
};
export const assistantAuditEntry = object({
  id: text,
  shop_id: positiveU64,
  owner_account_id: accountId,
  source: choice(["manual", "automatic"] as const),
  action: text,
  terms: text,
  reason: text,
  validation: choice([
    "validated",
    "rejected",
    "expired",
    "pending",
    "wait",
  ] as const),
  acceptance: choice([
    "none",
    "reviewed",
    "accepted",
    "dismissed",
    "onchain_policy",
  ] as const),
  outcome: choice([
    "not_submitted",
    "submitted",
    "unknown",
    "confirmed",
    "rejected",
    "expired",
    "prepared",
    "signed",
  ] as const),
  policy_revision: nullable(parseU64),
  created_at_ms: time,
  updated_at_ms: time,
  reviewed_at_ms: nullable(time),
  accepted_at_ms: nullable(time),
  transaction_hash: nullable(hash32),
  receipt_id: nullable(hash32),
});
export type AssistantAuditEntry = ReturnType<typeof assistantAuditEntry>;
export const assistantAuditEntries = array(assistantAuditEntry, 96);
/** The application supports NEAR testnet. Only verified finalized receipts get links. */
export function assistantAuditReceiptUrl(
  entry: AssistantAuditEntry,
): string | null {
  const e = assistantAuditEntry(entry);
  return e.receipt_id &&
    e.transaction_hash &&
    ["confirmed", "rejected"].includes(e.outcome)
    ? `https://testnet.nearblocks.io/txns/${e.transaction_hash}#${e.receipt_id}`
    : null;
}
