import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { parseDecisionAction } from "../decisions/schema.js";
import {
  id,
  label,
  json,
  requireStorage,
  sanitizeBriefReason,
  sanitizedDecision,
  timestamp,
} from "../storage/validation.js";
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface InferenceRecord {
  record: Row;
  links: Row[];
  linksTruncated: boolean;
}
export class InferenceRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(fn: () => T, admission?: boolean) => T,
  ) {}
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  get(requestId: string): InferenceRecord | undefined {
    id(requestId);
    const record = this.one(
      "SELECT r.*,p.status AS provider_status FROM inference_records r JOIN provider_attempts p ON p.id=r.request_id WHERE r.request_id=?",
      requestId,
    );
    if (!record) return undefined;
    const links = this.db
      .prepare(
        "SELECT i.id AS intent_id,i.method,i.action_id,i.status,a.tx_hash AS transaction_hash,a.nonce,coalesce(p.purpose,'model') AS purpose FROM intents i LEFT JOIN attempts a ON a.intent_id=i.id LEFT JOIN policy_steps p ON p.intent_id=i.id WHERE i.decision_id=? ORDER BY i.created_at,i.id LIMIT 9",
      )
      .all(requestId);
    return {
      record,
      links: links.slice(0, 8),
      linksTruncated: links.length > 8,
    };
  }
  dispatch(requestId: string, now: number): void {
    timestamp(now);
    this.write(() => {
      const row = this.one(
        "SELECT outcome,dispatched_at FROM inference_records WHERE request_id=?",
        id(requestId),
      );
      requireStorage(
        row?.["outcome"] === "pending" && row["dispatched_at"] === null,
        "inference dispatch already closed",
      );
      this.db
        .prepare(
          "UPDATE inference_records SET dispatched_at=?,updated_at=? WHERE request_id=?",
        )
        .run(now, now, requestId);
    }, true);
  }
  identity(
    requestId: string,
    provider: string,
    model: string,
    now: number,
  ): void {
    id(requestId);
    label(provider);
    label(model);
    timestamp(now);
    const matches = this.write(() => {
      const row = this.one(
        "SELECT * FROM inference_records WHERE request_id=?",
        requestId,
      );
      requireStorage(row, "inference record missing");
      requireStorage(
        row["responded_at"] === null ||
          (row["actual_provider"] === provider &&
            row["actual_model"] === model),
        "inference response identity is closed",
      );
      requireStorage(
        row["actual_provider"] === null ||
          (row["actual_provider"] === provider &&
            row["actual_model"] === model),
        "returned inference identity already recorded",
      );
      const matches = row["provider"] === provider && row["model"] === model;
      this.db
        .prepare(
          "UPDATE inference_records SET actual_provider=?,actual_model=?,outcome=CASE WHEN ?=0 AND outcome='pending' THEN 'failed' ELSE outcome END,outcome_code=CASE WHEN ?=0 THEN coalesce(outcome_code,'model_identity_mismatch') ELSE outcome_code END,updated_at=? WHERE request_id=?",
        )
        .run(provider, model, Number(matches), Number(matches), now, requestId);
      if (!matches) {
        this.db.exec("UPDATE usage_state SET verified_session=NULL");
        this.db
          .prepare(
            "UPDATE inference_records SET finished_at=coalesce(finished_at,?) WHERE request_id=?",
          )
          .run(now, requestId);
      }
      return matches;
    });
    requireStorage(matches, "unverified returned inference identity");
  }
  validResponse(
    requestId: string,
    action: unknown,
    reason: string,
    now: number,
  ): void {
    id(requestId);
    timestamp(now);
    const clean = sanitizedDecision(action, reason);
    this.write(() => {
      this.db
        .prepare(
          "UPDATE inference_records SET returned_action_json=?,reason=?,schema_outcome='valid',responded_at=?,updated_at=?,late_ignored=CASE WHEN outcome!='pending' THEN 1 ELSE late_ignored END WHERE request_id=? AND schema_outcome IN ('pending','unavailable')",
        )
        .run(clean.actionJson, clean.reason, now, now, requestId);
    });
  }
  invalidResponse(requestId: string, value: unknown, now: number): void {
    id(requestId);
    timestamp(now);
    let action: string | null = null,
      reason: string | null = null;
    // Access only own data properties; do not invoke provider-controlled getters.
    if (value !== null && typeof value === "object") {
      const fields = Object.getOwnPropertyDescriptors(value);
      try {
        if (fields["action"] && "value" in fields["action"])
          action = json(parseDecisionAction(fields["action"].value));
      } catch {
        /* Invalid actions are not persisted as executable data. */
      }
      try {
        if (fields["reason"] && "value" in fields["reason"])
          reason = sanitizeBriefReason(fields["reason"].value);
      } catch {
        /* Missing/oversized reasons remain unavailable. */
      }
    }
    this.write(() => {
      this.db
        .prepare(
          "UPDATE inference_records SET returned_action_json=?,reason=?,schema_outcome='invalid',outcome=CASE WHEN outcome='pending' THEN 'schema_invalid' ELSE outcome END,outcome_code=coalesce(outcome_code,'invalid_decision'),responded_at=?,finished_at=coalesce(finished_at,?),updated_at=?,late_ignored=CASE WHEN outcome!='pending' THEN 1 ELSE late_ignored END WHERE request_id=? AND schema_outcome IN ('pending','unavailable')",
        )
        .run(action, reason, now, now, now, requestId);
    });
  }
  policyInTransaction(
    requestId: string,
    outcome: "approved" | "offchain" | "rejected" | "unavailable",
    code: string | null,
    now: number,
  ): void {
    id(requestId);
    timestamp(now);
    if (code !== null) id(code);
    this.db
      .prepare(
        "UPDATE inference_records SET policy_outcome=?,policy_code=?,policy_at=?,updated_at=? WHERE request_id=? AND policy_outcome IN ('not_evaluated','unavailable')",
      )
      .run(outcome, code, now, now, requestId);
  }
  rejectedPolicy(requestId: string, code: string | null, now: number): void {
    this.write(() =>
      this.policyInTransaction(
        requestId,
        code ? "rejected" : "unavailable",
        code ?? "policy_unavailable",
        now,
      ),
    );
  }
  pruneInTransaction(now: number): void {
    // Keep uncertainty and any unfinished mutation/offer/plan dependency. Source
    // input can disappear independently of the 30-day financial ledger.
    const eligible =
      "outcome NOT IN ('pending','unknown') AND job_id IN (SELECT id FROM jobs WHERE status IN ('completed','failed','expired')) AND NOT EXISTS(SELECT 1 FROM intents i WHERE i.decision_id=inference_records.request_id AND i.status IN ('prepared','signed','submitted','unknown')) AND NOT EXISTS(SELECT 1 FROM policy_commitments c WHERE c.job_id=inference_records.job_id) AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.job_id=inference_records.job_id AND (o.status='pending' OR (o.status IN ('expired','pruned') AND o.cleanup_ack=0)))";
    this.db
      .prepare(
        `DELETE FROM inference_records WHERE ${eligible} AND (updated_at<? OR request_id IN (SELECT request_id FROM inference_records WHERE ${eligible} ORDER BY updated_at DESC,request_id DESC LIMIT -1 OFFSET 10000))`,
      )
      .run(now - 7 * 86400000);
  }
}
