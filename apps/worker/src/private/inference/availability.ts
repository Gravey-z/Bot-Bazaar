import type { WorkerStore } from "../storage/database.js";
import { StorageError } from "../storage/validation.js";
export type AiCode =
  | "provider_disabled"
  | "provider_not_configured"
  | "storage_unavailable"
  | "recovery_required"
  | "market_paused"
  | "snapshot_unavailable"
  | "admission_unavailable"
  | "input_unavailable"
  | "clock_unavailable"
  | "model_identity_mismatch"
  | "provider_failure"
  | "request_timeout"
  | "request_cancelled"
  | "outcome_unknown"
  | "schema_invalid"
  | "policy_rejected"
  | "policy_unavailable"
  | "request_pending"
  | "response_recorded"
  | "history_unavailable"
  | "no_inference_record"
  | "diagnostic_mode";
export type AiState =
  | "unavailable"
  | "pending"
  | "response_received"
  | "validation_error"
  | "diagnostic";
export interface InferenceStatus {
  status: AiState;
  label: string;
  code: AiCode;
  observedAt: number | null;
  currentSession: boolean;
}
export interface AiAvailability extends InferenceStatus {
  mode: "disabled" | "unconfigured" | "provider" | "diagnostic";
  liveAiEvidence: false;
  lastInference: InferenceStatus | null;
  lastAdmission: InferenceStatus | null;
}
export class InferenceUnavailableError extends StorageError {
  constructor(readonly code: AiCode) {
    super(
      code === "schema_invalid" || code === "policy_rejected"
        ? "AI validation error"
        : "AI unavailable",
    );
    this.name = "InferenceUnavailableError";
  }
}
function stamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export function statusFor(
  code: AiCode,
  observedAt: number | null = null,
  currentSession = false,
): InferenceStatus {
  const status: AiState =
    code === "schema_invalid" || code === "policy_rejected"
      ? "validation_error"
      : code === "request_pending"
        ? "pending"
        : code === "response_recorded"
          ? "response_received"
          : code === "diagnostic_mode"
            ? "diagnostic"
            : "unavailable";
  const label =
    status === "validation_error"
      ? "AI validation error"
      : status === "pending"
        ? "AI request in progress"
        : status === "response_received"
          ? "AI response received"
          : status === "diagnostic"
            ? "Diagnostic test data"
            : "AI unavailable";
  return { status, label, code, observedAt: stamp(observedAt), currentSession };
}
// Only a fixed public status vocabulary leaves the private inference journal.
// Provider errors, decision reasons, prompts, IDs and transaction bytes are omitted.
export function summarizeInference(
  row: Readonly<Record<string, unknown>>,
): InferenceStatus {
  const at = stamp(row["updated_at"]),
    current = row["current_session"] === 1;
  if (row["outcome_code"] === "model_identity_mismatch")
    return statusFor("model_identity_mismatch", at, current);
  if (row["schema_outcome"] === "invalid")
    return statusFor("schema_invalid", at, current);
  if (row["policy_outcome"] === "rejected")
    return statusFor("policy_rejected", at, current);
  if (row["policy_outcome"] === "unavailable")
    return statusFor("policy_unavailable", at, current);
  if (row["outcome"] === "legacy_unavailable")
    return statusFor("history_unavailable", at, current);
  if (row["outcome"] === "pending")
    return statusFor("request_pending", at, current);
  if (
    row["outcome"] === "schema_valid" &&
    row["provider_status"] === "succeeded"
  )
    return statusFor("response_recorded", at, current);
  const codes: Readonly<Record<string, AiCode>> = {
    timeout: "request_timeout",
    cancelled: "request_cancelled",
    cancelled_before_dispatch: "request_cancelled",
    paused: "market_paused",
    restart: "recovery_required",
    recovery: "recovery_required",
    clock_discontinuity: "clock_unavailable",
    definitive_failure: "provider_failure",
    invalid_decision: "schema_invalid",
  };
  const key = String(row["outcome_code"]);
  return statusFor(
    Object.hasOwn(codes, key) ? codes[key]! : "outcome_unknown",
    at,
    current,
  );
}
export class InferenceAvailability {
  private failure: InferenceStatus | null = null;
  unavailable(code: AiCode, now = Date.now()): void {
    this.failure = statusFor(code, now, true);
  }
  admitted(): void {
    this.failure = null;
  }
  lastFailure(): InferenceStatus | null {
    return this.failure ? { ...this.failure } : null;
  }
}
export function readAiAvailability(
  store: WorkerStore,
  mode: AiAvailability["mode"],
  now = Date.now(),
): AiAvailability {
  let last: InferenceStatus | null = null;
  const result = (code: AiCode): AiAvailability => ({
    ...statusFor(code),
    mode,
    liveAiEvidence: false,
    lastInference: last,
    lastAdmission: store.availability.lastFailure(),
  });
  try {
    if (!store.available) return result("storage_unavailable");
    last = store.records.latestStatus();
    if (mode === "diagnostic") return result("diagnostic_mode");
    if (mode === "disabled") return result("provider_disabled");
    if (mode === "unconfigured") return result("provider_not_configured");
    if (store.checkpoint()["recovery_required"] !== 0)
      return result("recovery_required");
    const state = store.discoveryState();
    if (!state || now < state.observedAt || now - state.observedAt > 15000)
      return result("snapshot_unavailable");
    if (state.market.data.paused) return result("market_paused");
    if (!store.budget.state() || store.budget.status(now).blocked)
      return result("admission_unavailable");
    const failure = store.availability.lastFailure();
    if (failure)
      return {
        ...failure,
        mode,
        liveAiEvidence: false,
        lastInference: last,
        lastAdmission: failure,
      };
    // Prior-session success is history, not evidence that this process can infer.
    if (!last?.currentSession)
      return result(last ? "recovery_required" : "no_inference_record");
    return {
      ...last,
      mode,
      liveAiEvidence: false,
      lastInference: last,
      lastAdmission: null,
    };
  } catch {
    return result("storage_unavailable");
  }
}
