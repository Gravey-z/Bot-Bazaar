import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RecordedInput } from "../inference/input.js";
import {
  id,
  label,
  requireStorage,
  sanitizedDecision,
  timestamp,
} from "../storage/validation.js";
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface ProviderRequest {
  id: string;
  turnId: string;
  provider: string;
  model: string;
  promptVersion: string;
  retryOf?: string;
}
export class RetryRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(operation: () => T, admission?: boolean) => T,
  ) {}
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  private run(sql: string, ...args: SQLInputValue[]): void {
    this.db.prepare(sql).run(...args);
  }
  state(): Row {
    return this.one("SELECT * FROM retry_state WHERE singleton=1")!;
  }
  attempt(requestId: string): Row | undefined {
    return this.one(
      "SELECT * FROM provider_attempts WHERE id=?",
      id(requestId),
    );
  }
  pending(): Row[] {
    return this.db
      .prepare("SELECT * FROM provider_attempts WHERE status='pending' LIMIT 3")
      .all();
  }
  invalidateInTransaction(reason: string, revokeAccepted = true): void {
    id(reason);
    if (revokeAccepted)
      this.run("UPDATE retry_state SET epoch=epoch+1 WHERE singleton=1");
    this.run(
      "UPDATE scheduler_turns SET status='skipped' WHERE id IN (SELECT turn_id FROM provider_attempts WHERE status='pending')",
    );
    this.run(
      "DELETE FROM merchant_locks WHERE kind='controller' AND EXISTS(SELECT 1 FROM provider_attempts p WHERE p.status='pending' AND p.job_id=merchant_locks.job_id AND p.merchant_id=merchant_locks.merchant_id) AND NOT EXISTS(SELECT 1 FROM intents i WHERE i.merchant_id=merchant_locks.merchant_id AND i.status IN ('prepared','signed','submitted','unknown'))",
    );
    this.run(
      "UPDATE inference_records SET outcome='unknown',schema_outcome=CASE WHEN schema_outcome='pending' THEN 'unavailable' ELSE schema_outcome END,outcome_code=?,finished_at=coalesce(finished_at,?),updated_at=? WHERE outcome='pending' AND request_id IN (SELECT id FROM provider_attempts WHERE status='pending')",
      reason,
      Date.now(),
      Date.now(),
    );
    this.run(
      "UPDATE provider_attempts SET status='unknown',reason=? WHERE status='pending'",
      reason,
    );
  }
  invalidate(reason: string): void {
    this.write(() => this.invalidateInTransaction(reason));
  }
  blockClock(now: number): void {
    timestamp(now);
    this.write(() => {
      this.run(
        "UPDATE retry_state SET clock_blocked=1,high_water_ms=max(high_water_ms,?)",
        now,
      );
      this.run("UPDATE deployment SET recovery_required=1");
      this.invalidateInTransaction("clock_discontinuity");
    });
  }
  reconcileClockInTransaction(now: number): void {
    timestamp(now);
    requireStorage(
      now >= Number(this.state()["high_water_ms"]),
      "clock remains behind retained usage history",
    );
    this.run(
      "UPDATE retry_state SET clock_blocked=0,high_water_ms=max(high_water_ms,?)",
      now,
    );
  }
  private current(row: Row, now: number): boolean {
    const deployment = this.one(
        "SELECT feed_generation,recovery_required FROM deployment",
      )!,
      state = this.state();
    const job = this.one(
        "SELECT status,deadline FROM jobs WHERE id=?",
        row["job_id"]!,
      )!,
      turn = this.one(
        "SELECT status FROM scheduler_turns WHERE id=?",
        row["turn_id"]!,
      );
    const snapshot = this.one("SELECT state_json FROM discovery_state")?.[
      "state_json"
    ];
    const view = snapshot ? JSON.parse(String(snapshot)) : null;
    return (
      row["status"] === "pending" &&
      deployment["recovery_required"] === 0 &&
      row["session_id"] === deployment["feed_generation"] &&
      row["epoch"] === state["epoch"] &&
      state["clock_blocked"] === 0 &&
      turn?.["status"] === "running" &&
      job["status"] === "active" &&
      now < Number(row["deadline"]) &&
      now < Number(job["deadline"]) &&
      now >= Number(row["started_at"]) &&
      view !== null &&
      view.market.data.paused === false &&
      now - view.observedAt <= 15000 &&
      view.observedAt <= now + 5000
    );
  }
  reserve(
    request: ProviderRequest,
    now: number,
    timeoutMs: number,
    input?: RecordedInput,
  ): Row {
    [request.id, request.turnId].forEach(id);
    [request.provider, request.model, request.promptVersion].forEach(label);
    timestamp(now);
    requireStorage(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000,
      "invalid model timeout",
    );
    return this.write(() => {
      requireStorage(
        !this.attempt(request.id),
        "provider request identity already used",
      );
      const state = this.state();
      requireStorage(
        state["clock_blocked"] === 0 && now >= Number(state["high_water_ms"]),
        "clock/budget window requires reconciliation",
      );
      const turn = this.one(
        "SELECT * FROM scheduler_turns WHERE id=?",
        request.turnId,
      );
      requireStorage(
        turn?.["status"] === "running",
        "running decision turn required",
      );
      const deployment = this.one("SELECT feed_generation FROM deployment")!,
        job = this.one("SELECT * FROM jobs WHERE id=?", turn["job_id"]!)!;
      const previous = this.one(
        "SELECT * FROM provider_attempts WHERE turn_id=? ORDER BY rowid DESC LIMIT 1",
        request.turnId,
      );
      if (previous) {
        requireStorage(
          request.retryOf === previous["id"] && previous["status"] === "failed",
          "unknown or completed provider outcome cannot be retried",
        );
        const budget = this.one(
          "SELECT model_calls FROM scheduler_roots WHERE job_id=?",
          turn["job_id"]!,
        )!;
        requireStorage(
          Number(budget["model_calls"]) < 6,
          "root decision budget exhausted",
        );
        this.run(
          "UPDATE scheduler_roots SET model_calls=model_calls+1 WHERE job_id=?",
          turn["job_id"]!,
        );
      } else
        requireStorage(
          request.retryOf === undefined,
          "retry reference missing",
        );
      requireStorage(
        Number(job["model_attempts"]) < 6,
        "root provider attempt limit reached",
      );
      const counts = this.one(
        "SELECT sum(started_at>?) AS hour,count(*) AS day FROM provider_attempts WHERE started_at>?",
        now - 3600000,
        now - 86400000,
      )!;
      requireStorage(
        Number(counts["hour"] ?? 0) < 60 && Number(counts["day"]) < 600,
        "rolling provider request limit reached",
      );
      const row: Row = {
        id: request.id,
        turn_id: request.turnId,
        job_id: turn["job_id"]!,
        merchant_id: turn["merchant_id"]!,
        session_id: deployment["feed_generation"]!,
        epoch: state["epoch"]!,
        started_at: now,
        deadline: Math.min(now + timeoutMs, Number(job["deadline"])),
        status: "pending",
      };
      requireStorage(
        this.current(row, now),
        "provider request authority unavailable",
      );
      this.run(
        "INSERT INTO provider_attempts(id,turn_id,job_id,merchant_id,session_id,epoch,provider,model,prompt_version,started_at,deadline,status,retry_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
        request.id,
        request.turnId,
        row["job_id"]!,
        row["merchant_id"]!,
        row["session_id"]!,
        row["epoch"]!,
        request.provider,
        request.model,
        request.promptVersion,
        now,
        row["deadline"]!,
        request.retryOf ?? null,
      );
      this.run(
        "INSERT INTO inference_records(request_id,job_id,merchant_id,provider,model,prompt_version,payload_sha256,input_status,input_json,outcome,schema_outcome,prepared_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending','pending',?,?)",
        request.id,
        row["job_id"]!,
        row["merchant_id"]!,
        request.provider,
        request.model,
        request.promptVersion,
        input?.payloadHash ?? null,
        input?.status ?? "unavailable",
        input?.inputJson ?? null,
        now,
        now,
      );
      this.run(
        "UPDATE jobs SET model_attempts=model_attempts+1 WHERE id=?",
        row["job_id"]!,
      );
      this.run(
        "UPDATE retry_state SET high_water_ms=max(high_water_ms,?)",
        now,
      );
      return this.attempt(request.id)!;
    }, true);
  }
  accept(
    requestId: string,
    action: unknown,
    reason: string,
    now: number,
  ): boolean {
    timestamp(now);
    const normalized = sanitizedDecision(action, reason);
    return this.write(() => {
      const row = this.attempt(requestId);
      requireStorage(row, "provider request missing");
      const identity = this.one(
        "SELECT actual_provider,actual_model FROM inference_records WHERE request_id=?",
        requestId,
      );
      requireStorage(
        !identity ||
          identity["actual_provider"] === null ||
          (identity["actual_provider"] === row["provider"] &&
            identity["actual_model"] === row["model"]),
        "returned model identity mismatch",
      );
      this.run(
        "UPDATE inference_records SET returned_action_json=?,reason=?,schema_outcome='valid',responded_at=?,updated_at=? WHERE request_id=? AND schema_outcome IN ('pending','unavailable')",
        normalized.actionJson,
        normalized.reason,
        now,
        now,
        requestId,
      );
      if (!this.current(row, now)) {
        this.run(
          "UPDATE inference_records SET late_ignored=1,outcome=CASE WHEN outcome='pending' THEN 'revoked' ELSE outcome END,outcome_code=coalesce(outcome_code,'late_or_revoked_response'),finished_at=coalesce(finished_at,?),updated_at=? WHERE request_id=?",
          now,
          now,
          requestId,
        );
        this.run(
          "UPDATE provider_attempts SET late_ignored=1 WHERE id=?",
          requestId,
        );
        if (row["status"] === "pending")
          this.invalidateInTransaction("late_or_revoked_response");
        return false;
      }
      this.run(
        "INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)",
        requestId,
        row["job_id"]!,
        row["merchant_id"]!,
        row["provider"]!,
        row["model"]!,
        row["prompt_version"]!,
        normalized.actionJson,
        normalized.reason,
        now,
      );
      this.run(
        "UPDATE provider_attempts SET status='succeeded' WHERE id=?",
        requestId,
      );
      this.run(
        "UPDATE inference_records SET outcome='schema_valid',finished_at=?,updated_at=? WHERE request_id=? AND outcome='pending'",
        now,
        now,
        requestId,
      );
      this.run(
        "UPDATE retry_state SET high_water_ms=max(high_water_ms,?)",
        now,
      );
      return true;
    });
  }
  fail(requestId: string, definitive: boolean, reason: string): void {
    id(reason);
    this.write(() => {
      const row = this.attempt(requestId);
      requireStorage(row, "provider request missing");
      if (row["status"] !== "pending") return;
      const now = Date.now();
      this.run(
        "UPDATE inference_records SET outcome=?,schema_outcome=CASE WHEN schema_outcome='pending' THEN 'unavailable' ELSE schema_outcome END,outcome_code=?,finished_at=coalesce(finished_at,?),updated_at=? WHERE request_id=? AND outcome='pending'",
        definitive ? "failed" : "unknown",
        reason,
        now,
        now,
        requestId,
      );
      this.run(
        "UPDATE provider_attempts SET status=?,reason=? WHERE id=?",
        definitive ? "failed" : "unknown",
        reason,
        requestId,
      );
      if (!definitive) {
        this.run(
          "UPDATE scheduler_turns SET status='skipped' WHERE id=?",
          row["turn_id"]!,
        );
        this.run(
          "DELETE FROM merchant_locks WHERE kind='controller' AND job_id=? AND merchant_id=? AND NOT EXISTS(SELECT 1 FROM intents WHERE merchant_id=? AND status IN ('prepared','signed','submitted','unknown'))",
          row["job_id"]!,
          row["merchant_id"]!,
          row["merchant_id"]!,
        );
      }
    });
  }
  assertDecisionCurrent(requestId: string, now: number): void {
    const row = this.attempt(requestId);
    requireStorage(
      row?.["status"] === "succeeded",
      "accepted provider decision required",
    );
    requireStorage(
      this.current(
        {
          ...row,
          status: "pending",
          deadline: this.one(
            "SELECT deadline FROM jobs WHERE id=?",
            row["job_id"]!,
          )!["deadline"]!,
        },
        now,
      ),
      "provider decision revoked or expired",
    );
  }
  assertPendingCurrent(requestId: string, now: number): void {
    const row = this.attempt(requestId);
    requireStorage(
      row && this.current(row, now),
      "provider dispatch authority revoked",
    );
  }
}
