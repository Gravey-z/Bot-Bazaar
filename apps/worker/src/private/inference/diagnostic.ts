import { parseDecision, DecisionValidationError } from "../decisions/schema.js";
import type { Decision } from "../decisions/schema.js";
import { evaluateDecision, PolicyError } from "../policy/evaluate.js";
import type { PolicyContext } from "../policy/evaluate.js";
import { sanitizeBriefReason } from "../storage/validation.js";
export type DiagnosticResult = {
  source: "diagnostic";
  label: "Diagnostic test data";
  liveAiEvidence: false;
} & (
  | { validation: "valid"; candidate: Decision }
  | {
      validation: "invalid";
      code: "schema_invalid" | "policy_rejected" | "diagnostic_unavailable";
    }
);
// Explicit offline validation only: no provider, journal, budget or signing capability.
// It is never selected as an outage fallback and cannot act as a live decision envelope.
export function runDiagnostic(
  value: unknown,
  context: PolicyContext,
  now = Date.now(),
): DiagnosticResult {
  const provenance = {
    source: "diagnostic",
    label: "Diagnostic test data",
    liveAiEvidence: false,
  } as const;
  try {
    const parsed = parseDecision(value),
      candidate = { ...parsed, reason: sanitizeBriefReason(parsed.reason) };
    evaluateDecision(candidate.action, context, now);
    return { ...provenance, validation: "valid", candidate };
  } catch (error) {
    return {
      ...provenance,
      validation: "invalid",
      code:
        error instanceof DecisionValidationError
          ? "schema_invalid"
          : error instanceof PolicyError
            ? "policy_rejected"
            : "diagnostic_unavailable",
    };
  }
}
