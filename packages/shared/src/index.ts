export const merchantNames = {
  rex: "Rex",
  luna: "Luna",
  bolt: "Bolt",
} as const;

export type MerchantId = keyof typeof merchantNames;

export const resourceIds = ["crystal", "wood", "herb", "iron"] as const;

export type Resource = (typeof resourceIds)[number];

export { ConfigurationError, parsePublicConfig } from "./config.js";
export { parseWebDeployment, deploymentIdentity } from "./deployments.js";
export type { WebDeployment } from "./deployments.js";
export type { PublicConfig } from "./config.js";
export type {
  ActivitySource,
  ActivityStatus,
  PublicDeployment,
  PublicChainObservation,
  PublicSelection,
  PublicTrade,
  PublicListing,
  PublicTransaction,
  PublicActivityEntry,
  ActivityPage,
  PublicAiStatus,
  PublicAiAvailability,
  PublicHealth,
} from "./activity.js";
