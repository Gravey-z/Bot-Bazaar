import { canonicalLivingTownJson, livingTownMerchantContext, livingTownReadEnvelope,
  parseLivingTownJson, merchantContextMaxBytes, livingTownTown } from "@bot-bazaar/chain";
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

export interface SharedPlanningFacts {
  town: Awaited<ReturnType<FinalizedLivingTownReader["getTown"]>>;
  context: SharedMerchantFacts;
  blockHash: string;
}
/** Planning trusts the same verified database service as the frontend. Only
 * signing and transaction recovery perform independent fresh chain checks.
 */
export async function readSharedPlanningFacts(workerUrl: string,
  identity: import("@bot-bazaar/chain").LivingTownIdentity, fetcher: typeof fetch = fetch): Promise<SharedPlanningFacts> {
  const read = async (path: string): Promise<unknown> => {
    const response = await fetcher(new URL(path, workerUrl), { credentials: "omit", redirect: "error",
      cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) throw new SharedMerchantFactsUnavailable(`reader_http_${response.status}`);
    const stream = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try { for (;;) {
      const part = await stream.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireStorage(size <= merchantContextMaxBytes, "planning context size bound");
      chunks.push(part.value);
    } } finally { await stream.cancel(); }
    return parseLivingTownJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), merchantContextMaxBytes);
  };
  try {
    const [rawTown, rawContext] = await Promise.all([read("/api/town"), read("/api/merchant-context")]);
    const townEnvelope = livingTownReadEnvelope(livingTownTown)(rawTown),
      contextEnvelope = livingTownReadEnvelope(livingTownMerchantContext)(rawContext), town = townEnvelope.snapshot;
    for (const envelope of [townEnvelope, contextEnvelope]) requireStorage(!envelope.stale &&
      canonicalLivingTownJson(envelope.deployment) === canonicalLivingTownJson(identity.deployment) &&
      envelope.checkpoint.verified_code_hash === identity.codeHash &&
      Math.abs(Date.now() - Number(envelope.observed_at_ms)) <= 30000 &&
      Math.abs(Date.now() - Number(BigInt(envelope.snapshot.block_timestamp_ns) / 1000000n)) <= 30000,
      "planning projection stale or deployment mismatch");
    requireStorage(town.market_revision === contextEnvelope.snapshot.market_revision &&
      town.event_sequence === contextEnvelope.snapshot.event_sequence, "planning projection changed between reads");
    const context = contextEnvelope.snapshot.data;
    const lift = <T extends { data: unknown }>(snapshot: T): T => ({ ...snapshot, ...town, data: snapshot.data });
    for (const row of context.merchants) requireStorage(town.data.npc_shops.some(shop =>
      canonicalLivingTownJson(shop) === canonicalLivingTownJson(row.shop.data)), "planning shop state mismatch");
    return { town, blockHash: townEnvelope.checkpoint.finalized_block_hash,
      context: { ...context, merchants: context.merchants.map(row => ({ ...row, shop: lift(row.shop) })),
        candidates: context.candidates.map(row => ({ ...row, shop: lift(row.shop), ledger: lift(row.ledger) })),
        pendingOffers: context.pendingOffers.map(o => ({ ...o, expired: BigInt(o.expires_at_ns) <= BigInt(town.block_timestamp_ns) })) } };
  } catch (error) {
    if (error instanceof SharedMerchantFactsUnavailable) throw error;
    throw new SharedMerchantFactsUnavailable("planning_projection_not_ready");
  }
}
