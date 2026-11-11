import { canonicalLivingTownJson, livingTownMerchantContext, livingTownReadEnvelope,
  parseLivingTownJson, merchantContextMaxBytes } from "@bot-bazaar/chain";
import type { FinalizedLivingTownReader } from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";

export type SharedMerchantFacts = ReturnType<typeof livingTownMerchantContext>;
export class SharedMerchantFactsUnavailable extends Error {
  constructor(readonly reason = "reader_unavailable") { super("Shared merchant projection is unavailable, stale or behind the finalized state");
    this.name = "SharedMerchantFactsUnavailable"; }
}

/** Reads the reader's SQLite-backed API; never opens its exclusively owned DB. */
export async function readSharedMerchantFacts(
  workerUrl: string, reader: FinalizedLivingTownReader, fetcher: typeof fetch = fetch,
): Promise<SharedMerchantFacts> {
  let reason = "reader_unavailable";
  try {
    const response = await fetcher(new URL("/api/merchant-context", workerUrl), {
      credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    reason = `reader_http_${response.status}`;
    requireStorage(response.ok && response.body, "merchant projection HTTP unavailable");
    reason = "invalid_merchant_context";
    const stream = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await stream.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        requireStorage(length <= merchantContextMaxBytes, "merchant projection size bound");
        chunks.push(chunk.value);
      }
    } finally { await stream.cancel(); }
    const envelope = livingTownReadEnvelope(livingTownMerchantContext)(parseLivingTownJson(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), merchantContextMaxBytes));
    const town = await reader.getTown();
    reason = "projection_checkpoint_mismatch";
    requireStorage(!envelope.stale &&
      canonicalLivingTownJson(envelope.deployment) === canonicalLivingTownJson(reader.identity.deployment) &&
      envelope.checkpoint.verified_code_hash === reader.identity.codeHash &&
      envelope.snapshot.market_revision === town.market_revision &&
      envelope.snapshot.event_sequence === town.event_sequence &&
      Math.abs(Date.now() - Number(envelope.observed_at_ms)) <= 30000 &&
      Math.abs(Date.now() - Number(BigInt(town.block_timestamp_ns) / 1000000n)) <= 30000 &&
      Math.abs(Date.now() - Number(BigInt(envelope.snapshot.block_timestamp_ns) / 1000000n)) <= 30000,
      "merchant projection checkpoint mismatch");
    // Either independently verified finalized reader can be slightly newer.
    // Equal global mutation counters prove subordinate economic state unchanged;
    // rebind time-derived facts to the runtime's block and retain fresh key checks.
    reason = "mixed_merchant_context";
    const lift = <T extends { data: unknown }>(snapshot: T): T => {
      const source = snapshot as T & { deployment: unknown; block_height: string;
        block_timestamp_ns: string; market_revision: string; event_sequence: string };
      requireStorage(canonicalLivingTownJson(source.deployment) === canonicalLivingTownJson(envelope.deployment) &&
        source.block_height === envelope.snapshot.block_height &&
        source.block_timestamp_ns === envelope.snapshot.block_timestamp_ns &&
        source.market_revision === envelope.snapshot.market_revision &&
        source.event_sequence === envelope.snapshot.event_sequence, "mixed database merchant context");
      return { ...snapshot, ...town, data: snapshot.data };
    };
    const context = envelope.snapshot.data;
    for (const row of context.merchants)
      requireStorage(town.data.npc_shops.some(shop =>
        canonicalLivingTownJson(shop) === canonicalLivingTownJson(row.shop.data)), "merchant shop state changed");
    return { ...context, merchants: context.merchants.map(row => ({ ...row, shop: lift(row.shop) })),
      candidates: context.candidates.map(row => ({ ...row, shop: lift(row.shop), ledger: lift(row.ledger) })),
      pendingOffers: context.pendingOffers.map(offer => ({ ...offer,
        expired: BigInt(offer.expires_at_ns) <= BigInt(town.block_timestamp_ns) })) };
  } catch { throw new SharedMerchantFactsUnavailable(reason); }
}
