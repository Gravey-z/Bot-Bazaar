import type { MerchantId } from "@bot-bazaar/shared";
import { createMarketCall, decodeCallResult } from "./calls.js";
import type { CallMethod, CallResult } from "./calls.js";
import { merchantActionDigest } from "./merchant-action.js";
import type { MerchantAction } from "./merchant-action.js";
import { decodeBase64Json } from "./rpc.js";
import { check, hash32, record, rpcU64 } from "./wire.js";

export interface CallProof<M extends CallMethod = CallMethod> {
  readonly transactionHash: string;
  readonly signerId: string;
  readonly publicKey: string;
  readonly contractId: string;
  readonly nonce: string;
  readonly gas: string;
  readonly method: M;
  readonly args: unknown;
  readonly merchantId?: MerchantId;
}
export type ReceiptStatus<M extends CallMethod = CallMethod> =
  | { kind: "unknown"; transactionHash: string }
  | { kind: "pending"; transactionHash: string }
  | { kind: "failed"; transactionHash: string; code: string }
  | { kind: "succeeded"; transactionHash: string; result: CallResult<M> };

function list(value: unknown, maximum = 128): unknown[] {
  check(
    Array.isArray(value) && value.length <= maximum,
    "invalid receipt collection",
  );
  return value;
}
function successful(status: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(status, "SuccessValue") ||
    Object.hasOwn(status, "SuccessReceiptId")
  );
}

async function verifyResult<M extends CallMethod>(
  proof: CallProof<M>,
  result: CallResult<M>,
): Promise<void> {
  const args = record(proof.args),
    data = record(result.data);
  if (proof.method === "register_player")
    check(
      data["account_id"] === proof.signerId && data["gold"] === "100",
      "registration result identity mismatch",
    );
  if (proof.method === "buy_from_merchant") {
    const buyer = record(data["buyer"]),
      seller = record(data["seller"]);
    check(
      data["kind"] === "player_purchase" &&
        buyer["kind"] === "player" &&
        buyer["account_id"] === proof.signerId &&
        seller["kind"] === "merchant" &&
        seller["merchant_id"] === args["merchant_id"],
      "purchase actor mismatch",
    );
    check(
      data["resource"] === args["resource"] &&
        data["quantity"] === args["quantity"] &&
        data["offer_id"] === null &&
        BigInt(String(data["total_price"])) <=
          BigInt(String(args["max_total_price"])),
      "purchase terms mismatch",
    );
    check(
      data["market_revision"] === result.market_revision,
      "trade revision mismatch",
    );
  }
  if (
    ["set_listing", "propose_trade", "accept_trade", "cancel_trade"].includes(
      proof.method,
    )
  ) {
    const action = record(data["action"]);
    check(
      action["action_id"] === args["action_id"] &&
        action["method"] === proof.method &&
        action["market_revision"] === result.market_revision,
      "action receipt mismatch",
    );
    const digest = await merchantActionDigest({
      method: proof.method,
      args: proof.args,
    } as MerchantAction);
    check(action["args_sha256"] === digest, "action digest mismatch");
    if (proof.method === "set_listing") {
      const listing = record(data["listing"]);
      check(
        proof.merchantId === args["merchant_id"] &&
          listing["merchant_id"] === proof.merchantId &&
          listing["resource"] === args["resource"] &&
          listing["unit_price"] === args["unit_price"] &&
          listing["quantity"] === args["quantity"] &&
          listing["active"] === args["active"] &&
          BigInt(String(listing["version"])) ===
            BigInt(String(args["expected_version"])) + 1n &&
          action["listing_version"] === listing["version"],
        "listing result mismatch",
      );
    } else {
      const offer = record(data["offer"]);
      check(action["offer_id"] === offer["offer_id"], "offer action mismatch");
      if (proof.method === "propose_trade") {
        check(
          offer["status"] === "pending" &&
            offer["proposer"] === proof.merchantId,
          "proposal actor/status mismatch",
        );
        for (const key of [
          "proposer",
          "buyer",
          "seller",
          "resource",
          "quantity",
          "total_price",
          "expires_at_ns",
        ])
          check(offer[key] === args[key], "proposal terms mismatch");
      } else {
        check(offer["offer_id"] === args["offer_id"], "offer ID mismatch");
        if (proof.method === "cancel_trade")
          check(
            offer["status"] === "cancelled" &&
              offer["proposer"] === proof.merchantId,
            "cancellation role/status mismatch",
          );
        else {
          const trade = record(data["trade"]);
          check(
            offer["status"] === "accepted" &&
              offer["counterparty"] === proof.merchantId &&
              offer["settled_trade_id"] === trade["trade_id"] &&
              action["trade_id"] === trade["trade_id"] &&
              trade["offer_id"] === offer["offer_id"] &&
              trade["market_revision"] === result.market_revision &&
              trade["kind"] === "merchant_trade",
            "settlement identity mismatch",
          );
          check(
            record(trade["buyer"])["kind"] === "merchant" &&
              record(trade["buyer"])["merchant_id"] === offer["buyer"] &&
              record(trade["seller"])["kind"] === "merchant" &&
              record(trade["seller"])["merchant_id"] === offer["seller"],
            "settlement actors mismatch",
          );
          for (const key of [
            "resource",
            "quantity",
            "unit_price",
            "total_price",
          ])
            check(trade[key] === offer[key], "settlement terms mismatch");
        }
      }
    }
  }
  if (proof.method === "expire_offers") {
    const ids = [
      ...list(data["expired_offer_ids"], 24),
      ...list(data["ignored_offer_ids"], 24),
    ];
    check(
      new Set(ids).size === ids.length &&
        JSON.stringify([...ids].sort()) ===
          JSON.stringify([...list(args["offer_ids"], 24)].sort()),
      "cleanup result partition mismatch",
    );
  }
  if (proof.method === "pause_market" || proof.method === "resume_market")
    check(
      data["paused"] === (proof.method === "pause_market"),
      "pause result mismatch",
    );
}

// A valid final receipt proves this particular signed call. Logs alone are
// deliberately unused; an event from a rolled-back receipt cannot confirm it.
export async function verifyFinalReceipt<M extends CallMethod>(
  value: unknown,
  proof: CallProof<M>,
): Promise<ReceiptStatus<M>> {
  hash32(proof.transactionHash);
  createMarketCall(proof.method, proof.args);
  const response = record(value),
    transactionHash = proof.transactionHash;
  const milestone = response["final_execution_status"];
  if (milestone === "NONE") return { kind: "unknown", transactionHash };
  check(
    [
      "INCLUDED",
      "EXECUTED_OPTIMISTIC",
      "INCLUDED_FINAL",
      "EXECUTED",
      "FINAL",
    ].includes(String(milestone)),
    "invalid execution milestone",
  );
  const tx = record(response["transaction"]);
  check(
    tx["hash"] === transactionHash &&
      tx["signer_id"] === proof.signerId &&
      tx["receiver_id"] === proof.contractId &&
      tx["public_key"] === proof.publicKey &&
      rpcU64(tx["nonce"]) === proof.nonce,
    "transaction provenance mismatch",
  );
  const actions = list(tx["actions"], 1);
  check(actions.length === 1, "expected one call");
  const onlyAction = record(actions[0]);
  check(Object.keys(onlyAction).length === 1, "expected only FunctionCall");
  const action = record(onlyAction["FunctionCall"]);
  check(
    action["method_name"] === proof.method &&
      action["deposit"] === "0" &&
      rpcU64(action["gas"]) === proof.gas &&
      JSON.stringify(
        createMarketCall(proof.method, decodeBase64Json(action["args"])).args,
      ) === JSON.stringify(createMarketCall(proof.method, proof.args).args),
    "transaction call mismatch",
  );
  if (milestone !== "FINAL") return { kind: "pending", transactionHash };
  const transactionOutcome = record(response["transaction_outcome"]);
  check(
    transactionOutcome["id"] === transactionHash,
    "transaction outcome mismatch",
  );
  const root = record(transactionOutcome["outcome"]);
  check(
    root["executor_id"] === proof.signerId,
    "transaction executor mismatch",
  );
  const outcomes = new Map<string, Record<string, unknown>>();
  for (const value of list(response["receipts_outcome"])) {
    const row = record(value),
      id = hash32(row["id"]);
    check(!outcomes.has(id), "duplicate receipt ID");
    outcomes.set(id, record(row["outcome"]));
  }
  const reachable = new Set<string>();
  const queue = list(root["receipt_ids"]).map(hash32);
  while (queue.length) {
    const id = queue.shift()!;
    check(!reachable.has(id), "duplicate/cyclic receipt reference");
    reachable.add(id);
    const outcome = outcomes.get(id);
    check(outcome, "missing receipt outcome");
    queue.push(...list(outcome["receipt_ids"]).map(hash32));
  }
  check(reachable.size === outcomes.size, "unrelated receipt outcome");
  const all = [root, ...outcomes.values()];
  for (const outcome of all) {
    const status = record(outcome["status"]);
    check(
      Object.keys(status).length === 1 &&
        (successful(status) || Object.hasOwn(status, "Failure")),
      "incomplete receipt status",
    );
  }
  const finalStatus = record(response["status"]);
  const receiptFailed = all.some((row) =>
    Object.hasOwn(record(row["status"]), "Failure"),
  );
  const finalFailed = Object.hasOwn(finalStatus, "Failure");
  if (receiptFailed || finalFailed) {
    check(
      receiptFailed && finalFailed && Object.keys(finalStatus).length === 1,
      "inconsistent final failure evidence",
    );
    return { kind: "failed", transactionHash, code: "EXECUTION_FAILED" };
  }
  check(
    Object.keys(finalStatus).length === 1 &&
      typeof finalStatus["SuccessValue"] === "string",
    "missing final return value",
  );
  const rootId = record(root["status"])["SuccessReceiptId"];
  check(
    typeof rootId === "string" && list(root["receipt_ids"]).includes(rootId),
    "missing contract receipt root",
  );
  const executed = outcomes.get(rootId);
  check(
    executed &&
      executed["executor_id"] === proof.contractId &&
      record(executed["status"])["SuccessValue"] ===
        finalStatus["SuccessValue"],
    "contract return provenance mismatch",
  );
  const result = decodeCallResult(
    proof.method,
    decodeBase64Json(finalStatus["SuccessValue"]),
  );
  await verifyResult(proof, result);
  return { kind: "succeeded", transactionHash, result };
}
