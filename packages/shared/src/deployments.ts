import { ConfigurationError, parsePublicConfig } from "./config.js";
import type { PublicConfig } from "./config.js";

export interface WebDeployment {
  readonly schema: "bot-bazaar-web-deployment-v1";
  readonly mode: "public" | "rehearsal";
  readonly current: PublicConfig;
  readonly retained: readonly PublicConfig[];
  readonly announcement: string | null;
}
export function deploymentIdentity(
  config: Pick<PublicConfig, "networkId" | "contractId">,
): string {
  return `${config.networkId}:${config.contractId}`;
}
export function parseWebDeployment(value: unknown): WebDeployment {
  const row = value as Record<string, unknown>;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join() !==
      "announcement,current,mode,retained,schema" ||
    row["schema"] !== "bot-bazaar-web-deployment-v1" ||
    typeof row["mode"] !== "string" ||
    !["public", "rehearsal"].includes(row["mode"]) ||
    !Array.isArray(row["retained"]) ||
    row["retained"].length > 16 ||
    !(
      row["announcement"] === null ||
      (typeof row["announcement"] === "string" &&
        Array.from(row["announcement"]).length <= 240)
    )
  )
    throw new ConfigurationError("invalid web deployment descriptor");
  const current = parsePublicConfig(row["current"]);
  const retained = row["retained"].map(parsePublicConfig);
  if (
    new Set([current, ...retained].map(deploymentIdentity)).size !==
      retained.length + 1 ||
    (row["mode"] === "rehearsal" && retained.length)
  )
    throw new ConfigurationError(
      "deployment history must have distinct identities and separate rehearsal scope",
    );
  return Object.freeze({
    schema: "bot-bazaar-web-deployment-v1",
    mode: row["mode"] as "public" | "rehearsal",
    current,
    retained: Object.freeze(retained),
    announcement: row["announcement"] as string | null,
  });
}
