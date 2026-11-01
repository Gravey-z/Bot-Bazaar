import { createHash } from "node:crypto";
import { parseDecision } from "../decisions/schema.js";
import type { DeploymentIdentity, MerchantId } from "@bot-bazaar/chain";

export class StorageError extends Error {
  constructor(message = "operation failed; processing must remain stopped") {
    super(`Worker storage: ${message}`);
    this.name = "StorageError";
  }
}
export function requireStorage(value: unknown, message: string): asserts value {
  if (!value) throw new StorageError(message);
}
export function id(value: string): string {
  requireStorage(
    typeof value === "string" && /^[a-zA-Z0-9:_.-]{1,128}$/.test(value),
    "invalid record identity",
  );
  return value;
}
export function label(value: string): string {
  requireStorage(
    typeof value === "string" &&
      /^[a-zA-Z0-9:/_.-]{1,128}$/.test(value) &&
      !/^(sk-|ed25519:)/i.test(value),
    "invalid metadata label",
  );
  return value;
}
export function merchant(value: MerchantId): MerchantId {
  requireStorage(["rex", "luna", "bolt"].includes(value), "invalid merchant");
  return value;
}
export function timestamp(value: number): number {
  requireStorage(
    Number.isSafeInteger(value) && value >= 0,
    "invalid timestamp",
  );
  return value;
}
export function digest(value: string): string {
  requireStorage(/^[a-f0-9]{64}$/.test(value), "invalid digest");
  return value;
}
export function json(value: unknown, maximum = 65536): string {
  const text = JSON.stringify(value);
  requireStorage(
    typeof text === "string" && Buffer.byteLength(text) <= maximum,
    "record exceeds storage bound",
  );
  return text;
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function identityJson(value: DeploymentIdentity): string {
  requireStorage(value.networkId === "testnet", "Testnet identity required");
  const account = (v: string) =>
    requireStorage(
      typeof v === "string" &&
        v.length <= 64 &&
        /^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.testnet$/.test(v),
      "invalid deployment account",
    );
  account(value.contractId);
  account(value.ownerId);
  requireStorage(
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.codeHash),
    "invalid code hash",
  );
  const controllers = {
    rex: value.controllers.rex,
    luna: value.controllers.luna,
    bolt: value.controllers.bolt,
  };
  Object.values(controllers).forEach(account);
  requireStorage(
    new Set(Object.values(controllers)).size === 3 &&
      Object.values(controllers).every(
        (v) => v !== value.contractId && v !== value.ownerId,
      ),
    "invalid controller mapping",
  );
  return json({
    networkId: value.networkId,
    contractId: value.contractId,
    ownerId: value.ownerId,
    codeHash: value.codeHash,
    controllers,
  });
}
export function sanitizedDecision(
  action: unknown,
  reason: string,
): { actionJson: string; reason: string } {
  const normalized = parseDecision({ action, reason });
  return {
    actionJson: json(normalized.action),
    reason: sanitizeBriefReason(reason),
  };
}
export function sanitizeBriefReason(reason: unknown): string {
  requireStorage(
    typeof reason === "string" &&
      reason.length > 0 &&
      reason.length <= 480 &&
      Array.from(reason).length <= 240,
    "invalid decision reason",
  );
  const clean = reason
    .replace(/\p{Cc}/gu, " ")
    .replace(
      /(?:Bearer\s+\S+|sk-[a-zA-Z0-9_-]+|ed25519:[1-9A-HJ-NP-Za-km-z]{32,})/gi,
      "[redacted]",
    );
  requireStorage(
    Array.from(clean).length <= 240,
    "sanitized reason exceeds decision bound",
  );
  return clean;
}
