import { ConfigurationError, parsePublicConfig } from "@bot-bazaar/shared";
import type { PublicConfig } from "@bot-bazaar/shared";
import { parseStorageConfig } from "./storage/config.js";
import { parseBoundaryConfig } from "./read-api/config.js";

type ProviderConfig =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "openai";
      readonly model: "gpt-6-luna";
      readonly apiKey: string;
    };

export interface WorkerConfig {
  readonly public: PublicConfig;
  readonly host: string;
  readonly port: number;
  readonly provider: ProviderConfig;
  readonly storage: ReturnType<typeof parseStorageConfig>;
  readonly discoveryEnabled: boolean;
  readonly boundary: ReturnType<typeof parseBoundaryConfig>;
}

function required(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value || /[<>]/.test(value)) {
    throw new ConfigurationError(
      `${name} is required; replace example placeholders`,
    );
  }
  return value;
}

export function parseWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkerConfig {
  const publicConfig = parsePublicConfig({
    networkId: env["NEAR_NETWORK_ID"],
    contractId: env["NEAR_CONTRACT_ID"],
    rpcUrl: env["NEAR_RPC_URL"],
    explorerUrl: env["NEAR_EXPLORER_URL"],
    workerUrl: env["WORKER_URL"],
  });
  const host = required(env, "HOST");
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host)) {
    throw new ConfigurationError(
      "HOST must be 127.0.0.1, localhost, ::1 or 0.0.0.0",
    );
  }
  const port = required(env, "PORT");
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new ConfigurationError("PORT must be an integer from 1 to 65535");
  }
  const kind = required(env, "MODEL_PROVIDER");
  let provider: ProviderConfig;
  if (kind === "disabled") {
    provider = { kind };
  } else if (kind === "openai") {
    if (required(env, "MODEL_ID") !== "gpt-6-luna") {
      throw new ConfigurationError(
        "MODEL_ID must be the approved gpt-6-luna model; review policy before changing it",
      );
    }
    provider = {
      kind,
      model: "gpt-6-luna",
      apiKey: required(env, "OPENAI_API_KEY"),
    };
  } else {
    throw new ConfigurationError("MODEL_PROVIDER must be disabled or openai");
  }
  const discovery = env["WORKER_DISCOVERY_ENABLED"] ?? "true";
  if (!["true", "false"].includes(discovery))
    throw new ConfigurationError(
      "WORKER_DISCOVERY_ENABLED must be true or false",
    );
  return Object.freeze({
    public: publicConfig,
    host,
    port: Number(port),
    provider: Object.freeze(provider),
    storage: Object.freeze(parseStorageConfig(env, publicConfig.contractId)),
    discoveryEnabled: discovery === "true",
    boundary: parseBoundaryConfig(env),
  });
}
