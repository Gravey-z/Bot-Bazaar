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
    };
  }
}
