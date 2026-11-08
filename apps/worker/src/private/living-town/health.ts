import type { LivingTownDeployment } from "@bot-bazaar/shared";
import type { LivingTownProjectionStore } from "./store.js";
export interface LivingTownHealth {
  status: "ready" | "not_ready";
  api_version: "2.0.0";
  deployment: LivingTownDeployment;
  feed_generation: string | null;
  captured_at: number;
  stale: boolean;
  history_complete: boolean;
  role: "read_projection";
  snapshot_age_ms: number | null;
  finalized_block_age_ms: number | null;
}
export function readLivingTownHealth(
  store: LivingTownProjectionStore,
  now = Date.now(),
): LivingTownHealth {
  try {
    const town = store.town(now);
    return {
      status: town.stale ? "not_ready" : "ready",
      api_version: "2.0.0",
      deployment: store.identity.deployment,
      feed_generation: town.checkpoint.feed_generation,
      captured_at: now,
      stale: town.stale,
      history_complete: town.history_complete,
      role: "read_projection",
      snapshot_age_ms:
        now >= Number(town.observed_at_ms)
          ? now - Number(town.observed_at_ms)
          : null,
      finalized_block_age_ms:
        now >= Number(BigInt(town.snapshot.block_timestamp_ns) / 1000000n)
          ? now - Number(BigInt(town.snapshot.block_timestamp_ns) / 1000000n)
          : null,
    };
  } catch {
    return {
      status: "not_ready",
      api_version: "2.0.0",
      deployment: store.identity.deployment,
      feed_generation: null,
      captured_at: now,
      stale: true,
      history_complete: false,
      role: "read_projection",
      snapshot_age_ms: null,
      finalized_block_age_ms: null,
    };
  }
}
