export interface PublicConfig {
  readonly networkId: "testnet";
  readonly contractId: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly workerUrl: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(`Configuration: ${message}`);
    this.name = "ConfigurationError";
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || /[<>]/.test(value)) {
    throw new ConfigurationError(
      `${name} is required; replace example placeholders`,
    );
  }
  return value.trim();
}

function endpoint(value: unknown, name: string): URL {
  const text = requiredString(value, name);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ConfigurationError(
      `${name} requires HTTPS (HTTP only on loopback), without credentials, query or fragment`,
    );
  }
  return url;
}

export function parsePublicConfig(value: unknown): PublicConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("public settings must be an object");
  }
  const fields = [
    "networkId",
    "contractId",
    "rpcUrl",
    "explorerUrl",
    "workerUrl",
  ];
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new ConfigurationError(
      "public settings contain unexpected fields; only public settings are allowed",
    );
  }
  const input = value as Record<string, unknown>;
  if (
    requiredString(input["networkId"], "networkId / NEAR_NETWORK_ID") !==
    "testnet"
  ) {
    throw new ConfigurationError(
      "networkId / NEAR_NETWORK_ID must be testnet; mainnet is disabled in the MVP",
    );
  }
  const contractId = requiredString(
    input["contractId"],
    "contractId / NEAR_CONTRACT_ID",
  );
  if (
    contractId.length > 64 ||
    !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(contractId)
  ) {
    throw new ConfigurationError(
      "contractId / NEAR_CONTRACT_ID must be a valid named .testnet account (maximum 64 characters)",
    );
  }
  const rpc = endpoint(input["rpcUrl"], "rpcUrl / NEAR_RPC_URL");
  if (
    ![
      "https://test.rpc.fastnear.com/",
      "https://archival-rpc.testnet.near.org/",
    ].includes(rpc.href)
  ) {
    throw new ConfigurationError(
      "rpcUrl / NEAR_RPC_URL must use an approved public Testnet endpoint",
    );
  }
  const explorer = endpoint(
    input["explorerUrl"],
    "explorerUrl / NEAR_EXPLORER_URL",
  );
  if (explorer.href !== "https://testnet.nearblocks.io/") {
    throw new ConfigurationError(
      "explorerUrl / NEAR_EXPLORER_URL must be https://testnet.nearblocks.io",
    );
  }
  const worker = endpoint(input["workerUrl"], "workerUrl / WORKER_URL");
  if (worker.pathname !== "/") {
    throw new ConfigurationError(
      "workerUrl / WORKER_URL must be an origin without a path",
    );
  }
  return Object.freeze({
    networkId: "testnet",
    contractId,
    rpcUrl: rpc.href,
    explorerUrl: explorer.href,
    workerUrl: worker.href,
  });
}
