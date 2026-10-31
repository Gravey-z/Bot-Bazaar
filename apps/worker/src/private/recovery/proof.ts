import { createHash } from "node:crypto";
import { SignedTransaction, baseEncode } from "near-api-js";
import { createMarketCall, parseU64 } from "@bot-bazaar/chain";
import type { DeploymentIdentity } from "@bot-bazaar/chain";
import type { PreparedMerchantCall } from "../chain-adapter.js";
import { json, requireStorage } from "../storage/validation.js";

// Public historical keys may have been rotated; recovery does not load a secret
// or require the old key to remain the configured runtime signing key.
export function readPrepared(
  value: string,
  identity: DeploymentIdentity,
): PreparedMerchantCall {
  requireStorage(
    Buffer.byteLength(value) <= 65536,
    "oversized persisted transaction",
  );
  const row = JSON.parse(value) as PreparedMerchantCall;
  requireStorage(
    [
      "set_listing",
      "propose_trade",
      "accept_trade",
      "cancel_trade",
      "expire_offers",
    ].includes(row.method) &&
      typeof row.publicKey === "string" &&
      row.publicKey.startsWith("ed25519:"),
    "invalid persisted merchant method or key",
  );
  const args = createMarketCall(row.method, row.args).args;
  const signed = SignedTransaction.decode(
    Buffer.from(row.signedTransactionBase64, "base64"),
  );
  const tx = signed.transaction,
    call = tx.actions[0]?.functionCall;
  requireStorage(
    ["rex", "luna", "bolt"].includes(row.merchantId) &&
      row.contractId === identity.contractId &&
      tx.receiverId === identity.contractId &&
      row.signerId === identity.controllers[row.merchantId] &&
      tx.signerId === row.signerId &&
      tx.publicKey.toString() === row.publicKey &&
      tx.nonce.toString() === parseU64(row.nonce) &&
      baseEncode(createHash("sha256").update(tx.encode()).digest()) ===
        row.transactionHash,
    "persisted transaction identity mismatch",
  );
  requireStorage(
    tx.actions.length === 1 &&
      call?.methodName === row.method &&
      call.deposit === 0n &&
      call.gas.toString() === parseU64(row.gas) &&
      call.gas > 0n &&
      call.gas <= 300000000000000n &&
      json(
        createMarketCall(
          row.method,
          JSON.parse(Buffer.from(call.args).toString("utf8")),
        ).args,
      ) === json(args),
    "persisted transaction arguments mismatch",
  );
  return { ...row, args };
}
