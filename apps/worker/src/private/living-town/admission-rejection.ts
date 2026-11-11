import type { FinalizedLivingTownReader } from "@bot-bazaar/chain";
import type { PreparedTownCall } from "./town-chain.js";
import { requireStorage } from "../storage/validation.js";

const verified = new WeakSet<object>();
export interface ExpiredAdmissionRejection {
  kind: "expired_admission_rejection";
  transactionHash: string;
  reason: "NotEnoughAllowance";
  checkpoint: { hash: string; height: string; timestampNs: string };
}
/** Explicit operator reconciliation, never a timeout/unknown-is-failure rule.
 * Requires the captured original RPC rejection, an expired command, unchanged key nonce/allowance,
 * and finalized command non-application. No replacement signature or automatic retry is involved.
 */
export async function verifyExpiredAllowanceRejection(
  original: PreparedTownCall,
  evidence: unknown,
  reader: FinalizedLivingTownReader,
  lane: "rex" | "luna" | "bolt" | "operator",
): Promise<ExpiredAdmissionRejection> {
  const e = evidence as {
    transactionHash?: string;
    error?: {
      cause?: { name?: string };
      data?: {
        TxExecutionError?: {
          InvalidTxError?: {
            InvalidAccessKeyError?: {
              NotEnoughAllowance?: {
                account_id?: string;
                public_key?: string;
                allowance?: string;
                cost?: string;
              };
            };
          };
        };
      };
    };
  };
  const error =
    e?.error?.data?.TxExecutionError?.InvalidTxError?.InvalidAccessKeyError
      ?.NotEnoughAllowance;
  requireStorage(
    e?.transactionHash === original.transactionHash &&
      e.error?.cause?.name === "INVALID_TRANSACTION" &&
      error &&
      error.account_id === original.signerId &&
      error.public_key === original.publicKey &&
      typeof error.cost === "string" &&
      /^[1-9][0-9]{0,38}$/.test(error.cost) &&
      typeof error.allowance === "string" &&
      /^(0|[1-9][0-9]{0,38})$/.test(error.allowance) &&
      BigInt(error.cost) > BigInt(error.allowance),
    "original explicit allowance-rejection evidence required",
  );
  requireStorage(
    "command" in original.call.args &&
      BigInt(original.call.args.command.valid_until_ns) <=
        BigInt(reader.block.timestampNs),
    "only expired rejected commands may be retired",
  );
  const key = await reader.getAccessKey(original.signerId, original.publicKey);
  const permission = key.permission as {
    FunctionCall?: { allowance?: string; receiver_id?: string };
  };
  requireStorage(
    BigInt(key.nonce) + 1n === BigInt(original.nonce) &&
      permission.FunctionCall?.allowance === error.allowance &&
      permission.FunctionCall.receiver_id === original.deployment.contract_id,
    "rejected key nonce/allowance changed; retain original unknown",
  );
  const command = await reader.getCommand(
    lane === "operator" ? original.signerId : `merchant:${lane}`,
    original.call.args.command.sequence,
  );
  requireStorage(
    command.data.kind === "not_applied" &&
      command.data.next_sequence === original.call.args.command.sequence,
    "original command may have applied; retain original unknown",
  );
  const result: ExpiredAdmissionRejection = {
    kind: "expired_admission_rejection",
    transactionHash: original.transactionHash,
    reason: "NotEnoughAllowance",
    checkpoint: reader.block,
  };
  verified.add(result);
  return Object.freeze(result);
}
export const isVerifiedAdmissionRejection = (
  value: ExpiredAdmissionRejection,
): boolean => verified.has(value);
