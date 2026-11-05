import { object, positiveU64, boolean, check, accountId } from "../wire.js";
import { livingTownProductionJob } from "./production.js";
import {
  livingTownLedger,
  livingTownSnapshot,
  decodeLivingTownSnapshot,
} from "./wire.js";
import { livingTownGas } from "./calls.js";
import { verifyLivingTownReceiptCore } from "./receipts.js";
import type {
  LivingTownReceiptProof,
  LivingTownReceiptStatusOf,
} from "./receipts.js";
import type { FinalizedBlock } from "../market-client.js";
const args = object({ job_id: positiveU64 });
export function createLivingTownCompletionCall(value: unknown): Readonly<{
  method: "complete_production";
  args: ReturnType<typeof args>;
  gas: typeof livingTownGas;
  deposit: "0";
}> {
  return Object.freeze({
    method: "complete_production",
    args: Object.freeze(args(value)),
    gas: livingTownGas,
    deposit: "0",
  });
}
const none = (v: unknown): null => {
  check(v === null, "Rewardless completion has no command principal/digest");
  return null;
};
const outcome = object({
  kind: (v: unknown): "production_completed" => {
    check(v === "production_completed", "Completion outcome required");
    return v;
  },
  job: livingTownProductionJob,
  ledger: livingTownLedger,
});
const effect = object({
  principal: none,
  command_sequence: none,
  payload_sha256: none,
  replayed: boolean,
  effect_revision: positiveU64,
  effect_event_sequence: positiveU64,
  outcome,
});
export type LivingTownCompletionCall = ReturnType<
  typeof createLivingTownCompletionCall
>;
export function livingTownCompletionWalletRequest(
  contractId: string,
  signerId: string,
  input: LivingTownCompletionCall,
): {
  network: "testnet";
  signerId: string;
  receiverId: string;
  actions: {
    type: "FunctionCall";
    params: {
      methodName: "complete_production";
      args: LivingTownCompletionCall["args"];
      gas: typeof livingTownGas;
      deposit: "0";
    };
  }[];
} {
  const call = createLivingTownCompletionCall(input.args);
  return {
    network: "testnet" as const,
    signerId: accountId(signerId),
    receiverId: accountId(contractId),
    actions: [
      {
        type: "FunctionCall" as const,
        params: {
          methodName: call.method,
          args: call.args,
          gas: call.gas,
          deposit: call.deposit,
        },
      },
    ],
  };
}
export type LivingTownCompletionProof =
  LivingTownReceiptProof<LivingTownCompletionCall>;
export type LivingTownCompletionResult = ReturnType<
  ReturnType<typeof livingTownSnapshot<ReturnType<typeof effect>>>
>;
export type LivingTownCompletionStatus =
  LivingTownReceiptStatusOf<LivingTownCompletionResult>;
export async function verifyLivingTownCompletionEffect(
  value: unknown,
  deployment: unknown,
  _signer: string,
  call: LivingTownCompletionCall,
): Promise<LivingTownCompletionResult> {
  const result = decodeLivingTownSnapshot(value, deployment, effect),
    e = result.data,
    j = e.outcome.job;
  check(
    j.status === "completed" &&
      j.job_id === call.args.job_id &&
      j.completed_at_ns !== null &&
      BigInt(j.completed_at_ns) <= BigInt(result.block_timestamp_ns),
    "Completion job/time mismatch",
  );
  check(
    JSON.stringify(j.owner) === JSON.stringify(e.outcome.ledger.actor),
    "Completion ledger owner mismatch",
  );
  check(
    e.effect_revision === e.effect_event_sequence &&
      BigInt(e.effect_revision) <= BigInt(result.market_revision),
    "Completion effect revision mismatch",
  );
  if (!e.replayed)
    check(
      e.effect_revision === result.market_revision &&
        j.completed_at_ns === result.block_timestamp_ns,
      "Completion first effect mismatch",
    );
  return result;
}
export async function verifyLivingTownCompletionReceipt(
  value: unknown,
  proof: LivingTownCompletionProof,
  verifyBlock: (hash: string) => Promise<FinalizedBlock>,
): Promise<LivingTownCompletionStatus> {
  return verifyLivingTownReceiptCore(
    value,
    proof,
    verifyBlock,
    (method, raw) => {
      check(method === "complete_production", "Completion method required");
      return createLivingTownCompletionCall(raw);
    },
    verifyLivingTownCompletionEffect,
  );
}
