import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  id,
  label,
  json,
  sha256,
  requireStorage,
  timestamp,
} from "../storage/validation.js";
const day = 86400000,
  month = 30 * day;
// Includes serialized response schemas in the conservative input estimate.
export const maximumInferenceInputTokens = 8192;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface Allocation {
  projectId: string;
  laneId: string;
  portions: readonly {
    laneId: string;
    dailyMicro: number;
    monthlyMicro: number;
  }[];
}
export interface BudgetLimits {
  dailyMicro: number;
  monthlyMicro: number;
  lifetimeMicro?: number;
  lifetimeOnly?: boolean;
}
export interface UsageEntry {
  request_id: string;
  deployment: string;
  provider: string;
  model: string;
  started_at: number;
  reserved_micro: number;
  charged_micro: number;
  input_bound: number;
  status: "reserved" | "accounted";
  evidence_ref: string | null;
}
export interface UsageHistory {
  config: Allocation;
  entries: UsageEntry[];
}
export interface PreparedInference {
  // Exact provider body, including messages, response schema and output-token settings.
  payload: string;
  provider: string;
  model: string;
  maxOutputTokens: 512;
  countTokens: (payload: string) => number;
  accountingEvidence: string;
  worstInputMicroPerMillion: number;
  outputMicroPerMillion: number;
  pricingEvidence: string;
  verifiedUntil: number;
}
export interface InferencePolicy {
  prepare: (request: {
    provider: string;
    model: string;
    promptVersion: string;
  }) => PreparedInference;
}
export class BudgetRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(fn: () => T, admission?: boolean) => T,
    private readonly session: () => string,
    private readonly deployment: string,
    private readonly limits: BudgetLimits = {
      dailyMicro: 500000,
      monthlyMicro: 5000000,
    },
  ) {
    requireStorage(!limits.lifetimeOnly || limits.lifetimeMicro !== undefined,
      "lifetime-only spending requires a total budget limit");
  }
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  state(): Row | undefined {
    return this.one("SELECT * FROM usage_state");
  }
  status(now = Date.now()): {
    dailyMicro: number;
    monthlyMicro: number;
    dailyLimit: number;
    monthlyLimit: number;
    totalMicro?: number;
    totalLimit?: number;
    rollingLimitsEnabled: boolean;
    warning: boolean;
    blocked: boolean;
  } {
    const state = this.state();
    requireStorage(state, "budget not configured");
    timestamp(now);
    const config = JSON.parse(String(state["config_json"])) as Allocation,
      lane = config.portions.find((row) => row.laneId === config.laneId)!;
    const usage = this.one(
      "SELECT coalesce(sum(CASE WHEN started_at>? THEN charged_micro ELSE 0 END),0) AS daily,coalesce(sum(charged_micro),0) AS monthly FROM inference_usage WHERE started_at>?",
      now - day,
      now - month,
    )!;
    const dailyMicro = Number(usage["daily"]),
      monthlyMicro = Number(usage["monthly"]);
    const totalMicro =
      this.limits.lifetimeMicro === undefined
        ? undefined
        : Number(
            this.one(
              "SELECT coalesce(sum(charged_micro),0) n FROM inference_usage",
            )!["n"],
          );
    return {
      dailyMicro,
      monthlyMicro,
      dailyLimit: this.limits.lifetimeOnly ? this.limits.lifetimeMicro! : lane.dailyMicro,
      monthlyLimit: this.limits.lifetimeOnly ? this.limits.lifetimeMicro! : lane.monthlyMicro,
      rollingLimitsEnabled: !this.limits.lifetimeOnly,
      ...(totalMicro === undefined
        ? {}
        : { totalMicro, totalLimit: this.limits.lifetimeMicro! }),
      warning:
        (!this.limits.lifetimeOnly && (dailyMicro * 5 >= lane.dailyMicro * 4 ||
        monthlyMicro * 5 >= lane.monthlyMicro * 4)) ||
        (totalMicro !== undefined &&
          totalMicro * 5 >= this.limits.lifetimeMicro! * 4),
      blocked:
        state["verified_session"] !== this.session() ||
        Number(state["blocked_until"]) > 0 ||
        now < Number(state["high_water_ms"]),
    };
  }
  private config(value: Allocation): Allocation {
    id(value.projectId);
    id(value.laneId);
    requireStorage(
      value.portions.length > 0 && value.portions.length <= 16,
      "invalid budget lanes",
    );
    const portions = value.portions
      .map((row) => {
        id(row.laneId);
        requireStorage(
          Number.isSafeInteger(row.dailyMicro) &&
            row.dailyMicro > 0 &&
            Number.isSafeInteger(row.monthlyMicro) &&
            row.monthlyMicro >= row.dailyMicro,
          "invalid lane limits",
        );
        return {
          laneId: row.laneId,
          dailyMicro: row.dailyMicro,
          monthlyMicro: row.monthlyMicro,
        };
      })
      .sort((a, b) => (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0));
    requireStorage(
      new Set(portions.map((row) => row.laneId)).size === portions.length &&
        portions.some((row) => row.laneId === value.laneId) &&
        portions.reduce((s, r) => s + r.dailyMicro, 0) <=
          this.limits.dailyMicro &&
        portions.reduce((s, r) => s + r.monthlyMicro, 0) <=
          this.limits.monthlyMicro,
      "project allocation exceeded",
    );
    return { projectId: value.projectId, laneId: value.laneId, portions };
  }
  configure(value: Allocation, now = Date.now()): void {
    timestamp(now);
    const config = json(this.config(value));
    this.write(() => {
      const old = this.state();
      if (old) {
        requireStorage(
          old["config_json"] === config,
          "immutable budget allocation mismatch",
        );
        return;
      }
      this.db
        .prepare(
          "INSERT INTO usage_state(singleton,config_json,ledger_id,high_water_ms) VALUES(1,?,?,?)",
        )
        .run(config, randomUUID(), now);
    });
  }
  history(): UsageHistory {
    const state = this.state();
    requireStorage(state, "budget not configured");
    return {
      config: JSON.parse(String(state["config_json"])),
      entries: this.db
        .prepare("SELECT * FROM inference_usage ORDER BY started_at,request_id")
        .all() as unknown as UsageEntry[],
    };
  }
  /** Explicit private operator action: revise limits without replacing identity or usage. */
  reallocate(value: Allocation, evidenceRef: string, now = Date.now()): void {
    timestamp(now);
    id(evidenceRef);
    const next = this.config(value);
    this.write(() => {
      const state = this.state();
      requireStorage(
        state && !this.status(now).blocked,
        "verified shared authority required for budget revision",
      );
      const old = JSON.parse(String(state["config_json"])) as Allocation;
      requireStorage(
        old.projectId === next.projectId &&
          old.laneId === next.laneId &&
          old.portions
            .map((r) => r.laneId)
            .sort()
            .join() ===
            next.portions
              .map((r) => r.laneId)
              .sort()
              .join(),
        "budget revision cannot replace project or lanes",
      );
      this.db
        .prepare(
          "UPDATE usage_state SET config_json=?,high_water_ms=?,evidence_ref=?",
        )
        .run(json(next), now, evidenceRef);
    });
  }
  context(): {
    sessionId: string;
    ledgerId: string;
    historyHash: string;
    allocationHash: string;
  } {
    const state = this.state();
    requireStorage(state, "budget not configured");
    return {
      sessionId: this.session(),
      ledgerId: String(state["ledger_id"]),
      historyHash: sha256(json(this.history(), 16 * 1024 * 1024)),
      allocationHash: sha256(String(state["config_json"])),
    };
  }
  // Trusted, private recovery boundary, matching the chain continuity verifier model.
  // No HTTP route may accept attestations, history imports or allocation changes.
  reconcile(
    proof: ReturnType<BudgetRepository["context"]> & {
      fencing: "verified";
      history: "accounted" | "aged_out";
      evidenceRef: string;
    },
    now = Date.now(),
  ): void {
    timestamp(now);
    id(proof.evidenceRef);
    this.write(() => {
      const state = this.state()!,
        context = this.context();
      requireStorage(
        Object.entries(context).every(
          ([key, value]) => proof[key as keyof typeof context] === value,
        ) &&
          proof.fencing === "verified" &&
          now >= Number(state["high_water_ms"]),
        "usage continuity not verified",
      );
      requireStorage(
        proof.history === "accounted" ||
          (proof.history === "aged_out" &&
            Number(state["blocked_until"]) > 0 &&
            now >= Number(state["blocked_until"])),
        "missing provider history still protected",
      );
      this.db
        .prepare(
          "UPDATE usage_state SET verified_session=?,high_water_ms=?,blocked_until=0,evidence_ref=?",
        )
        .run(this.session(), now, proof.evidenceRef);
    });
  }
  /** Stop new shared-ledger admissions without releasing outstanding reservations. */
  invalidate(evidenceRef: string): void {
    id(evidenceRef);
    this.write(() =>
      this.db
        .prepare("UPDATE usage_state SET verified_session=NULL,evidence_ref=?")
        .run(evidenceRef),
    );
  }
  missingHistory(fencedAt: number, evidenceRef: string): void {
    timestamp(fencedAt);
    id(evidenceRef);
    this.write(() => {
      requireStorage(this.state(), "budget not configured");
      this.db
        .prepare(
          "UPDATE usage_state SET verified_session=NULL,blocked_until=max(blocked_until,?,high_water_ms+?),evidence_ref=?",
        )
        .run(fencedAt + month, month, evidenceRef);
    });
  }
  adopt(history: UsageHistory, now = Date.now()): void {
    timestamp(now);
    const config = json(this.config(history.config));
    requireStorage(history.entries.length <= 100000, "usage import too large");
    this.write(() => {
      const state = this.state();
      requireStorage(
        state &&
          state["config_json"] === config &&
          state["verified_session"] === null,
        "usage import needs blocked matching lane",
      );
      for (const row of history.entries) {
        id(row.request_id);
        label(row.provider);
        label(row.model);
        timestamp(row.started_at);
        requireStorage(
          row.started_at <= now &&
            typeof row.deployment === "string" &&
            row.deployment.length <= 2048 &&
            Number.isSafeInteger(row.reserved_micro) &&
            row.reserved_micro >= 1000 &&
            row.reserved_micro <= 5000000 &&
            Number.isSafeInteger(row.charged_micro) &&
            row.charged_micro >= 0 &&
            row.charged_micro <= 1000000000 &&
            Number.isSafeInteger(row.input_bound) &&
            row.input_bound >= 0 &&
            row.input_bound <= maximumInferenceInputTokens &&
            ["reserved", "accounted"].includes(row.status) &&
            (row.status !== "reserved" ||
              row.charged_micro === row.reserved_micro),
          "invalid usage record",
        );
        if (row.evidence_ref !== null) id(row.evidence_ref);
        const old = this.one(
          "SELECT * FROM inference_usage WHERE request_id=?",
          row.request_id,
        );
        if (old)
          requireStorage(json(old) === json(row), "usage identity conflict");
        else
          this.db
            .prepare("INSERT INTO inference_usage VALUES(?,?,?,?,?,?,?,?,?,?)")
            .run(
              row.request_id,
              row.deployment,
              row.provider,
              row.model,
              row.started_at,
              row.reserved_micro,
              row.charged_micro,
              row.input_bound,
              row.status,
              row.evidence_ref,
            );
      }
      this.db
        .prepare("UPDATE usage_state SET high_water_ms=max(high_water_ms,?)")
        .run(now);
    });
  }
  reserve(requestId: string, prepared: PreparedInference, now: number): void {
    id(requestId);
    timestamp(now);
    label(prepared.provider);
    label(prepared.model);
    id(prepared.accountingEvidence);
    id(prepared.pricingEvidence);
    requireStorage(
      typeof prepared.payload === "string" &&
        Buffer.byteLength(prepared.payload) <= 65536 &&
        prepared.maxOutputTokens === 512 &&
        Number.isSafeInteger(prepared.verifiedUntil) &&
        prepared.verifiedUntil >= now,
      "unverified inference configuration",
    );
    const tokens = prepared.countTokens(prepared.payload);
    requireStorage(
      Number.isSafeInteger(tokens) && tokens > 0 && tokens <= maximumInferenceInputTokens,
      "prepared request exceeds token budget",
    );
    for (const rate of [
      prepared.worstInputMicroPerMillion,
      prepared.outputMicroPerMillion,
    ])
      requireStorage(
        Number.isSafeInteger(rate) && rate >= 0 && rate <= 1000000000,
        "unverified rate bound",
      );
    const cost = Number(
        (BigInt(tokens) * BigInt(prepared.worstInputMicroPerMillion) +
          512n * BigInt(prepared.outputMicroPerMillion) +
          999999n) /
          1000000n,
      ),
      reserve = Math.max(1000, cost);
    this.write(() => {
      const state = this.state();
      requireStorage(
        state &&
          state["verified_session"] === this.session() &&
          Number(state["blocked_until"]) === 0 &&
          now >= Number(state["high_water_ms"]),
        "provider usage requires reconciliation",
      );
      // Only a verified, monotonic session can age usage out of every protected window.
      if (this.limits.lifetimeMicro === undefined)
        this.db
          .prepare("DELETE FROM inference_usage WHERE started_at<=?")
          .run(now - month);
      const config = JSON.parse(String(state["config_json"])) as Allocation,
        lane = config.portions.find((row) => row.laneId === config.laneId)!;
      const usage = this.one(
        "SELECT coalesce(sum(CASE WHEN started_at>? THEN charged_micro ELSE 0 END),0) AS daily,coalesce(sum(charged_micro),0) AS monthly FROM inference_usage WHERE started_at>?",
        now - day,
        now - month,
      )!;
      if (!this.limits.lifetimeOnly) {
      const counts = this.one(
        "SELECT coalesce(sum(started_at>?),0) AS hourly,coalesce(sum(started_at>?),0) AS daily FROM inference_usage",
        now - 3600000,
        now - day,
      )!;
      requireStorage(
        Number(counts["hourly"]) < 60 && Number(counts["daily"]) < 600,
        "rolling lane request cap reached",
      );
      requireStorage(
        Number(usage["daily"]) + reserve <= lane.dailyMicro &&
          Number(usage["monthly"]) + reserve <= lane.monthlyMicro,
        "rolling model spend cap reached",
      );
      }
      if (this.limits.lifetimeMicro !== undefined) {
        const total = Number(
          this.one(
            "SELECT coalesce(sum(charged_micro),0) n FROM inference_usage",
          )!["n"],
        );
        requireStorage(
          total + reserve <= this.limits.lifetimeMicro,
          "total hackathon model spend cap reached",
        );
      }
      this.db
        .prepare(
          "INSERT INTO inference_usage VALUES(?,?,?,?,?,?,?,?, 'reserved',NULL)",
        )
        .run(
          requestId,
          this.deployment,
          prepared.provider,
          prepared.model,
          now,
          reserve,
          reserve,
          tokens,
        );
      this.db.prepare("UPDATE usage_state SET high_water_ms=?").run(now);
    }, true);
  }
  account(
    requestId: string,
    provider: string,
    model: string,
    chargedMicro: number,
    evidenceRef: string,
  ): void {
    id(requestId);
    id(evidenceRef);
    const withinReservation = this.write(() => {
      const row = this.one(
        "SELECT * FROM inference_usage WHERE request_id=?",
        requestId,
      );
      requireStorage(
        row &&
          row["status"] === "reserved" &&
          row["provider"] === provider &&
          row["model"] === model &&
          Number.isSafeInteger(chargedMicro) &&
          chargedMicro >= 0 &&
          chargedMicro <= 1000000000,
        "authoritative usage mismatch",
      );
      this.db
        .prepare(
          "UPDATE inference_usage SET status='accounted',charged_micro=?,evidence_ref=? WHERE request_id=?",
        )
        .run(chargedMicro, evidenceRef, requestId);
      const within = chargedMicro <= Number(row["reserved_micro"]);
      if (!within) this.db.exec("UPDATE usage_state SET verified_session=NULL");
      return within;
    });
    requireStorage(
      withinReservation,
      "provider charge exceeded reservation; inference stopped",
    );
  }
}
