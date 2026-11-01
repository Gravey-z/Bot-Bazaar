import type { WorkerStore } from "../storage/database.js";
import type {
  PublicDeployment,
  PublicChainObservation,
} from "@bot-bazaar/shared";
import { readAiAvailability } from "../inference/availability.js";
import type { AiAvailability } from "../inference/availability.js";
import { safeId } from "../activity/projection.js";
export interface HealthContext {
  backup: "verified" | "failed";
  discovery: "starting" | "ready" | "unavailable" | "stopped" | "disabled";
  scheduling: "ready" | "unavailable" | "waiting_for_recovery";
  aiMode: AiAvailability["mode"];
}
export interface HealthPage {
  status: "not_ready";
  api_version: "1";
  worker_version: "0.1.0";
  policy_version: string | null;
  database: "ready" | "unavailable";
  recovery: "required" | "reconciled";
  backup: HealthContext["backup"];
  discovery: HealthContext["discovery"];
  scheduling: HealthContext["scheduling"];
  ai: AiAvailability;
  deployment: PublicDeployment;
  feed_generation: string | null;
  captured_at: number;
  heartbeat_at: number;
  chain: PublicChainObservation;
  activity: { high_water_sequence: string; pruned_through: string } | null;
}
export function readHealth(
  store: WorkerStore,
  context: HealthContext,
  now = Date.now(),
): HealthPage {
  let generation: string | null = null,
    policy: string | null = null,
    recovery: HealthPage["recovery"] = "required",
    activity: HealthPage["activity"] = null;
  let chain: PublicChainObservation = {
    block_height: null,
    block_hash: null,
    market_revision: null,
    observed_at: null,
    age_ms: null,
    stale: true,
    paused: null,
  };
  let database: HealthPage["database"] = store.available
    ? "ready"
    : "unavailable";
  try {
    if (store.available) {
      generation = store.activity.generation();
      const state = store.activity.state();
      activity = {
        high_water_sequence: state.high_water_sequence,
        pruned_through: state.pruned_through,
      };
      chain = store.activity.chain(now);
      const checkpoint = store.checkpoint();
      policy = safeId(checkpoint["policy_version"]);
      recovery =
        checkpoint["recovery_required"] === 0 ? "reconciled" : "required";
    }
  } catch {
    database = "unavailable";
  }
  return {
    status: "not_ready",
    api_version: "1",
    worker_version: "0.1.0",
    policy_version: policy,
    database,
    recovery,
    backup: context.backup,
    discovery: context.discovery,
    scheduling: context.scheduling,
    ai: readAiAvailability(store, context.aiMode, now),
    deployment: store.activity.deployment,
    feed_generation: generation,
    captured_at: now,
    heartbeat_at: now,
    chain,
    activity,
  };
}
