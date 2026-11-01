import type { WorkerStore } from "../storage/database.js";
import { requireStorage, StorageError } from "../storage/validation.js";
import { SafetyClock } from "./clock.js";
import type { ProviderRequest } from "./repository.js";
import { parseDecision, DecisionValidationError } from "../decisions/schema.js";
import type { Decision } from "../decisions/schema.js";
import type { InferencePolicy, PreparedInference } from "../policy/budget.js";
import { recordInferenceInput } from "../inference/input.js";
import type { RecordedInput } from "../inference/input.js";
import { InferenceUnavailableError } from "../inference/availability.js";
import type { AiCode } from "../inference/availability.js";
export class DefinitiveProviderFailure extends Error {}
export type ProviderResponse = Decision;
export class ProviderRunner {
  constructor(
    private readonly store: WorkerStore,
    private readonly clock = new SafetyClock(() =>
      store.retry.blockClock(Date.now()),
    ),
    private readonly inference?: InferencePolicy,
  ) {}
  private unavailable(code: AiCode): InferenceUnavailableError {
    this.store.availability.unavailable(code);
    return new InferenceUnavailableError(code);
  }
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
      payload: string;
      maxOutputTokens: 512;
      reportIdentity: (identity: { provider: string; model: string }) => void;
    }) => Promise<unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    requestId: string;
    decision: ProviderResponse;
    assertCurrent: () => void;
  }> {
    request = { ...request };
    let now: number;
    try {
      now = this.clock.now();
    } catch {
      throw this.unavailable("clock_unavailable");
    }
    let prepared: PreparedInference;
    let recordedInput: RecordedInput;
    try {
      if (!this.inference)
        throw new InferenceUnavailableError("provider_not_configured");
      prepared = { ...this.inference.prepare(request) };
      if (
        prepared.provider !== request.provider ||
        prepared.model !== request.model
      )
        throw new InferenceUnavailableError("model_identity_mismatch");
      recordedInput = recordInferenceInput(prepared.payload);
      if (recordedInput.status !== "recorded")
        throw new InferenceUnavailableError("input_unavailable");
      this.store.budget.reserve(request.id, prepared, now);
    } catch (error) {
      throw this.unavailable(
        error instanceof InferenceUnavailableError
          ? error.code
          : "admission_unavailable",
      );
    }
    if (this.store.budget.status(now).warning)
      console.error(
        "Worker model budget at or above 80 percent; admission limits remain enforced",
      );
    let record: ReturnType<WorkerStore["retry"]["reserve"]>;
    try {
      record = this.store.retry.reserve(
        request,
        now,
        options.timeoutMs ?? 15000,
        recordedInput,
      );
    } catch {
      throw this.unavailable("admission_unavailable");
    }
    this.store.availability.admitted();
    const abort = new AbortController();
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
        new InferenceUnavailableError(
          reason === "timeout" ? "request_timeout" : "request_cancelled",
        ),
      );
    };
    const invalidate = () => expire("cancelled");
    const external = options.signal;
    if (external?.aborted) {
      this.store.retry.fail(request.id, false, "cancelled_before_dispatch");
      throw new InferenceUnavailableError("request_cancelled");
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
            this.store.records.dispatch(request.id, this.clock.now());
            return invoke({
              signal: abort.signal,
              requestId: request.id,
              payload: prepared.payload,
              maxOutputTokens: 512,
              reportIdentity: (identity) =>
                this.store.records.identity(
                  request.id,
                  identity.provider,
                  identity.model,
                  this.clock.now(),
                ),
            });
          })
          .then((value) => {
            let response: Decision;
            try {
              response = parseDecision(value);
            } catch (error) {
              this.store.records.invalidResponse(
                request.id,
                value,
                this.clock.now(),
              );
              throw error;
            }
            this.store.records.validResponse(
              request.id,
              response.action,
              response.reason,
              this.clock.now(),
            );
            if (expired) {
              this.store.retry.accept(
                request.id,
                response.action,
                response.reason,
                this.clock.now(),
              );
              throw new Error("late response");
            }
            return response;
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
        decision: parseDecision({
          action: JSON.parse(String(saved["action_json"])),
          reason: String(saved["reason"]),
        }),
        assertCurrent,
      };
    } catch (error) {
      try {
        this.store.retry.fail(
          request.id,
          error instanceof DefinitiveProviderFailure ||
            error instanceof DecisionValidationError,
          error instanceof DecisionValidationError
            ? "invalid_decision"
            : error instanceof DefinitiveProviderFailure
              ? "definitive_failure"
              : "unknown_outcome",
        );
      } catch {
        throw this.unavailable("storage_unavailable");
      }
      let summary;
      try {
        summary = this.store.records.status(request.id);
      } catch {
        throw this.unavailable("storage_unavailable");
      }
      throw new InferenceUnavailableError(summary?.code ?? "outcome_unknown");
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", invalidate);
    }
  }
}
