import { canonicalLivingTownJson, livingTownMerchantContext, livingTownReadEnvelope,
  parseLivingTownJson, merchantContextMaxBytes, livingTownTown } from "@bot-bazaar/chain";
import type { FinalizedLivingTownReader } from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";

export type SharedMerchantFacts = ReturnType<typeof livingTownMerchantContext>;
export class SharedMerchantFactsUnavailable extends Error {
  constructor(readonly reason = "reader_unavailable", readonly details: Record<string, unknown> | null = null) { super("Shared merchant projection is unavailable, stale or behind the finalized state");
    this.name = "SharedMerchantFactsUnavailable"; }
}

/** Reads the reader's SQLite-backed API; never opens its exclusively owned DB. */
export async function readSharedMerchantFacts(
  workerUrl: string, reader: FinalizedLivingTownReader, fetcher: typeof fetch = fetch,
): Promise<SharedMerchantFacts> {
  let reason = "reader_unavailable";
  let details: Record<string, unknown> | null = null;
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
    const now = Date.now();
    const differences: { field: string; projection: unknown; expected: unknown }[] = [];
    const compare = (field: string, projection: unknown, expected: unknown) => {
      if (projection !== expected) differences.push({ field, projection, expected });
    };
    compare("stale", envelope.stale, false);
    compare("deployment", canonicalLivingTownJson(envelope.deployment), canonicalLivingTownJson(reader.identity.deployment));
    compare("verified_code_hash", envelope.checkpoint.verified_code_hash, reader.identity.codeHash);
    compare("market_revision", envelope.snapshot.market_revision, town.market_revision);
    compare("event_sequence", envelope.snapshot.event_sequence, town.event_sequence);
    const ages = {
      observed_at_ms: now - Number(envelope.observed_at_ms),
      runtime_block_timestamp_ms: now - Number(BigInt(town.block_timestamp_ns) / 1000000n),
      projection_block_timestamp_ms: now - Number(BigInt(envelope.snapshot.block_timestamp_ns) / 1000000n),
    };
    for (const [field, age] of Object.entries(ages))
      if (Math.abs(age) > 30000) differences.push({ field, projection: age, expected: "absolute age <= 30000 ms" });
    details = { differences, ages_ms: ages,
      // Positive deltas mean the projection is behind; negative means it is ahead.
      projection_lag_blocks: (BigInt(town.block_height) - BigInt(envelope.snapshot.block_height)).toString(),
      projection_lag_revisions: (BigInt(town.market_revision) - BigInt(envelope.snapshot.market_revision)).toString(),
      projection_lag_ms: ((BigInt(town.block_timestamp_ns) - BigInt(envelope.snapshot.block_timestamp_ns)) / 1000000n).toString(),
    };
    requireStorage(differences.length === 0, "merchant projection checkpoint mismatch");
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
  } catch { throw new SharedMerchantFactsUnavailable(reason, details); }
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
    const differences: { field: string; actual: unknown; expected: unknown }[] = [];
    const now = Date.now();
    for (const [label, envelope] of [["town", townEnvelope], ["merchant_context", contextEnvelope]] as const) {
      const checks: [string, unknown, unknown][] = [
        ["stale", envelope.stale, false],
        ["deployment", canonicalLivingTownJson(envelope.deployment), canonicalLivingTownJson(identity.deployment)],
        ["verified_code_hash", envelope.checkpoint.verified_code_hash, identity.codeHash],
      ];
      for (const [field, actual, expected] of checks)
        if (actual !== expected) differences.push({ field: `${label}.${field}`, actual, expected });
      for (const [field, age] of [["observed_age_ms", now - Number(envelope.observed_at_ms)],
        ["block_age_ms", now - Number(BigInt(envelope.snapshot.block_timestamp_ns) / 1000000n)]] as const)
        if (Math.abs(age) > 30000) differences.push({ field: `${label}.${field}`, actual: age, expected: "absolute age <= 30000 ms" });
    }
    for (const field of ["market_revision", "event_sequence"] as const)
      if (town[field] !== contextEnvelope.snapshot[field]) differences.push({ field, actual: contextEnvelope.snapshot[field], expected: town[field] });
    if (differences.length) throw new SharedMerchantFactsUnavailable("projection_checkpoint_mismatch", {
      differences,
      projection_lag_blocks: (BigInt(town.block_height) - BigInt(contextEnvelope.snapshot.block_height)).toString(),
      projection_lag_revisions: (BigInt(town.market_revision) - BigInt(contextEnvelope.snapshot.market_revision)).toString(),
      projection_lag_ms: ((BigInt(town.block_timestamp_ns) - BigInt(contextEnvelope.snapshot.block_timestamp_ns)) / 1000000n).toString(),
    });
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
