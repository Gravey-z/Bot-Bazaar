import {
  canonicalLivingTownJson,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
} from "@bot-bazaar/chain";
import type {
  LivingTownClient,
  LivingTownProof,
  LivingTownCompletionProof,
} from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "./store.js";
import type { ProjectionBaseline } from "./store.js";

export class LivingTownProjector {
  private running: Promise<void> | undefined;
  private initialized = false;
  constructor(
    private readonly client: LivingTownClient,
    private readonly store: LivingTownProjectionStore,
  ) {}
  async ingest(
    proof: LivingTownProof | LivingTownCompletionProof,
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
    const indexed =
      proof.call.method === "complete_production"
        ? livingTownIndexedCompletion(
            proof as LivingTownCompletionProof,
            await this.client.completionReceiptEvidence(
              proof as LivingTownCompletionProof,
            ),
          )
        : livingTownIndexedReceipt(
            proof as LivingTownProof,
            await this.client.receiptEvidence(proof as LivingTownProof),
          );
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
    if (
      this.initialized &&
      this.store.marketReady() &&
      this.store.observe(town, reader.block)
    )
      return;
    const count = BigInt(town.data.next_shop_id) - 4n;
    if (count < 0n || count > 1000n)
      throw new Error("invalid bounded shop count");
    const shops: ProjectionBaseline["shops"] = [];
    const production: ProjectionBaseline["production"] = [];
    const readJobs = async (id: string) => {
      const pages: ProjectionBaseline["production"][number]["pages"] = [];
      let after: string | null = null;
      for (let page = 0; page < 6; page++) {
        const row = await reader.getProductionJobs({
          shop_id: id,
          status: "all",
          after_id: after,
          limit: "50",
          expected_market_revision: town.market_revision,
        });
        pages.push(row);
        if (!row.data.has_more) return { shopId: id, pages };
        if (
          row.data.next_after_id === null ||
          BigInt(row.data.next_after_id) <= BigInt(after ?? "0")
        )
          throw new Error("production cursor did not advance");
        after = row.data.next_after_id;
      }
      throw new Error("production page bound exceeded");
    };
    production.push(...(await Promise.all(["1", "2", "3"].map(readJobs))));
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
          return {
            shop: { ...shop, data: shop.data },
            ledger,
            production: await readJobs(id),
          };
        }),
      );
      shops.push(...rows.map(({ shop, ledger }) => ({ shop, ledger })));
      production.push(...rows.map((row) => row.production));
    }
    const listings: NonNullable<ProjectionBaseline["listings"]> = [];
    let afterListing: string | null = null;
    for (let page = 0; page < 41; page++) {
      const row = await reader.getListings({
        shop_id: null,
        item_id: null,
        active_only: false,
        after_id: afterListing,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      listings.push(row);
      if (!row.data.has_more) break;
      if (
        page === 40 ||
        row.data.next_after_id === null ||
        BigInt(row.data.next_after_id) <= BigInt(afterListing ?? "0")
      )
        throw new Error("market pagination incomplete");
      afterListing = row.data.next_after_id;
    }
    this.store.baseline(
      {
        block: reader.block,
        town,
        shops,
        production,
        listings,
        ...(town.data.market_event
          ? { marketEvents: await reader.getMarketEvents() }
          : {}),
      },
      Date.now(),
      true,
    );
    this.initialized = true;
  }
}
