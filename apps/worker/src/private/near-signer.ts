import { baseDecode, KeyPairSigner, Transaction } from "near-api-js";
import type {
  AccessKeyView,
  KeyPairString,
  SignedTransaction,
} from "near-api-js";

export const runtimeMethods = [
  "set_listing",
  "propose_trade",
  "accept_trade",
  "cancel_trade",
  "expire_offers",
] as const;

export const townMerchantMethods = [
  "set_listing",
  "start_production",
  "complete_production",
] as const;
export const townSourceMethods = [
  "allocate_raw_supply",
  "sweep_merchant_treasury",
] as const;
type RuntimeScope = "merchant" | "customer" | "town_merchant" | "town_source";
function methods(scope: RuntimeScope = "merchant"): readonly string[] {
  return scope === "town_merchant"
    ? townMerchantMethods
    : scope === "town_source"
      ? townSourceMethods
      : scope === "customer"
        ? customerRuntimeMethods
        : runtimeMethods;
}
export const maximumRuntimeAllowance = 100_000_000_000_000_000_000_000n;
export const customerRuntimeMethods = [
  "fund_customer_budget",
  "settle_customer_purchase",
] as const;

export function assertRuntimePermission(
  permission: unknown,
  contractId: string,
  scope: RuntimeScope = "merchant",
): void {
  const permitted = methods(scope);
  if (
    !permission ||
    typeof permission !== "object" ||
    !("FunctionCall" in permission)
  ) {
    throw new Error(
      "Merchant runtime keys must have FunctionCall permission; full access is forbidden",
    );
  }
  const call = permission.FunctionCall;
  if (
    !call ||
    typeof call !== "object" ||
    !("receiver_id" in call) ||
    call.receiver_id !== contractId
  ) {
    throw new Error(
      "Runtime key receiver must match the configured market contract",
    );
  }
  if (
    !("allowance" in call) ||
    typeof call.allowance !== "string" ||
    call.allowance.length > maximumRuntimeAllowance.toString().length ||
    !/^[1-9][0-9]*$/.test(call.allowance) ||
    BigInt(call.allowance) > maximumRuntimeAllowance
  ) {
    throw new Error(
      "Runtime key allowance must be positive, finite and at most 0.1 NEAR",
    );
  }
  if (
    !("method_names" in call) ||
    !Array.isArray(call.method_names) ||
    call.method_names.length !== permitted.length ||
    new Set(call.method_names).size !== permitted.length ||
    !call.method_names.every((method: unknown) =>
      permitted.some((allowed) => allowed === method),
    )
  ) {
    throw new Error(
      scope === "town_source" || scope === "town_merchant"
        ? "Runtime key must allow exactly the selected V2 runtime methods"
        : scope === "customer"
          ? "Runtime key must allow exactly the two customer runtime methods"
          : "Runtime key must allow exactly the five merchant runtime methods",
    );
  }
}

interface RestrictedSigningInput {
  scope?: RuntimeScope;
  networkId: "testnet";
  controllerId: string;
  contractId: string;
  secretKey: KeyPairString;
  accessKey: AccessKeyView;
  transaction: Transaction;
}

interface SignedMerchantTransaction {
  txHash: Uint8Array;
  signedTransaction: SignedTransaction;
}

export async function signRestrictedTransaction(
  input: RestrictedSigningInput,
): Promise<SignedMerchantTransaction> {
  const { networkId, controllerId, contractId, secretKey, accessKey } = input;
  if (networkId !== "testnet")
    throw new Error("Merchant signing is restricted to Testnet");
  if (!controllerId || !contractId)
    throw new Error("Controller and contract IDs are required");
  assertRuntimePermission(accessKey.permission, contractId, input.scope);

  const transaction = Transaction.decode(input.transaction.encode());
  if (
    transaction.signerId !== controllerId ||
    transaction.receiverId !== contractId
  ) {
    throw new Error(
      "Transaction controller or receiver does not match configuration",
    );
  }
  if (
    transaction.nonce !== accessKey.nonce + 1n ||
    !Buffer.from(transaction.blockHash).equals(
      Buffer.from(baseDecode(accessKey.block_hash)),
    )
  ) {
    throw new Error(
      "Transaction nonce/block hash must match the supplied access-key snapshot",
    );
  }
  const action = transaction.actions[0];
  if (transaction.actions.length !== 1 || !action?.functionCall) {
    throw new Error(
      "Merchant runtime transactions must contain one function call only",
    );
  }
  const call = action.functionCall;
  const permitted = methods(input.scope);
  if (!permitted.some((method) => method === call.methodName)) {
    throw new Error("Method is outside the merchant runtime allowlist");
  }
  if (call.deposit !== 0n)
    throw new Error("Merchant calls must attach zero NEAR deposit");
  if (call.gas <= 0n || call.gas > 300_000_000_000_000n) {
    throw new Error("Merchant call gas must be positive and at most 300 Tgas");
  }

  const signer = KeyPairSigner.fromSecretKey(secretKey);
  if (
    (await signer.getPublicKey()).toString() !==
    transaction.publicKey.toString()
  ) {
    throw new Error(
      "Transaction public key does not match the selected runtime key",
    );
  }
  return signer.signTransaction(transaction);
}
