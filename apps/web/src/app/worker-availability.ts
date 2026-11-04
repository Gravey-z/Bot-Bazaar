import type { PublicDeployment, PublicHealth } from "@bot-bazaar/shared";
import { decodeDeployment } from "./activity-wire";

export interface WorkerAvailability {
  readonly deployment: PublicDeployment;
  readonly generation: string | null;
  readonly capturedAt: number;
  readonly heartbeatAt: number;
  readonly ready: boolean;
  readonly ai: Pick<
    PublicHealth["ai"],
    "mode" | "status" | "currentSession" | "observedAt"
  >;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid availability");
  return value as Record<string, unknown>;
}
export function decodeAvailability(value: unknown): WorkerAvailability {
  const row = object(value),
    ai = object(row["ai"]);
  const keys = [
    "status",
    "api_version",
    "worker_version",
    "policy_version",
    "database",
    "recovery",
    "backup",
    "discovery",
    "scheduling",
    "ai",
    "deployment",
    "feed_generation",
    "captured_at",
    "heartbeat_at",
    "chain",
    "activity",
  ];
  const stamp = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key)) ||
    row["api_version"] !== "1" ||
    !["ready", "not_ready"].includes(String(row["status"])) ||
    !stamp(row["captured_at"]) ||
    !stamp(row["heartbeat_at"]) ||
    !(
      row["feed_generation"] === null ||
      (typeof row["feed_generation"] === "string" &&
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(
          row["feed_generation"],
        ))
    ) ||
    !["disabled", "unconfigured", "provider", "diagnostic"].includes(
      String(ai["mode"]),
    ) ||
    ![
      "unavailable",
      "pending",
      "response_received",
      "validation_error",
      "diagnostic",
    ].includes(String(ai["status"])) ||
    ai["liveAiEvidence"] !== false ||
    typeof ai["currentSession"] !== "boolean" ||
    !(ai["observedAt"] === null || stamp(ai["observedAt"]))
  )
    throw new Error("Invalid availability");
  // Only the fields needed for a fixed local status label cross this boundary.
  return {
    deployment: decodeDeployment(row["deployment"]),
    generation: row["feed_generation"] as string | null,
    capturedAt: row["captured_at"],
    heartbeatAt: row["heartbeat_at"],
    ready: row["status"] === "ready",
    ai: {
      mode: ai["mode"] as WorkerAvailability["ai"]["mode"],
      status: ai["status"] as WorkerAvailability["ai"]["status"],
      currentSession: ai["currentSession"],
      observedAt: ai["observedAt"] as number | null,
    },
  };
}
export function availabilityNotice(
  health: WorkerAvailability | null,
  codeHash: string | null,
  chainFresh: boolean,
  generation: string | null,
  now: number,
): string {
  if (!health)
    return "AI availability unknown. Worker health could not be read; refreshing does not start an AI request.";
  if (
    now - health.capturedAt > 15000 ||
    health.capturedAt > now + 5000 ||
    now - health.heartbeatAt > 15000 ||
    health.heartbeatAt > now + 5000
  )
    return "AI availability unknown. Worker health is stale; previous decisions remain historical records.";
  if (!chainFresh || !codeHash)
    return "AI availability unknown until a fresh contract identity can be checked.";
  if (
    health.deployment.expected_code_hash !== codeHash ||
    (generation !== null && health.generation !== generation)
  )
    return "AI availability unknown. Worker health belongs to a different deployment or feed generation.";
  const prefix = health.ready ? "" : "Worker not ready. ";
  if (health.ai.mode === "disabled")
    return (
      prefix + "AI is disabled. Read retries will not enable it or use credits."
    );
  if (health.ai.mode === "unconfigured")
    return (
      prefix + "AI is not configured. No live model reaction is available."
    );
  if (health.ai.mode === "diagnostic" || health.ai.status === "diagnostic")
    return prefix + "Diagnostic AI mode; this is not a live model run.";
  if (!health.ai.currentSession)
    return (
      prefix +
      "No current-session AI evidence. Earlier responses do not establish provider availability."
    );
  if (health.ai.observedAt !== null && health.ai.observedAt > now + 5000)
    return (
      prefix +
      "AI availability unknown; the provider observation time is inconsistent."
    );
  if (health.ai.status === "pending")
    return (
      prefix + "AI request pending. A response or trade is not yet confirmed."
    );
  if (health.ai.status === "validation_error")
    return (
      prefix +
      "AI validation error. No accepted model action is implied; refresh only checks status."
    );
  if (health.ai.status === "response_received")
    return (
      prefix +
      "An AI response was recorded. This does not verify a completed trade or live acceptance run."
    );
  return (
    prefix +
    "AI unavailable. No model reaction is promised; refresh only checks status."
  );
}
