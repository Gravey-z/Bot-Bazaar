import { setTimeout as delay } from "node:timers/promises";

export interface WorkerDefinition {
  name: string;
  intervalMs: number;
  tick: () => Promise<unknown>;
}
interface WorkerState {
  running: boolean;
  passes: number;
  failures: number;
  lastStarted: number | null;
  lastFinished: number | null;
  result: unknown;
}

/** Independent async services inside the exclusive journal-owning process.
 * No loop can overlap itself; failures and backoff belong to that service.
 */
export class LivingTownWorkerGroup {
  private readonly abort = new AbortController();
  private readonly tasks: Promise<void>[] = [];
  private readonly states = new Map<string, WorkerState>();
  constructor(
    private readonly reportError: (
      worker: string,
      error: unknown,
    ) => Promise<void>,
  ) {}

  start(worker: WorkerDefinition): void {
    if (this.states.has(worker.name)) throw new Error("Worker already started");
    const state: WorkerState = {
      running: false,
      passes: 0,
      failures: 0,
      lastStarted: null,
      lastFinished: null,
      result: null,
    };
    this.states.set(worker.name, state);
    this.tasks.push(
      (async () => {
        while (!this.abort.signal.aborted) {
          state.running = true;
          state.lastStarted = Date.now();
          try {
            state.result = await worker.tick();
            state.passes++;
            state.failures = 0;
          } catch (error) {
            const waiting =
              error instanceof Error &&
              (error.name === "SharedMerchantFactsUnavailable" ||
                error.message ===
                  "Worker storage: verified V2 recovery required");
            const detail = error instanceof Error ? error as Error & { reason?: string; details?: unknown } : null;
            state.result = { kind: waiting ? "deferred" : "failed",
              diagnostic: detail?.reason ?? detail?.message ?? "worker_dependency_failed",
              diagnostic_details: detail?.details ?? null };
            if (detail?.name === "SharedMerchantFactsUnavailable")
              console.warn(JSON.stringify({ role: "economic_runtime", event: "planning_projection_deferred",
                worker: worker.name, ...state.result as Record<string, unknown> }));
            if (!waiting) {
              state.failures++;
              // Reporting failure must not become an unhandled rejection or stop
              // unrelated workers. The original error remains in this service's state.
              try {
                await this.reportError(worker.name, error);
              } catch {
                state.result = {
                  kind: "failed",
                  diagnostic: "error_report_unavailable",
                };
              }
            }
          } finally {
            state.running = false;
            state.lastFinished = Date.now();
          }
          await delay(
            Math.min(
              60000,
              worker.intervalMs * 2 ** Math.min(state.failures, 5),
            ),
            undefined,
            { signal: this.abort.signal },
          ).catch(() => {});
        }
      })(),
    );
  }

  status(): unknown {
    return Object.fromEntries(this.states);
  }
  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.tasks);
  }
}
