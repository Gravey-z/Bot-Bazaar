import { isAbsolute, resolve, relative } from "node:path";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { KeyPairSigner } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { parseLivingTownIdentity, parseU64 } from "@bot-bazaar/chain";
import { parsePublicConfig } from "@bot-bazaar/shared";
import type { MerchantCredential } from "../chain-adapter.js";
import { requireStorage } from "../storage/validation.js";

const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  requireStorage(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === [...keys].sort().join(),
    "invalid runtime configuration fields",
  );
  return value as Record<string, unknown>;
};
const absolute = (value: unknown): string => {
  requireStorage(
    typeof value === "string" && isAbsolute(value),
    "absolute runtime path required",
  );
  return resolve(value);
};
export function parseTownRuntimeConfig(value: unknown): {
  identity: ReturnType<typeof parseLivingTownIdentity>;
  public: ReturnType<typeof parsePublicConfig>;
  executionDir: string;
  witnessDir: string;
  outboxDir: string;
  activityFile: string;
  controlFile: string;
  seed: string;
  pollMs: number;
  cadenceMs: number;
  provider:
    | { kind: "disabled" }
    | {
        kind: "near-ai";
        keyFile: string;
        budgetDir: string;
        budgetWitnessDir: string;
      };
  keys: Record<
    "rex" | "luna" | "bolt" | "operator" | "customer",
    { publicKey: string; path: string }
  >;
} {
  const r = exact(value, [
    "schema",
    "identity",
    "public",
    "execution_dir",
    "witness_dir",
    "receipt_outbox",
    "agent_activity_inbox",
    "control_file",
    "seed",
    "poll_ms",
    "cadence_ms",
    "keys",
    "provider",
  ]);
  requireStorage(
    r["schema"] === "bot-bazaar-living-town-runtime-v1",
    "invalid runtime schema",
  );
  const ai =
    r["provider"] === "disabled"
      ? null
      : exact(r["provider"], [
          "kind",
          "key_file",
          "budget_dir",
          "budget_witness_dir",
        ]);
  requireStorage(
    !ai || ai["kind"] === "near-ai",
    "unsupported runtime provider",
  );
  const provider = ai
    ? {
        kind: "near-ai" as const,
        keyFile: absolute(ai["key_file"]),
        budgetDir: absolute(ai["budget_dir"]),
        budgetWitnessDir: absolute(ai["budget_witness_dir"]),
      }
    : { kind: "disabled" as const };
  const identity = parseLivingTownIdentity(r["identity"]),
    pub = parsePublicConfig(r["public"]);
  requireStorage(
    identity.deployment.contract_id === pub.contractId &&
      identity.deployment.network_id === pub.networkId,
    "runtime public/deployment mismatch",
  );
  const executionDir = absolute(r["execution_dir"]),
    witnessDir = absolute(r["witness_dir"]),
    outboxDir = absolute(r["receipt_outbox"]),
    activityFile = absolute(r["agent_activity_inbox"]),
    controlFile = absolute(r["control_file"]);
  const dirs = [
    executionDir,
    witnessDir,
    outboxDir,
    ...(provider.kind === "near-ai"
      ? [provider.budgetDir, provider.budgetWitnessDir]
      : []),
  ];
  const contains = (a: string, b: string) => {
    const rel = relative(a, b);
    return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  requireStorage(
    dirs.every((a, i) =>
      dirs.every((b, j) => i === j || (!contains(a, b) && !contains(b, a))),
    ),
    "execution, witness and public outbox must be separate directories",
  );
  if (provider.kind === "near-ai")
    requireStorage(
      !dirs.some((dir) => contains(dir, provider.keyFile)) &&
        provider.keyFile !== controlFile &&
        provider.keyFile !== activityFile,
      "AI credential must be outside state and public paths",
    );
  requireStorage(
    !dirs.some(
      (dir) => contains(dir, activityFile) || contains(dir, controlFile),
    ) && activityFile !== controlFile,
    "control/activity paths must be distinct from runtime directories",
  );
  const keys = exact(r["keys"], [
    "rex",
    "luna",
    "bolt",
    "operator",
    "customer",
  ]);
  const parsedKeys = {} as Record<
    keyof typeof resultKeys,
    { publicKey: string; path: string }
  >;
  const resultKeys = {
    rex: true,
    luna: true,
    bolt: true,
    operator: true,
    customer: true,
  };
  for (const lane of Object.keys(resultKeys) as (keyof typeof resultKeys)[]) {
    const k = exact(keys[lane], ["public_key", "file"]);
    requireStorage(
      typeof k["public_key"] === "string" &&
        /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(k["public_key"]),
      "ed25519 runtime public key required",
    );
    const path = absolute(k["file"]);
    requireStorage(
      !dirs.some((dir) => contains(dir, path)),
      "keys must not be stored in execution/witness/public-outbox directories",
    );
    parsedKeys[lane] = { publicKey: k["public_key"], path };
  }
  requireStorage(
    new Set(Object.values(parsedKeys).map((k) => k.publicKey)).size === 5,
    "runtime lanes require separate restricted keys",
  );
  const pollMs = Number(parseU64(r["poll_ms"])),
    cadenceMs = Number(parseU64(r["cadence_ms"]));
  requireStorage(
    pollMs >= 1000 &&
      pollMs <= 60000 &&
      cadenceMs >= 30000 &&
      cadenceMs <= 60000,
    "bounded runtime polling/cadence required",
  );
  return {
    identity,
    public: pub,
    executionDir,
    witnessDir,
    outboxDir,
    activityFile,
    controlFile,
    seed: parseU64(r["seed"]),
    pollMs,
    cadenceMs,
    provider,
    keys: parsedKeys,
  };
}

export function restrictedFileCredential(
  input: { publicKey: string; path: string },
  account: string,
): MerchantCredential {
  const originalPath = realpathSync(input.path);
  return {
    publicKey: input.publicKey,
    loadSecretKey: async () => {
      const stat = lstatSync(input.path);
      requireStorage(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size <= 4096 &&
          realpathSync(input.path) === originalPath,
        "runtime credential file changed",
      );
      const value = JSON.parse(readFileSync(input.path, "utf8")) as Record<
        string,
        unknown
      >;
      requireStorage(
        value["account_id"] === account &&
          value["public_key"] === input.publicKey &&
          typeof value["private_key"] === "string",
        "runtime credential identity mismatch",
      );
      const key = KeyPairSigner.fromSecretKey(
        value["private_key"] as KeyPairString,
      );
      requireStorage(
        (await key.getPublicKey()).toString() === input.publicKey,
        "runtime credential public key mismatch",
      );
      return value["private_key"] as KeyPairString;
    },
  };
}
