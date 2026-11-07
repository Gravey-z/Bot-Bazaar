import {
  canonicalLivingTownJson,
  livingTownReadEnvelope,
  livingTownSalesHistoryRead,
  parseLivingTownJson,
} from "@bot-bazaar/chain";
import type { LivingTownClient } from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";
import type { AssistantFacts } from "./proposals.js";

export interface AssistantFactSource {
  load(account: string, shop: string): Promise<AssistantFacts>;
}
export function confirmedRestockSpending(
  history: ReturnType<typeof livingTownSalesHistoryRead>["items"],
  now: string,
  genesis: string,
): { tick: string; day: string } {
  const timestamp = BigInt(now),
    origin = BigInt(genesis);
  requireStorage(timestamp >= origin, "assistant clock precedes town genesis");
  const tickStart = timestamp - ((timestamp - origin) % 60_000_000_000n);
  const dayStart = timestamp - (timestamp % 86_400_000_000_000n);
  const purchases = history.filter((h) => h.kind === "material_purchase");
  const spentSince = (start: bigint) =>
    purchases
      .filter(
        (h) =>
          BigInt(h.block_timestamp_ns) >= start &&
          BigInt(h.block_timestamp_ns) <= timestamp,
      )
      .reduce((sum, h) => sum + BigInt(h.gold_amount), 0n)
      .toString();
  return { tick: spentSince(tickStart), day: spentSince(dayStart) };
}
/** RPC facts are pinned; receipt-projected history must cover the same economic checkpoint. */
export function assistantFactSource(
  client: LivingTownClient,
  workerUrl: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): AssistantFactSource {
  const base = new URL(workerUrl);
  requireStorage(
    !base.username &&
      !base.password &&
      (base.protocol === "https:" ||
        (base.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))),
    "reviewed projection URL required",
  );
  return {
    async load(account, id) {
      const reader = await client.finalized();
      const [town, shop, ledger] = await Promise.all([
        reader.getTown(),
        reader.getShop(id),
        reader.getShopInventory(id),
      ]);
      requireStorage(
        shop.data?.owner.kind === "player" &&
          shop.data.owner.account_id === account &&
          ledger.data.actor.kind === "player" &&
          ledger.data.actor.account_id === account &&
          shop.market_revision === town.market_revision &&
          ledger.market_revision === town.market_revision &&
          shop.event_sequence === town.event_sequence &&
          ledger.event_sequence === town.event_sequence,
        "incoherent assistant owner facts",
      );
      const listings: AssistantFacts["listings"] = [];
      const assistantPolicy = (
        await reader.getFoundation()
      ).data.supported_methods.includes("assistant_reprice")
        ? (await reader.getAssistantPolicy(id)).data
        : undefined;
      for (const shop_id of [id, "1", "2", "3"]) {
        const page = await reader.getListings({
          shop_id,
          item_id: null,
          active_only: true,
          after_id: null,
          limit: "50",
          expected_market_revision: town.market_revision,
        });
        requireStorage(
          !page.data.has_more &&
            page.market_revision === town.market_revision &&
            page.event_sequence === town.event_sequence,
          "incomplete listings",
        );
        listings.push(...page.data.items);
      }
      const history: ReturnType<typeof livingTownSalesHistoryRead>["items"] =
        [];
      let cursor: string | null = null,
        complete = true,
        done = false;
      const cursors = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const url = new URL(`/api/shops/${id}/history`, base);
        url.searchParams.set("limit", "50");
        if (cursor) url.searchParams.set("after", cursor);
        const response = await fetcher(url, {
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        requireStorage(
          response.ok && response.body,
          "confirmed cost/history unavailable",
        );
        const r = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const c = await r.read();
          if (c.done) break;
          length += c.value.length;
          if (length > 262144) {
            await r.cancel();
            throw new Error("assistant history too large");
          }
          chunks.push(c.value);
        }
        const bytes = Buffer.concat(chunks);
        const p = livingTownReadEnvelope(livingTownSalesHistoryRead)(
          parseLivingTownJson(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          ),
        );
        requireStorage(
          canonicalLivingTownJson(p.deployment) ===
            canonicalLivingTownJson(client.identity.deployment) &&
            p.checkpoint.verified_code_hash === client.identity.codeHash &&
            p.snapshot.data.shop_id === id &&
            p.snapshot.market_revision === town.market_revision &&
            p.snapshot.event_sequence === town.event_sequence &&
            p.snapshot.data.costs.through_event_sequence ===
              town.event_sequence &&
            BigInt(p.snapshot.block_height) <= BigInt(reader.block.height) &&
            !p.stale &&
            now() - Number(p.observed_at_ms) >= -5000 &&
            now() - Number(p.observed_at_ms) <= 30000,
          "assistant projection checkpoint mismatch",
        );
        complete &&=
          p.history_complete && p.snapshot.data.costs.cost_history_complete;
        for (const row of p.snapshot.data.items) {
          requireStorage(
            BigInt(row.event_sequence) <= BigInt(town.event_sequence) &&
              BigInt(row.block_timestamp_ns) <=
                BigInt(town.block_timestamp_ns) &&
              (!history.length ||
                BigInt(history.at(-1)!.event_sequence) <
                  BigInt(row.event_sequence)),
            "unordered assistant history",
          );
          history.push(row);
        }
        if (!p.snapshot.data.has_more) {
          done = true;
          break;
        }
        cursor = p.snapshot.data.next_cursor;
        requireStorage(
          cursor && !cursors.has(cursor),
          "assistant history cursor loop",
        );
        cursors.add(cursor);
      }
      complete &&= done;
      const productionCost: AssistantFacts["productionCost"] = {},
        demand: AssistantFacts["demand"] = {};
      for (const item of ["health_potion", "iron_tool"]) {
        const batches = history.filter(
          (h) => h.kind === "production_completed" && h.item_id === item,
        );
        productionCost[item] =
          batches.length &&
          batches.every(
            (h) => h.cost_status === "known" && h.production_cost !== null,
          )
            ? batches
                .reduce((max, h) => {
                  const unit =
                    (BigInt(h.production_cost!) + BigInt(h.quantity!) - 1n) /
                    BigInt(h.quantity!);
                  return unit > max ? unit : max;
                }, 0n)
                .toString()
            : null;
        const start = BigInt(town.block_timestamp_ns) - 300000000000n;
        demand[item] = history
          .filter(
            (h) =>
              h.kind === "customer_sale" &&
              h.item_id === item &&
              BigInt(h.block_timestamp_ns) >= start,
          )
          .reduce((sum, h) => sum + BigInt(h.quantity!), 0n)
          .toString();
      }
      return {
        restockSpending: confirmedRestockSpending(
          history,
          town.block_timestamp_ns,
          town.data.genesis_time_ns,
        ),
        ...(assistantPolicy ? { assistantPolicy } : {}),
        snapshot: {
          deployment: town.deployment,
          block_hash: reader.block.hash,
          block_height: town.block_height,
          block_timestamp_ns: town.block_timestamp_ns,
          market_revision: town.market_revision,
          event_sequence: town.event_sequence,
        },
        shop: shop.data,
        ledger: ledger.data,
        listings,
        fresh:
          Math.abs(
            now() - Number(BigInt(town.block_timestamp_ns) / 1000000n),
          ) <= 30000,
        historyComplete: complete,
        paused: town.data.paused,
        productionCost,
        demand,
      };
    },
  };
}
