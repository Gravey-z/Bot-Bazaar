import { isAbsolute, resolve } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  parseLivingTownIdentity,
  parseLivingTownJson,
  parseU64,
} from "@bot-bazaar/chain";
import type {
  LivingTownIdentity,
  LivingTownMethod,
  LivingTownProof,
  LivingTownCompletionProof,
} from "@bot-bazaar/chain";
import { parsePublicConfig } from "@bot-bazaar/shared";
import type { PublicConfig } from "@bot-bazaar/shared";
import { parseBoundaryConfig } from "../read-api/config.js";
import type { BoundaryConfig } from "../read-api/config.js";
const exact = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== keys.sort().join()
  )
    throw new Error("invalid V2 read-worker config");
  return v as Record<string, unknown>;
};
export function readBoundedFile(path: string, max: number): unknown {
  if (!isAbsolute(path)) throw new Error("absolute input path required");
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max)
    throw new Error("invalid bounded public input file");
  const bytes = readFileSync(path);
  if (bytes.length > max) throw new Error("input file grew beyond limit");
  return parseLivingTownJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
}
export interface LivingTownWorkerConfig {
  identity: LivingTownIdentity;
  public: PublicConfig;
  dataDir: string;
  inbox: string | null;
  port: number;
  pollMs: number;
  boundary: BoundaryConfig;
}
export function parseLivingTownWorkerConfig(
  value: unknown,
): LivingTownWorkerConfig {
  const r = exact(value, [
      "schema",
      "identity",
      "public",
      "data_dir",
      "receipt_inbox",
      "port",
      "poll_ms",
      "allowed_origins",
    ]),
    identity = parseLivingTownIdentity(r["identity"]),
    pub = parsePublicConfig(r["public"]);
  if (
    r["schema"] !== "bot-bazaar-living-town-reader-v1" ||
    pub.contractId !== identity.deployment.contract_id ||
    pub.networkId !== identity.deployment.network_id ||
    typeof r["data_dir"] !== "string" ||
    !isAbsolute(r["data_dir"]) ||
    (r["receipt_inbox"] !== null &&
      (typeof r["receipt_inbox"] !== "string" ||
        !isAbsolute(r["receipt_inbox"])))
  )
    throw new Error("V2 read-worker identity/path mismatch");
  const port = Number(parseU64(r["port"])),
    pollMs = Number(parseU64(r["poll_ms"]));
  if (
    port < 1024 ||
    port > 65535 ||
    pollMs < 1000 ||
    pollMs > 60000 ||
    !Array.isArray(r["allowed_origins"]) ||
    r["allowed_origins"].length > 16 ||
    r["allowed_origins"].some((v) => typeof v !== "string" || v.includes(","))
  )
    throw new Error("V2 read-worker bounds mismatch");
  return {
    identity,
    public: pub,
    dataDir: resolve(r["data_dir"]),
    inbox: r["receipt_inbox"] as string | null,
    port,
    pollMs,
    boundary: parseBoundaryConfig({
      WORKER_ALLOWED_ORIGINS: r["allowed_origins"].join(","),
    }),
  };
}
export function readReceiptInbox(
  path: string,
  identity: LivingTownIdentity,
): (LivingTownProof | LivingTownCompletionProof)[] {
  const value = exact(readBoundedFile(path, 262144), ["schema", "requests"]);
  if (
    value["schema"] !== "living-town-receipt-inbox-v1" ||
    !Array.isArray(value["requests"]) ||
    value["requests"].length > 100
  )
    throw new Error("invalid bounded receipt inbox");
  return value["requests"].map((v) => {
    const r = exact(v, [
      "transaction_hash",
      "signer_id",
      "method",
      "args",
      "reference_block_height",
    ]);
    if (
      typeof r["transaction_hash"] !== "string" ||
      typeof r["signer_id"] !== "string"
    )
      throw new Error("invalid receipt identity");
    const base = {
      transactionHash: r["transaction_hash"],
      signerId: r["signer_id"],
      deployment: identity.deployment,
      referenceBlockHeight: parseU64(r["reference_block_height"]),
    };
    return r["method"] === "complete_production"
      ? { ...base, call: createLivingTownCompletionCall(r["args"]) }
      : {
          ...base,
          call: createLivingTownCall(
            r["method"] as LivingTownMethod,
            r["args"],
          ),
        };
  });
}
