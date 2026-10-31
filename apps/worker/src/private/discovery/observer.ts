import { MarketClient } from "@bot-bazaar/chain";
import type {
  FinalizedMarketReader,
  MarketState,
  Offer,
  Page,
  Snapshot,
} from "@bot-bazaar/chain";
import type { WorkerStore } from "../storage/database.js";
import { requireStorage } from "../storage/validation.js";
import type { DiscoverySignal, DiscoveryState } from "./types.js";

const merchants = ["rex", "luna", "bolt"] as const;
const compareIds = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

export class DiscoveryObserver {
  private running = false;
  constructor(
    private readonly client: MarketClient,
    private readonly store: WorkerStore,
  ) {}

  private async pages<T>(
    read: (after: string | null) => Promise<Snapshot<Page<T>>>,
    initial: string | null,
    max: number,
    watermark: string,
    getId: (item: T) => string,
    abort: AbortSignal,
  ): Promise<{ items: T[]; gap: boolean }> {
    let after = initial,
      gap = false;
    const items: T[] = [];
    for (let page = 0; page < Math.ceil(max / 50) + 1; page++) {
      abort.throwIfAborted();
      const result = await read(after);
      requireStorage(
        result.data.pruned_through === watermark &&
          result.data.history_gap ===
            (BigInt(watermark) > 0n &&
              (after === null || BigInt(after) < BigInt(watermark))),
        "inconsistent history watermark",
      );
      gap ||= result.data.history_gap;
      items.push(...result.data.items);
      requireStorage(items.length <= max, "discovery page capacity exceeded");
      if (!result.data.has_more) return { items, gap };
      requireStorage(
        result.data.items.length > 0 && result.data.next_after_id !== after,
        "discovery cursor did not advance",
      );
      after = result.data.next_after_id;
      requireStorage(
        after === getId(items.at(-1)!),
        "discovery cursor identity mismatch",
      );
    }
    throw new Error("discovery pagination bound exceeded");
  }

  async poll(abort = new AbortController().signal): Promise<DiscoveryState> {
    requireStorage(!this.running, "discovery pass already running");
    this.running = true;
    try {
      const previous = this.store.discoveryState();
      // Abort is checked before every request, including the adapter's internal reads.
      const client = new MarketClient(
        this.client.contractId,
        async (method, params) => {
          abort.throwIfAborted();
          return this.client.transport(method, params);
        },
      );
      const { reader, market } = await client.verifyDeployment(
        this.store.identity,
      );
      requireStorage(
        !previous ||
          (BigInt(market.market_revision) >=
            BigInt(previous.market.market_revision) &&
            BigInt(reader.block.height) >= BigInt(previous.block.height) &&
            BigInt(reader.block.timestampNs) >=
              BigInt(previous.block.timestampNs) &&
            BigInt(market.data.next_offer_id) >=
              BigInt(previous.market.data.next_offer_id) &&
            BigInt(market.data.next_trade_id) >=
              BigInt(previous.market.data.next_trade_id) &&
            BigInt(market.data.offers_pruned_through) >=
              BigInt(previous.market.data.offers_pruned_through) &&
            BigInt(market.data.trades_pruned_through) >=
              BigInt(previous.market.data.trades_pruned_through)),
        "finalized discovery state regressed",
      );
      const after = previous?.tradeCursor ?? null;
      let scanStart = after;
      let history = await this.tradePages(reader, market, after, abort);
      const offerGap =
        BigInt(market.data.offers_pruned_through) >
        BigInt(previous?.market.data.offers_pruned_through ?? "0");
      let mode: DiscoveryState["mode"] = previous ? "incremental" : "initial";
      if (history.gap || offerGap) {
        mode = "resync";
        // A fresh authoritative snapshot on the same pinned block, never mixed blocks.
        const refreshed = await reader.getMarketState();
        requireStorage(
          JSON.stringify(refreshed) === JSON.stringify(market),
          "pinned market state changed",
        );
        history = await this.tradePages(reader, market, null, abort);
        scanStart = null;
      }
      const offers = await this.offerPages(reader, market, abort);
      const upperTrade = (BigInt(market.data.next_trade_id) - 1n).toString();
      let accounted =
        BigInt(scanStart ?? "0") > BigInt(market.data.trades_pruned_through)
          ? BigInt(scanStart ?? "0")
          : BigInt(market.data.trades_pruned_through);
      for (const trade of history.items) {
        requireStorage(
          BigInt(trade.trade_id) === accounted + 1n,
          "missing retained trade ID",
        );
        accounted++;
      }
      requireStorage(
        accounted === BigInt(upperTrade),
        "incomplete latest trade history",
      );
      const signals: DiscoverySignal[] = [];
      for (const offer of offers)
        if (offer.status === "pending")
          signals.push({
            key: `offer:${offer.offer_id}`,
            kind: "offer_pending",
            merchantId: offer.counterparty,
            offer,
          });
      for (const trade of history.items)
        if (trade.kind === "player_purchase") {
          requireStorage(
            trade.seller.kind === "merchant",
            "invalid purchase seller",
          );
          signals.push({
            key: `purchase:${trade.trade_id}`,
            kind: "player_purchase",
            merchantId: trade.seller.merchant_id,
            trade,
          });
        }
      if (offerGap)
        signals.push({
          key: `gap:offers:${previous?.market.data.offers_pruned_through ?? "0"}:${market.data.offers_pruned_through}`,
          kind: "history_gap",
          merchantId: null,
          stream: "offers",
          after: previous?.market.data.offers_pruned_through ?? null,
          prunedThrough: market.data.offers_pruned_through,
          upperBound: (BigInt(market.data.next_offer_id) - 1n).toString(),
        });
      if (
        BigInt(market.data.trades_pruned_through) > 0n &&
        (after === null ||
          BigInt(after) < BigInt(market.data.trades_pruned_through))
      )
        signals.push({
          key: `gap:trades:${after ?? "0"}:${market.data.trades_pruned_through}`,
          kind: "history_gap",
          merchantId: null,
          stream: "trades",
          after,
          prunedThrough: market.data.trades_pruned_through,
          upperBound: upperTrade,
        });
      abort.throwIfAborted();
      const state: DiscoveryState = {
        block: reader.block,
        market,
        offers,
        trades: history.items,
        tradeCursor: upperTrade,
        mode,
        observedAt: Date.now(),
      };
      this.store.commitDiscovery({
        previousHash: previous?.block.hash ?? null,
        state,
        signals,
      });
      return state;
    } finally {
      this.running = false;
    }
  }

  private tradePages(
    reader: FinalizedMarketReader,
    market: Snapshot<MarketState>,
    after: string | null,
    abort: AbortSignal,
  ) {
    return this.pages(
      (cursor) =>
        reader.getRecentTrades({
          after_id: cursor,
          limit: "50",
          expected_revision: market.market_revision,
        }),
      after,
      100,
      market.data.trades_pruned_through,
      (row) => row.trade_id,
      abort,
    );
  }
  private async offerPages(
    reader: FinalizedMarketReader,
    market: Snapshot<MarketState>,
    abort: AbortSignal,
  ): Promise<Offer[]> {
    const all = new Map<string, Offer>(),
      pending = new Map<string, Offer>();
    for (const name of merchants)
      for (const filter of ["all", "pending"] as const) {
        const rows = await this.pages(
          (cursor) =>
            reader.getOffersForMerchant(name, filter, {
              after_id: cursor,
              limit: "50",
              expected_revision: market.market_revision,
            }),
          null,
          filter === "all" ? 112 : 8,
          market.data.offers_pruned_through,
          (row) => row.offer_id,
          abort,
        );
        for (const offer of rows.items) {
          requireStorage(
            BigInt(offer.offer_id) < BigInt(market.data.next_offer_id) &&
              (offer.status !== "pending" ||
                BigInt(offer.expires_at_ns) > BigInt(reader.block.timestampNs)),
            "invalid allocated/live offer",
          );
          const target = filter === "all" ? all : pending,
            existing = target.get(offer.offer_id);
          requireStorage(
            !existing || JSON.stringify(existing) === JSON.stringify(offer),
            "inconsistent offer observed under participants",
          );
          target.set(offer.offer_id, offer);
        }
      }
    const live = [...all.values()].filter((row) => row.status === "pending");
    requireStorage(
      all.size <= 112 &&
        live.length <= 12 &&
        pending.size === live.length &&
        live.every(
          (row) =>
            JSON.stringify(pending.get(row.offer_id)) === JSON.stringify(row),
        ),
      "pending/all offer views disagree",
    );
    return [...all.values()].sort((a, b) => compareIds(a.offer_id, b.offer_id));
  }
}
