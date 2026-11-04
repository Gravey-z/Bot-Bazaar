import { MarketClient, createRpcTransport } from "@bot-bazaar/chain";
import type { Trade, FinalizedBlock } from "@bot-bazaar/chain";
import type {
  ActivityPage,
  PublicConfig,
  PublicTrade,
} from "@bot-bazaar/shared";
import { decodeActivityPage, decodeDeployment } from "./activity-wire";

export class ActivityReadError extends Error {
  constructor(
    readonly kind: "unavailable" | "invalid" | "generation" | "deployment",
  ) {
    super(`Activity read: ${kind}`);
  }
}
export interface ChainActivityPage {
  readonly block: FinalizedBlock;
  readonly codeHash: string;
  readonly marketRevision: string;
  readonly capturedAt: number;
  readonly trades: readonly PublicTrade[];
  readonly nextAfter: string | null;
  readonly hasMore: boolean;
  readonly historyGap: boolean;
  readonly prunedThrough: string;
  readonly highWater: string;
  readonly reset: boolean;
}
export interface ActivityReads {
  readonly config?: PublicConfig;
  worker(after: string | null): Promise<ActivityPage>;
  chain(after: string | null): Promise<ChainActivityPage>;
}
function merchantSeller(actor: Trade["seller"]): PublicTrade["seller"] {
  if (actor.kind !== "merchant") throw new ActivityReadError("invalid");
  return actor.merchant_id;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json") ||
    !response.body
  )
    throw new ActivityReadError("invalid");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > 262144) {
      await reader.cancel();
      throw new ActivityReadError("invalid");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function createActivityReads(
  config: PublicConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): ActivityReads {
  const client = new MarketClient(
    config.contractId,
    createRpcTransport(config.rpcUrl, fetcher),
  );
  return {
    config,
    async worker(after) {
      try {
        const url = new URL("activity", config.workerUrl);
        url.searchParams.set("limit", "50");
        if (after !== null) url.searchParams.set("after", after);
        const response = await fetcher(url.href, {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(10000),
        });
        const value = await boundedJson(response);
        if (!response.ok) {
          const error = value as {
            error?: unknown;
            reset_required?: unknown;
            deployment?: unknown;
          };
          if (
            response.status === 409 &&
            error.error === "feed_generation_mismatch" &&
            error.reset_required === true
          ) {
            if (
              error.deployment &&
              decodeDeployment(error.deployment).contract_id !==
                config.contractId
            )
              throw new ActivityReadError("deployment");
            throw new ActivityReadError("generation");
          }
          if (
            response.status === 400 &&
            error.error === "cursor_deployment_mismatch"
          )
            throw new ActivityReadError("deployment");
          throw new ActivityReadError("unavailable");
        }
        const page = decodeActivityPage(value);
        if (page.deployment.contract_id !== config.contractId)
          throw new ActivityReadError("deployment");
        return page;
      } catch (error) {
        if (error instanceof ActivityReadError) throw error;
        throw new ActivityReadError("invalid");
      }
    },
    async chain(after) {
      const reader = await client.finalized();
      const [market, account] = await Promise.all([
        reader.getMarketState(),
        reader.query("view_account", config.contractId),
      ]);
      const codeHash = account["code_hash"];
      if (
        typeof codeHash !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(codeHash)
      )
        throw new ActivityReadError("invalid");
      const highWater = (BigInt(market.data.next_trade_id) - 1n).toString();
      const reset = after !== null && BigInt(after) > BigInt(highWater);
      const page = await reader.getRecentTrades({
        after_id: reset ? null : after,
        limit: "50",
        expected_revision: market.market_revision,
      });
      if (
        page.data.items.some(
          (trade) =>
            BigInt(trade.trade_id) > BigInt(highWater) ||
            BigInt(trade.settled_at_ns) > BigInt(reader.block.timestampNs) ||
            BigInt(trade.market_revision) > BigInt(market.market_revision),
        )
      )
        throw new ActivityReadError("invalid");
      return {
        block: reader.block,
        codeHash,
        marketRevision: market.market_revision,
        capturedAt: now(),
        trades: page.data.items.map((trade) => ({
          trade_id: trade.trade_id,
          kind: trade.kind,
          buyer:
            trade.buyer.kind === "merchant" ? trade.buyer.merchant_id : null,
          seller: merchantSeller(trade.seller),
          resource: trade.resource,
          quantity: trade.quantity,
          unit_price: trade.unit_price,
          total_price: trade.total_price,
          settled_at_ns: trade.settled_at_ns,
        })),
        nextAfter: page.data.next_after_id,
        hasMore: page.data.has_more,
        historyGap: page.data.history_gap,
        prunedThrough: page.data.pruned_through,
        highWater,
        reset,
      };
    },
  };
}
