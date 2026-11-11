import type { FinalizedBlock } from "../market-client.js";
import {
  accountId,
  check,
  hash32,
  positiveU64,
  publicKey,
  record,
  rpcU64,
} from "../wire.js";
import {
  createLivingTownCall,
  decodeLivingTownBase64,
  verifyLivingTownEffect,
} from "./calls.js";
import type { LivingTownCall, LivingTownMethod } from "./calls.js";
import type { LivingTownDeployment } from "@bot-bazaar/shared";
import { canonicalLivingTownJson } from "./json.js";

export type LivingTownProof = LivingTownReceiptProof<LivingTownCall>;
export interface LivingTownReceiptProof<C> {
  readonly transactionHash: string;
  readonly signerId: string;
  readonly deployment: LivingTownDeployment;
  readonly call: C;
  readonly referenceBlockHeight: string;
  /** Explicit bounded runtime gas, when different from the legacy wallet default. */
  readonly gas?: string;
}
export type LivingTownReceiptStatus = LivingTownReceiptStatusOf<
  Awaited<ReturnType<typeof verifyLivingTownEffect>>
>;
export type LivingTownReceiptStatusOf<R> =
  | { kind: "unknown" | "pending"; transactionHash: string }
  | {
      kind: "failed";
      transactionHash: string;
      code: "EXECUTION_FAILED";
      executionReceiptId: string;
      block: FinalizedBlock;
    }
  | {
      kind: "succeeded";
      transactionHash: string;
      result: R;
      executionReceiptId: string;
      block: FinalizedBlock;
    };
function list(v: unknown, max = 128): unknown[] {
  check(Array.isArray(v) && v.length <= max, "invalid V2 receipt collection");
  return v;
}
export async function verifyLivingTownReceiptCore<
  C extends { method: string; args: unknown; gas: string },
  R extends { block_height: string; block_timestamp_ns: string },
>(
  value: unknown,
  proof: LivingTownReceiptProof<C>,
  verifyBlock: (hash: string) => Promise<FinalizedBlock>,
  normalize: (method: string, args: unknown) => C,
  verifyEffect: (
    value: unknown,
    deployment: unknown,
    signer: string,
    call: C,
  ) => Promise<R>,
): Promise<LivingTownReceiptStatusOf<R>> {
  const transactionHash = hash32(proof.transactionHash),
    signer = accountId(proof.signerId),
    call = normalize(proof.call.method, proof.call.args);
  positiveU64(proof.referenceBlockHeight);
  const expectedGas = proof.gas ?? call.gas;
  check(
    ["30000000000000", "100000000000000"].includes(expectedGas),
    "unreviewed V2 receipt gas",
  );
  const r = record(value),
    milestone = r["final_execution_status"];
  if (milestone === "NONE") return { kind: "unknown", transactionHash };
  check(
    [
      "INCLUDED",
      "EXECUTED_OPTIMISTIC",
      "INCLUDED_FINAL",
      "EXECUTED",
      "FINAL",
    ].includes(String(milestone)),
    "invalid V2 execution milestone",
  );
  const tx = record(r["transaction"]);
  check(
    tx["hash"] === transactionHash &&
      tx["signer_id"] === signer &&
      tx["receiver_id"] === proof.deployment.contract_id,
    "V2 transaction identity mismatch",
  );
  publicKey(tx["public_key"]);
  positiveU64(rpcU64(tx["nonce"]));
  const actions = list(tx["actions"], 1);
  check(actions.length === 1, "V2 expected one action");
  const a = record(actions[0]);
  check(
    Object.keys(a).join() === "FunctionCall",
    "V2 expected FunctionCall only",
  );
  const action = record(a["FunctionCall"]);
  check(
    action["method_name"] === call.method &&
      action["deposit"] === "0" &&
      rpcU64(action["gas"]) === expectedGas &&
      canonicalLivingTownJson(
        normalize(call.method, decodeLivingTownBase64(action["args"])).args,
      ) === canonicalLivingTownJson(call.args),
    "V2 signed terms mismatch",
  );
  if (milestone !== "FINAL") return { kind: "pending", transactionHash };
  const txOutcome = record(r["transaction_outcome"]);
  check(txOutcome["id"] === transactionHash, "V2 outcome identity mismatch");
  const root = record(txOutcome["outcome"]);
  check(root["executor_id"] === signer, "V2 root executor mismatch");
  const rows = new Map<string, Record<string, unknown>>();
  for (const v of list(r["receipts_outcome"])) {
    const row = record(v),
      id = hash32(row["id"]);
    check(!rows.has(id), "duplicate V2 receipt");
    rows.set(id, row);
  }
  const seen = new Set<string>(),
    queue = list(root["receipt_ids"]).map(hash32);
  while (queue.length) {
    const id = queue.shift()!;
    check(!seen.has(id), "cyclic V2 receipt graph");
    seen.add(id);
    const row = rows.get(id);
    check(row, "missing V2 receipt");
    queue.push(...list(record(row["outcome"])["receipt_ids"]).map(hash32));
  }
  check(seen.size === rows.size, "unrelated V2 receipt");
  const all = [
    root,
    ...[...rows.values()].map((row) => record(row["outcome"])),
  ];
  for (const o of all) {
    const s = record(o["status"]);
    check(
      Object.keys(s).length === 1 &&
        (Object.hasOwn(s, "SuccessValue") ||
          Object.hasOwn(s, "SuccessReceiptId") ||
          Object.hasOwn(s, "Failure")),
      "incomplete V2 receipt status",
    );
    if (Object.hasOwn(s, "SuccessReceiptId"))
      check(
        list(o["receipt_ids"]).includes(hash32(s["SuccessReceiptId"])),
        "unlinked V2 success receipt",
      );
  }
  const rootId = hash32(record(root["status"])["SuccessReceiptId"]);
  check(list(root["receipt_ids"]).includes(rootId), "V2 missing contract root");
  const executed = rows.get(rootId);
  check(
    executed &&
      record(executed["outcome"])["executor_id"] ===
        proof.deployment.contract_id,
    "V2 executing receipt mismatch",
  );
  const blockHash = hash32(executed["block_hash"]),
    block = await verifyBlock(blockHash);
  check(
    block.hash === blockHash &&
      BigInt(block.height) > BigInt(proof.referenceBlockHeight),
    "V2 receipt predates intent",
  );
  const final = record(r["status"]);
  check(Object.keys(final).length === 1, "invalid V2 final status");
  const failed = all.some((o) => Object.hasOwn(record(o["status"]), "Failure"));
  if (failed || Object.hasOwn(final, "Failure")) {
    check(failed && Object.hasOwn(final, "Failure"), "inconsistent V2 failure");
    return {
      kind: "failed",
      transactionHash,
      code: "EXECUTION_FAILED",
      executionReceiptId: rootId,
      block,
    };
  }
  const encoded = final["SuccessValue"];
  check(
    typeof encoded === "string" &&
      record(record(executed["outcome"])["status"])["SuccessValue"] === encoded,
    "V2 return provenance mismatch",
  );
  const result = await verifyEffect(
    decodeLivingTownBase64(encoded),
    proof.deployment,
    signer,
    call,
  );
  check(
    result.block_height === block.height &&
      result.block_timestamp_ns === block.timestampNs,
    "V2 execution block mismatch",
  );
  return {
    kind: "succeeded",
    transactionHash,
    result,
    executionReceiptId: rootId,
    block,
  };
}

export async function verifyLivingTownReceipt(
  value: unknown,
  proof: LivingTownProof,
  verifyBlock: (hash: string) => Promise<FinalizedBlock>,
): Promise<LivingTownReceiptStatus> {
  return verifyLivingTownReceiptCore(
    value,
    proof,
    verifyBlock,
    (method, args) => createLivingTownCall(method as LivingTownMethod, args),
    verifyLivingTownEffect,
  );
}
