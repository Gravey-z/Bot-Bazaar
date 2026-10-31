import { isAbsolute, join } from "node:path";
import { ConfigurationError } from "@bot-bazaar/shared";
import type { StoreOptions } from "./database.js";
import { identityJson } from "./validation.js";

export function parseStorageConfig(
  env: Readonly<Record<string, string | undefined>>,
  contractId: string,
): StoreOptions & { backupDir: string } {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value || /[<>]/.test(value))
      throw new ConfigurationError(
        `${name} is required; replace example placeholders`,
      );
    return value;
  };
  const dataDir = required("WORKER_DATA_DIR");
  const backupDir =
    env["WORKER_BACKUP_DIR"]?.trim() || join(dataDir, "backups");
  if (!isAbsolute(dataDir) || !isAbsolute(backupDir) || dataDir === backupDir)
    throw new ConfigurationError(
      "Worker data and backup directories must be distinct absolute paths",
    );
  const create = env["WORKER_INITIALIZE_DATABASE"] ?? "false";
  if (!["true", "false"].includes(create))
    throw new ConfigurationError(
      "WORKER_INITIALIZE_DATABASE must be true or false",
    );
  const identity = {
    networkId: "testnet" as const,
    contractId,
    ownerId: required("NEAR_OWNER_ID"),
    codeHash: required("NEAR_EXPECTED_CODE_HASH"),
    controllers: {
      rex: required("REX_CONTROLLER_ID"),
      luna: required("LUNA_CONTROLLER_ID"),
      bolt: required("BOLT_CONTROLLER_ID"),
    },
  };
  try {
    identityJson(identity);
  } catch {
    throw new ConfigurationError("Invalid database deployment identity");
  }
  const policyVersion = required("WORKER_POLICY_VERSION");
  if (!/^[a-zA-Z0-9:_.-]{1,128}$/.test(policyVersion))
    throw new ConfigurationError("Invalid WORKER_POLICY_VERSION");
  return {
    dataDir,
    backupDir,
    identity,
    policyVersion,
    create: create === "true",
  };
}
