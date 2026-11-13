import {
  canonicalLivingTownJson,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
} from "@bot-bazaar/chain";
import type {
  LivingTownClient,
  LivingTownProof,
  LivingTownCompletionProof,
  LivingTownIndexedReceipt,
  LivingTownIndexedCompletion,
} from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "./store.js";
import type { ProjectionBaseline } from "./store.js";

export class LivingTownProjector {
  private running: Promise<void> | undefined;
  private initialized = false;
  private lastObservedBlockHash: string | undefined;
  private gapSince = 0;
  private fullReconcileAt = 0;
  private receiptObserver?: (receipt: LivingTownIndexedReceipt | LivingTownIndexedCompletion) => void;
  observeReceipts(observer: (receipt: LivingTownIndexedReceipt | LivingTownIndexedCompletion) => void): void {
    this.receiptObserver = observer;
  }
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
    const result = this.store.commit(indexed, now);
    if (result === "indexed") this.receiptObserver?.(indexed);
    return result;
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
    const reader = await this.client.finalized();
    const now = Date.now();
    const auditDue = this.initialized && now - this.fullReconcileAt >= 300000;
    // An unchanged finalized block cannot contain new chain state. Still run
    // receipt ingestion in the caller and the periodic full integrity audit.
    if (this.initialized && !auditDue && this.store.marketReady() &&
        !this.store.town().stale && reader.block.hash === this.lastObservedBlockHash) return;
    const town = await reader.getTown();
    if (
      this.initialized &&
      !auditDue &&
      this.store.marketReady() &&
      this.store.observe(town, reader.block)
    ) {
      this.lastObservedBlockHash = reader.block.hash;
      this.gapSince = 0;
      return;
    }
    if (this.initialized && !auditDue) {
      // Receipts normally carry the next mutations. Give the durable queues
      // time to deliver them before falling back to a full repair read.
      this.store.noteHead(town, reader.block);
      if (!this.gapSince) this.gapSince = now;
      if (now - this.gapSince < 15000) return;
    }
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
        ...(this.client.identity.deployment.state_schema === "2"
          ? { offers: await this.readOfferPages(reader, town.market_revision) }
          : {}),
        ...(town.data.market_event
          ? { marketEvents: await reader.getMarketEvents() }
          : {}),
      },
      Date.now(),
      true,
    );
    this.initialized = true;
    this.lastObservedBlockHash = reader.block.hash;
    this.fullReconcileAt = Date.now();
    this.gapSince = 0;
  }
  private async readOfferPages(
    reader: import("@bot-bazaar/chain").FinalizedLivingTownReader,
    revision: string,
  ) {
    const pages: NonNullable<ProjectionBaseline["offers"]> = [];
    let after: string | null = null;
    for (let i = 0; i < 3; i++) {
      const p = await reader.getOffers({
        merchant_id: null,
        status: "all",
        after_id: after,
        limit: "50",
        expected_market_revision: revision,
      });
      pages.push(p);
      if (!p.data.has_more) return pages;
      if (p.data.next_after_id === null || p.data.next_after_id === after)
        throw new Error("offer baseline cursor stalled");
      after = p.data.next_after_id;
    }
    throw new Error("offer baseline incomplete");
  }
}
