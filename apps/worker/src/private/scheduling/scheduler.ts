import { createMarketCall, verifyFinalReceipt } from "@bot-bazaar/chain";
import type { CallProof } from "@bot-bazaar/chain";
import type { WorkerStore } from "../storage/database.js";
import { requireStorage } from "../storage/validation.js";

// Ingestion only. No provider, secret loader, signing or broadcasting capability.
export class Scheduler {
  constructor(private readonly store: WorkerStore) {}
  tick(now = Date.now()): void {
    this.store.scheduler.drainInbox(now);
    this.store.scheduler.compact(now);
  }
  async observePurchaseReceipt(
    receipt: unknown,
    proof: CallProof<"buy_from_merchant">,
    now = Date.now(),
  ): Promise<string | null> {
    proof = {
      ...proof,
      args: createMarketCall("buy_from_merchant", proof.args).args,
    };
    requireStorage(
      proof.contractId === this.store.identity.contractId &&
        proof.method === "buy_from_merchant",
      "purchase receipt deployment mismatch",
    );
    const status = await verifyFinalReceipt(receipt, proof);
    requireStorage(
      status.kind === "succeeded" &&
        status.result.data.seller.kind === "merchant",
      "final successful purchase required; logs alone are insufficient",
    );
    const trade = status.result.data;
    requireStorage(
      trade.seller.kind === "merchant",
      "purchase seller required",
    );
    return this.store.scheduler.observeVerifiedPurchase(
      {
        key: `purchase:${trade.trade_id}`,
        kind: "player_purchase",
        merchantId: trade.seller.merchant_id,
        trade,
      },
      status.transactionHash,
      now,
    );
  }
}
