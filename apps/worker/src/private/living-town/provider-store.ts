import type { DatabaseSync } from "node:sqlite";
import {
  id,
  json,
  label,
  requireStorage,
  timestamp,
} from "../storage/validation.js";
export const townProviderSchema = `
CREATE TABLE town_provider_attempts(
 id TEXT PRIMARY KEY, tick_id TEXT NOT NULL, merchant TEXT NOT NULL CHECK(merchant IN ('rex','luna','bolt')),
 session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
 ledger_id TEXT, context_json TEXT NOT NULL CHECK(length(CAST(context_json AS BLOB))<=65536),
 status TEXT NOT NULL CHECK(status IN ('prepared','reserved','dispatched','accepted','fallback')),
 payload_hash TEXT, code TEXT, proposal_json TEXT, fallback_json TEXT,
 started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, dispatched_at INTEGER, finished_at INTEGER,
 late_ignored INTEGER NOT NULL DEFAULT 0 CHECK(late_ignored IN (0,1))
) STRICT;
CREATE UNIQUE INDEX one_town_provider_pending ON town_provider_attempts(merchant) WHERE status IN ('prepared','reserved','dispatched');
CREATE TRIGGER bound_town_provider_attempts BEFORE INSERT ON town_provider_attempts
 WHEN (SELECT count(*) FROM town_provider_attempts)>=10000 BEGIN SELECT RAISE(ABORT,'provider audit full'); END;
`;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export class TownProviderRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(fn: () => T) => T,
    private readonly session: string,
    deferRecovery = false,
  ) {
    if (!deferRecovery) this.recoverInterrupted();
  }
  recoverInterrupted(): void {
    // No old process may redispatch an uncertain provider call. Its shared budget reservation remains charged.
    this.write(() =>
      this.db
        .prepare(
          "UPDATE town_provider_attempts SET status='fallback',code='restart_unknown',finished_at=? WHERE status IN ('prepared','reserved','dispatched') AND session_id!=?",
        )
        .run(Date.now(), this.session),
    );
  }
  get(requestId: string): Row | undefined {
    return this.db
      .prepare("SELECT * FROM town_provider_attempts WHERE id=?")
      .get(id(requestId));
  }
  pending(exceptId = ""): boolean {
    return !!this.db
      .prepare(
        "SELECT id FROM town_provider_attempts WHERE status IN ('prepared','reserved','dispatched') AND id!=? LIMIT 1",
      )
      .get(exceptId);
  }
  /** Bounded, independently admitted provider calls: one per merchant, three total. */
  capacityAvailable(merchant: string, exceptId = ""): boolean {
    requireStorage(["rex", "luna", "bolt"].includes(merchant), "invalid provider merchant");
    const rows = this.db.prepare(
      "SELECT merchant FROM town_provider_attempts WHERE status IN ('prepared','reserved','dispatched') AND id!=?",
    ).all(exceptId);
    return rows.length < 3 && !rows.some(row => row["merchant"] === merchant);
  }
  begin(p: {
    id: string;
    tickId: string;
    merchant: string;
    provider: string;
    model: string;
    promptVersion: string;
    ledgerId: string | null;
    context: unknown;
    now: number;
    deadline: number;
  }): void {
    id(p.id);
    label(p.provider);
    label(p.model);
    label(p.promptVersion);
    timestamp(p.now);
    timestamp(p.deadline);
    requireStorage(
      /^[a-f0-9]{64}$/.test(p.tickId) &&
        ["rex", "luna", "bolt"].includes(p.merchant),
      "invalid provider attempt scope",
    );
    this.write(() =>
      this.db
        .prepare(
          "INSERT INTO town_provider_attempts(id,tick_id,merchant,session_id,provider,model,prompt_version,ledger_id,context_json,status,started_at,deadline) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)",
        )
        .run(
          p.id,
          p.tickId,
          p.merchant,
          this.session,
          p.provider,
          p.model,
          p.promptVersion,
          p.ledgerId,
          json(p.context),
          p.now,
          p.deadline,
        ),
    );
  }
  transition(
    requestId: string,
    state: "reserved" | "dispatched",
    payloadHash: string | null = null,
  ): void {
    this.write(() => {
      const row = this.get(requestId);
      requireStorage(
        row?.["session_id"] === this.session &&
          row["status"] === (state === "reserved" ? "prepared" : "reserved"),
        "provider attempt cannot dispatch twice",
      );
      this.db
        .prepare(
          "UPDATE town_provider_attempts SET status=?,payload_hash=coalesce(?,payload_hash),dispatched_at=CASE WHEN ?='dispatched' THEN ? ELSE dispatched_at END WHERE id=?",
        )
        .run(state, payloadHash, state, Date.now(), requestId);
    });
  }
  finish(
    requestId: string,
    status: "accepted" | "fallback",
    code: string,
    proposal: unknown,
    now: number,
  ): boolean {
    id(code);
    timestamp(now);
    return this.write(() => {
      const field = status === "accepted" ? "proposal_json" : "fallback_json";
      const result = this.db
        .prepare(
          `UPDATE town_provider_attempts SET status=?,code=?,${field}=?,finished_at=? WHERE id=? AND session_id=? AND status IN ('prepared','reserved','dispatched')`,
        )
        .run(status, code, json(proposal, 8192), now, requestId, this.session);
      return result.changes === 1;
    });
  }
  fallbackRecord(requestId: string, code: string, proposal: unknown): void {
    id(code);
    this.write(() =>
      this.db
        .prepare(
          "UPDATE town_provider_attempts SET fallback_json=?,code=? WHERE id=?",
        )
        .run(json(proposal, 8192), code, id(requestId)),
    );
  }
  late(requestId: string): void {
    this.write(() =>
      this.db
        .prepare("UPDATE town_provider_attempts SET late_ignored=1 WHERE id=?")
        .run(id(requestId)),
    );
  }
}
