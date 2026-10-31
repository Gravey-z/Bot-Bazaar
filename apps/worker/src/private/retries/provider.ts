import type { WorkerStore } from "../storage/database.js";
import { requireStorage, StorageError } from "../storage/validation.js";
import { SafetyClock } from "./clock.js";
import type { ProviderRequest } from "./repository.js";
export class DefinitiveProviderFailure extends Error {}
export interface ProviderResponse {
  action: unknown;
  reason: string;
}
export class ProviderRunner {
  constructor(
    private readonly store: WorkerStore,
    private readonly clock = new SafetyClock(() =>
      store.retry.blockClock(Date.now()),
    ),
  ) {}
  resumeClock(): void {
    requireStorage(
      this.store.checkpoint()["recovery_required"] === 0 &&
        this.store.retry.state()["clock_blocked"] === 0,
      "verified clock recovery required",
    );
    this.clock.rebase();
  }
  async run(
    request: ProviderRequest,
    invoke: (context: {
      signal: AbortSignal;
      requestId: string;
    }) => Promise<ProviderResponse>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    requestId: string;
    decision: ProviderResponse;
    assertCurrent: () => void;
  }> {
    request = { ...request };
    const now = this.clock.now(),
      record = this.store.retry.reserve(
        request,
        now,
        options.timeoutMs ?? 15000,
      ),
      abort = new AbortController();
    let expired = false;
    let rejectAbort: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const expire = (reason: string) => {
      expired = true;
      abort.abort();
      try {
        this.store.retry.fail(request.id, false, reason);
      } catch {
        /* No late result may authorize work after failed persistence. */
      }
      rejectAbort(
        new StorageError("provider request interrupted; outcome unknown"),
      );
    };
    const invalidate = () => expire("cancelled");
    const external = options.signal;
    if (external?.aborted) {
      this.store.retry.fail(request.id, false, "cancelled_before_dispatch");
      throw new StorageError("provider request cancelled before dispatch");
    }
    external?.addEventListener("abort", invalidate, { once: true });
    const timer = setTimeout(
      () => expire("timeout"),
      Math.max(1, Number(record["deadline"]) - now),
    );
    try {
      const response = await Promise.race([
        Promise.resolve()
          .then(() => {
            if (expired) throw new Error("cancelled");
            this.store.retry.assertPendingCurrent(request.id, this.clock.now());
            return invoke({ signal: abort.signal, requestId: request.id });
          })
          .then((value) => {
            if (expired) {
              this.store.retry.accept(
                request.id,
                value.action,
                value.reason,
                this.clock.now(),
              );
              throw new Error("late response");
            }
            return value;
          }),
        interrupted,
      ]);
      if (
        !this.store.retry.accept(
          request.id,
          response.action,
          response.reason,
          this.clock.now(),
        )
      )
        throw new StorageError("provider response was revoked");
      const assertCurrent = () =>
        this.store.retry.assertDecisionCurrent(request.id, this.clock.now());
      assertCurrent();
      const saved = this.store.getDecision(request.id)!;
      return {
        requestId: request.id,
        decision: {
          action: JSON.parse(String(saved["action_json"])),
          reason: String(saved["reason"]),
        },
        assertCurrent,
      };
    } catch (error) {
      this.store.retry.fail(
        request.id,
        error instanceof DefinitiveProviderFailure,
        error instanceof DefinitiveProviderFailure
          ? "definitive_failure"
          : "unknown_outcome",
      );
      throw new StorageError(
        "provider attempt failed or became unknown; no automatic retry",
      );
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", invalidate);
    }
  }
}
