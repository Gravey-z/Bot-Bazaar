import {
  canonicalLivingTownJson,
  livingTownIndexedReceipt,
} from "@bot-bazaar/chain";
import type { LivingTownClient, LivingTownProof } from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "./store.js";
import type { ProjectionBaseline } from "./store.js";

export class LivingTownProjector {
  private running: Promise<void> | undefined;
  constructor(
    private readonly client: LivingTownClient,
    private readonly store: LivingTownProjectionStore,
  ) {}
  async ingest(
    proof: LivingTownProof,
    now = Date.now(),
  ): Promise<"duplicate" | "indexed" | "unresolved"> {
    if (
      canonicalLivingTownJson(proof.deployment) !==
      canonicalLivingTownJson(this.client.identity.deployment)
    )
      throw new Error("receipt inbox deployment mismatch");
    if (
      this.store.hasReceipt(
        proof.transactionHash,
        canonicalLivingTownJson(proof),
      )
    )
      return "duplicate";
    const evidence = await this.client.receiptEvidence(proof),
      indexed = livingTownIndexedReceipt(proof, evidence);
    if (!indexed) return "unresolved";
    return this.store.commit(indexed, now);
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.reconcile()
      .catch((error) => {
        this.store.invalidate();
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async reconcile(): Promise<void> {
    const reader = await this.client.finalized(),
      town = await reader.getTown();
    if (this.store.observe(town, reader.block)) return;
    const count = BigInt(town.data.next_shop_id) - 4n;
    if (count < 0n || count > 1000n)
      throw new Error("invalid bounded shop count");
    const shops: ProjectionBaseline["shops"] = [];
    // Bounded four-wide batches pinned to one immutable finalized block.
    for (let base = 4n; base < BigInt(town.data.next_shop_id); base += 4n) {
      const ids: Array<string> = [];
      for (
        let id = base;
        id < base + 4n && id < BigInt(town.data.next_shop_id);
        id++
      )
        ids.push(id.toString());
      const rows = await Promise.all(
        ids.map(async (id) => {
          const shop = await reader.getShop(id);
          if (!shop.data) throw new Error("missing allocated shop");
          const ledger = await reader.getShopInventory(id);
          return { shop: { ...shop, data: shop.data }, ledger };
        }),
      );
      shops.push(...rows);
    }
    this.store.baseline({ block: reader.block, town, shops });
  }
}
