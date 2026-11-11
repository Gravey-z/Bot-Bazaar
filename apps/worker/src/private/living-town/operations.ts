import { writeFile, rename, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { requireStorage } from "../storage/validation.js";
import { statfsSync } from "node:fs";

export type OperationsMode = "active" | "paused" | "recovery_only";
type Series = "poll" | "tick" | "api" | "chain";
type Alert =
  | "snapshot_stale"
  | "chain_head_lag"
  | "tick_stalled"
  | "unknown_intents"
  | "storage_low"
  | "backup_missing"
  | "backup_failed"
  | "backup_incomplete"
  | "backup_stale"
  | "provider_unavailable"
  | "provider_stale"
  | "api_slow"
  | "poll_slow"
  | "budget_warning"
  | "budget_blocked"
  | "api_errors"
  | "chain_failures"
  | "actions_rejected"
  | "report_write_failed";
interface Metric {
  count: number;
  errors: number;
  total: number;
  max: number;
  samples: number[];
  recentErrors: boolean[];
}
interface Tick {
  id: string;
  slot: string;
  epoch: string;
  createdAt: number;
}
export interface RuntimeOperations {
  recoveryRequired: boolean;
  unresolved: number;
  oldestIntentAt: number | null;
  activeTick: Tick | null;
  lastCompletedTick: Tick | null;
  rejectedActions: number;
}
export interface BudgetOperations {
  rollingLimitsEnabled?: boolean;
  totalMicro?: number;
  totalLimit?: number;
  dailyMicro: number;
  monthlyMicro: number;
  dailyLimit: number;
  monthlyLimit: number;
  warning: boolean;
  blocked: boolean;
}
export const operationsLimits = Object.freeze({
  snapshotStaleMs: 30000,
  blockLagMs: 60000,
  tickStallMs: 120000,
  intentWarnMs: 120000,
  backupWarnMs: 86400000,
  minimumFreeBytes: 16 * 1024 * 1024,
  metricSamples: 128,
  eventLimit: 64,
  apiSlowMs: 1000,
  pollSlowMs: 15000,
});

/** Private aggregate telemetry. No request text, credentials, prompts, intents or owner IDs. */
export class TownOperations {
  private requestedMode: OperationsMode;
  private readonly metrics = new Map<Series, Metric>();
  private readonly events: {
    at: number;
    code: Alert;
    state: "raised" | "cleared";
  }[] = [];
  private readonly raised = new Set<Alert>();
  private snapshotAt: number | null = null;
  private blockAt: number | null = null;
  private runtime: RuntimeOperations | null = null;
  private observedActive: Tick | null = null;
  private provider: {
    state: "available" | "unavailable" | "disabled";
    budget: BudgetOperations | null;
    at: number;
  } | null = null;
  private backup: {
    state: "unconfigured" | "verified" | "failed" | "incomplete";
    capturedAt: number | null;
  } = { state: "unconfigured", capturedAt: null };
  private freeBytes: number | null = null;
  private writing: Promise<void> | undefined;
  private reportFailed = false;
  constructor(
    readonly role: "read_projection" | "simulation",
    private readonly clock = Date.now,
  ) {
    this.requestedMode = role === "simulation" ? "recovery_only" : "active";
  }
  get mode(): OperationsMode {
    return this.requestedMode;
  }
  getMode(): OperationsMode {
    return this.requestedMode;
  }
  setMode(mode: OperationsMode): void {
    requireStorage(
      ["active", "paused", "recovery_only"].includes(mode),
      "invalid operations mode",
    );
    if (mode === "active")
      requireStorage(
        !this.reportFailed &&
          (this.freeBytes === null ||
            this.freeBytes >= operationsLimits.minimumFreeBytes),
        "repair storage before resuming",
      );
    this.requestedMode = mode;
    // This does not clear any execution, usage, permission or recovery gate.
  }
  record(series: Series, durationMs: number, failed = false): void {
    if (!["poll", "tick", "api", "chain"].includes(series)) return;
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    let m = this.metrics.get(series);
    if (!m) {
      m = {
        count: 0,
        errors: 0,
        total: 0,
        max: 0,
        samples: [],
        recentErrors: [],
      };
      this.metrics.set(series, m);
    }
    const value = Math.min(durationMs, 600000);
    m.count++;
    if (failed) m.errors++;
    m.total += value;
    m.max = Math.max(m.max, value);
    m.samples = [...m.samples, value].slice(-operationsLimits.metricSamples);
    m.recentErrors = [...m.recentErrors, failed].slice(
      -operationsLimits.metricSamples,
    );
  }
  observeSnapshot(observedAt: number, blockTimestampNs: string): void {
    this.snapshotAt = observedAt;
    this.blockAt = Number(BigInt(blockTimestampNs) / 1000000n);
  }
  async measure<T>(series: Series, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let failed = false;
    try {
      return await run();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.record(series, performance.now() - start, failed);
    }
  }
  observeDisk(path: string): void {
    try {
      const disk = statfsSync(path);
      this.observeStorage(disk.bavail * disk.bsize);
    } catch {
      this.observeStorage(0);
    }
  }
  observeRuntime(value: RuntimeOperations): void {
    if (
      value.lastCompletedTick &&
      value.lastCompletedTick.id === this.observedActive?.id
    ) {
      this.record(
        "tick",
        Math.max(0, this.clock() - this.observedActive.createdAt),
      );
      this.observedActive = null;
    }
    if (value.activeTick) this.observedActive = value.activeTick;
    this.runtime = value;
  }
  observeProvider(
    state: "available" | "unavailable" | "disabled",
    budget: BudgetOperations | null,
    at = this.clock(),
  ): void {
    this.provider = { state, budget, at };
  }
  observeBackup(
    state: "unconfigured" | "verified" | "failed",
    capturedAt: number | null = null,
    historyComplete = true,
  ): void {
    this.backup = {
      state: state === "verified" && !historyComplete ? "incomplete" : state,
      capturedAt,
    };
  }
  observeStorage(freeBytes: number): void {
    this.freeBytes = freeBytes;
    if (freeBytes < operationsLimits.minimumFreeBytes)
      this.requestedMode = "recovery_only";
  }
  snapshot(): Record<string, unknown> {
    const now = this.clock(),
      age = (at: number | null) =>
        at === null || !Number.isFinite(at) || at > now ? null : now - at;
    const alerts = new Set<Alert>(),
      snapshotAge = age(this.snapshotAt),
      blockAge = age(this.blockAt),
      budget = this.provider?.budget;
    if (snapshotAge === null || snapshotAge > operationsLimits.snapshotStaleMs)
      alerts.add("snapshot_stale");
    if (
      this.blockAt !== null &&
      (blockAge === null || blockAge > operationsLimits.blockLagMs)
    )
      alerts.add("chain_head_lag");
    if (
      this.runtime?.activeTick &&
      (age(this.runtime.activeTick.createdAt) ?? Infinity) >
        operationsLimits.tickStallMs
    )
      alerts.add("tick_stalled");
    if (
      this.runtime?.unresolved &&
      (age(this.runtime.oldestIntentAt) ?? Infinity) >
        operationsLimits.intentWarnMs
    )
      alerts.add("unknown_intents");
    if (
      this.freeBytes !== null &&
      this.freeBytes < operationsLimits.minimumFreeBytes
    )
      alerts.add("storage_low");
    if (this.backup.state === "unconfigured") alerts.add("backup_missing");
    if (this.backup.state === "failed") alerts.add("backup_failed");
    if (this.backup.state === "incomplete") alerts.add("backup_incomplete");
    const backupAge = age(this.backup.capturedAt);
    if (
      ["verified", "incomplete"].includes(this.backup.state) &&
      (backupAge === null || backupAge > operationsLimits.backupWarnMs)
    )
      alerts.add("backup_stale");
    if (this.provider?.state === "unavailable")
      alerts.add("provider_unavailable");
    if (
      this.provider &&
      this.provider.state !== "disabled" &&
      (age(this.provider.at) ?? Infinity) > 120000
    )
      alerts.add("provider_stale");
    if (budget?.warning) alerts.add("budget_warning");
    const totalRemaining = budget?.rollingLimitsEnabled === false && budget.totalLimit !== undefined
      ? Math.max(0, budget.totalLimit - (budget.totalMicro ?? 0)) : null;
    const dailyRemaining = totalRemaining ?? (budget
      ? Math.max(0, budget.dailyLimit - budget.dailyMicro)
      : null);
    const monthlyRemaining = totalRemaining ?? (budget
      ? Math.max(0, budget.monthlyLimit - budget.monthlyMicro)
      : null);
    if (
      budget &&
      (budget.blocked || dailyRemaining === 0 || monthlyRemaining === 0)
    )
      alerts.add("budget_blocked");
    if (
      (this.metrics.get("api")?.recentErrors.filter(Boolean).length ?? 0) >= 3
    )
      alerts.add("api_errors");
    if (
      (this.metrics.get("chain")?.recentErrors.filter(Boolean).length ?? 0) >= 3
    )
      alerts.add("chain_failures");
    if (this.runtime?.rejectedActions) alerts.add("actions_rejected");
    for (const [series, code, threshold] of [
      ["api", "api_slow", operationsLimits.apiSlowMs],
      ["poll", "poll_slow", operationsLimits.pollSlowMs],
    ] as const) {
      const samples = [...(this.metrics.get(series)?.samples ?? [])].sort(
        (a, b) => a - b,
      );
      if (
        (samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0) >=
        threshold
      )
        alerts.add(code);
    }
    if (this.reportFailed) alerts.add("report_write_failed");
    for (const code of new Set([...alerts, ...this.raised])) {
      if (alerts.has(code) !== this.raised.has(code))
        this.events.push({
          at: now,
          code,
          state: alerts.has(code) ? "raised" : "cleared",
        });
    }
    this.raised.clear();
    for (const code of alerts) this.raised.add(code);
    this.events.splice(
      0,
      Math.max(0, this.events.length - operationsLimits.eventLimit),
    );
    const metrics = Object.fromEntries(
      [...this.metrics].map(([name, m]) => {
        const values = [...m.samples].sort((a, b) => a - b),
          p = (percent: number) =>
            values[Math.max(0, Math.ceil(values.length * percent) - 1)] ?? null;
        return [
          name,
          {
            count: m.count,
            errors: m.errors,
            meanMs: m.count ? m.total / m.count : null,
            maxMs: m.max,
            p50Ms: p(0.5),
            p95Ms: p(0.95),
            windowSamples: values.length,
          },
        ];
      }),
    );
    return {
      schema: "living-town-operations-v1",
      role: this.role,
      mode: this.mode,
      capturedAt: now,
      readiness: {
        readProjection:
          snapshotAge !== null &&
          snapshotAge <= operationsLimits.snapshotStaleMs,
        signingRuntime:
          this.role === "simulation" &&
          this.mode === "active" &&
          this.runtime !== null &&
          !this.runtime.recoveryRequired &&
          this.runtime.unresolved === 0 &&
          snapshotAge !== null &&
          snapshotAge <= operationsLimits.snapshotStaleMs &&
          !alerts.has("storage_low") &&
          !alerts.has("chain_head_lag") &&
          !alerts.has("budget_blocked"),
      },
      snapshotAgeMs: snapshotAge,
      finalizedBlockAgeMs: blockAge,
      runtime: this.runtime,
      provider: this.provider
        ? {
            state: this.provider.state,
            observedAgeMs: age(this.provider.at),
            budget,
            headroom: {
              dailyMicro: dailyRemaining,
              monthlyMicro: monthlyRemaining,
            },
          }
        : { state: "not_attached", budget: null, headroom: null },
      backup: { ...this.backup, ageMs: backupAge },
      freeBytes: this.freeBytes,
      metrics,
      alerts: [...alerts].sort(),
      events: [...this.events],
    };
  }
  async persist(directory: string): Promise<void> {
    if (this.writing) return this.writing;
    this.writing = (async () => {
      try {
        requireStorage(
          isAbsolute(directory),
          "absolute private report directory required",
        );
        const dir = await lstat(directory);
        requireStorage(
          dir.isDirectory() && !dir.isSymbolicLink(),
          "regular private report directory required",
        );
        const body = JSON.stringify(this.snapshot());
        requireStorage(
          Buffer.byteLength(body) <= 65536,
          "operations report capacity exceeded",
        );
        const temporary = join(directory, "operations-health.tmp"),
          target = join(directory, "operations-health.json");
        try {
          const stat = await lstat(temporary);
          requireStorage(
            stat.isFile() && !stat.isSymbolicLink(),
            "unsafe report temporary file",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, target);
        this.reportFailed = false;
      } catch (error) {
        this.requestedMode = "recovery_only";
        this.reportFailed = true;
        throw error;
      }
    })();
    try {
      await this.writing;
    } finally {
      this.writing = undefined;
    }
  }
}
