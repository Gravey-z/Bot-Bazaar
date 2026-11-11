import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Durable, non-signing batch *planning* only. This class cannot broadcast NEAR
 * transactions and must not replace the execution journal or recovery proof.
 * Install listingBatchSchema on the same single-writer SQLite connection before use.
 */
export const listingBatchSchema = `
CREATE TABLE IF NOT EXISTS listing_batch_queue (
  id TEXT PRIMARY KEY,
  merchant TEXT NOT NULL CHECK (merchant IN ('rex','luna','bolt')),
  item_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  expected_revision TEXT,
  created_at_ms INTEGER NOT NULL,
  eligible_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','superseded','dispatched','confirmed','failed')),
  batch_id TEXT,
  journal_intent_id TEXT,
  CHECK (length(action_json) <= 8192)
) STRICT;
CREATE INDEX IF NOT EXISTS listing_batch_queue_ready ON listing_batch_queue(state,eligible_at_ms,merchant);
`;

export type Merchant = "rex" | "luna" | "bolt";
export type ListingCandidate = {
  id: string;
  merchant: Merchant;
  itemId: string;
  expectedRevision: string | null;
  quantity: string;
  unitPrice: string;
};
export type ListingBatch = {
  id: string;
  merchant: Merchant;
  actions: readonly ListingCandidate[];
};
const MAX_ACTIONS = 10;
const COLLECTION_MS = 2000;
const HASH = /^[a-f\d]{64}$/;
const U64 = /^(0|[1-9]\d*)$/;
const canonicalId = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Deliberately requires an existing journal transaction wrapper for every mutation. */
export class ListingBatchPlanner {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(operation: () => T) => T,
    private readonly gate: () => void,
  ) {}

  enqueue(candidate: ListingCandidate, nowMs: number): void {
    this.gate();
    if (
      !HASH.test(candidate.id) ||
      !["rex", "luna", "bolt"].includes(candidate.merchant) ||
      candidate.itemId.length === 0 || candidate.itemId.length > 64 ||
      !U64.test(candidate.quantity) || !U64.test(candidate.unitPrice) ||
      (candidate.expectedRevision !== null && !U64.test(candidate.expectedRevision)) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0
    ) throw new Error("invalid listing batch candidate");

    this.write(() => {
      // A newer candidate supersedes queued work for the same listing. Never
      // overwrite dispatched work: its recovery belongs to the original intent.
      this.db.prepare(`UPDATE listing_batch_queue SET state='superseded'
        WHERE merchant=? AND item_id=? AND state='queued' AND id!=?`)
        .run(candidate.merchant, candidate.itemId, candidate.id);
      this.db.prepare(`INSERT OR IGNORE INTO listing_batch_queue
        (id,merchant,item_id,action_json,expected_revision,created_at_ms,eligible_at_ms)
        VALUES (?,?,?,?,?,?,?)`).run(
          candidate.id, candidate.merchant, candidate.itemId,
          JSON.stringify(candidate), candidate.expectedRevision,
          nowMs, nowMs + COLLECTION_MS,
        );
    });
  }

  /** No lease or state change: the caller must persist a signed batch intent
   * atomically with dispatch, then link each queue row to that intent. */
  ready(nowMs: number): ListingBatch | null {
    this.gate();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid batch clock");
    const first = this.db.prepare(`SELECT merchant FROM listing_batch_queue
      WHERE state='queued' AND eligible_at_ms<=?
      ORDER BY eligible_at_ms,created_at_ms,id LIMIT 1`).get(nowMs);
    if (!first) return null;
    const merchant = String(first["merchant"]) as Merchant;
    const rows = this.db.prepare(`SELECT id,action_json FROM listing_batch_queue
      WHERE state='queued' AND merchant=? AND eligible_at_ms<=?
      ORDER BY created_at_ms,id LIMIT ?`).all(merchant, nowMs, MAX_ACTIONS);
    const actions = rows.map(row => JSON.parse(String(row["action_json"])) as ListingCandidate);
    return { id: canonicalId(["listing-batch-v1", merchant, actions.map(a => a.id)]), merchant, actions };
  }

  /** Call only within the atomic transaction that creates the durable batch
   * intent, *before signing*. The executor must then recover by original hash. */
  bindToJournal(batch: ListingBatch, intentId: string): void {
    this.gate();
    if (!HASH.test(intentId) || batch.actions.length === 0 || batch.actions.length > MAX_ACTIONS)
      throw new Error("invalid listing batch binding");
    this.write(() => {
      for (const action of batch.actions) {
        if (action.merchant !== batch.merchant) throw new Error("mixed merchant batch");
        const result = this.db.prepare(`UPDATE listing_batch_queue
          SET state='dispatched',batch_id=?,journal_intent_id=?
          WHERE id=? AND merchant=? AND state='queued'`).run(
            batch.id, intentId, action.id, batch.merchant,
          );
        if (result.changes !== 1) throw new Error("listing batch candidate changed");
      }
    });
  }

  /** Only call after every individual effect has been verified. */
  resolve(intentId: string, succeeded: boolean): void {
    this.gate();
    if (!HASH.test(intentId)) throw new Error("invalid batch intent");
    this.write(() => {
      this.db.prepare(`UPDATE listing_batch_queue SET state=?
        WHERE journal_intent_id=? AND state='dispatched'`).run(
          succeeded ? "confirmed" : "failed", intentId,
        );
    });
  }
}
