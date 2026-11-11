import { setTimeout as delay } from "node:timers/promises";
import type { RpcTransport } from "@bot-bazaar/chain";
import { ChainRpcError, createRpcTransport } from "@bot-bazaar/chain";

/** Use approved Testnet fallbacks only for dependency failures, never RPC rejections. */
export function resilientTownRpc(primary: string): RpcTransport {
  const urls = [...new Set([new URL(primary).href, "https://test.rpc.fastnear.com/",
    "https://archival-rpc.testnet.near.org/", "https://testnet-rpc.intea.rs/"])];
  const providers = urls.map(url => ({ rpc: createRpcTransport(url), retryAt: 0 }));
  let preferred = 0;
  return async (method, params) => {
    let failure: unknown = new ChainRpcError("RATE_LIMITED");
    // Retry the primary after its cooldown. A transient outage must not leave
    // the whole runtime permanently attached to a slower archival fallback.
    const first = preferred !== 0 && providers[0]!.retryAt <= Date.now() ? 0 : preferred;
    const order = [...new Set([first, preferred, ...providers.map((_, index) => index)])];
    for (const index of order) {
      const provider = providers[index]!;
      if (provider.retryAt > Date.now()) continue;
      try {
        const result = await provider.rpc(method, params);
        preferred = index;
        return result;
      } catch (error) {
        if (!(error instanceof ChainRpcError) ||
          !["RATE_LIMITED", "UNAVAILABLE", "UNAVAILABLE_OR_INVALID_RESPONSE"].includes(error.code)) throw error;
        provider.retryAt = Date.now() + 60000;
        failure = error;
        // A broadcast may have reached the provider. Recover the original hash
        // on the next cycle rather than immediately broadcasting elsewhere.
        if (method === "send_tx") throw error;
      }
    }
    throw failure;
  };
}

/** Immutable block-addressed reads are reusable; moving finality selectors are never cached. */
export function boundedTownRpc(
  transport: RpcTransport,
  spacingMs = 1500,
  maxConcurrentReads: 1 | 2 | 4 = 2,
): RpcTransport {
  const cache = new Map<string, { at: number; value: unknown }>();
  const inFlight = new Set<Promise<void>>();
  const pendingReads = new Map<string, Promise<unknown>>();
  let last = 0,
    retryAt = 0,
    failures = 0,
    tail: Promise<void> = Promise.resolve();
  return async (method, params) => {
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let released = false;
    const release = () => { if (!released) { released = true; unlock(); } };
    await previous;
    try {
      const p = params as Record<string, unknown> | null;
      const immutable =
        method === "EXPERIMENTAL_genesis_config" ||
        ((method === "query" || method === "block") &&
          p?.["block_id"] !== undefined);
      const key = JSON.stringify([method, params]),
        saved = cache.get(key);
      if (
        saved &&
        (immutable || (method === "status" && Date.now() - saved.at < 1000))
      )
        return structuredClone(saved.value);
      const shared = immutable ? pendingReads.get(key) : undefined;
      if (shared) {
        release();
        return structuredClone(await shared);
      }
      const readOnly = ["query", "block", "status", "EXPERIMENTAL_genesis_config", "tx"].includes(method);
      // Serialize admission and space request starts, rather than waiting for
      // each read response before allowing the next independent read to start.
      // Writes drain outstanding reads and retain the lock until completion.
      while (inFlight.size >= (readOnly ? maxConcurrentReads : 1))
        await Promise.race(inFlight);
      if (Date.now() < retryAt) throw new ChainRpcError("RATE_LIMITED");
      const wait = spacingMs - (performance.now() - last);
      if (wait > 0) await delay(wait);
      if (Date.now() < retryAt) throw new ChainRpcError("RATE_LIMITED");
      last = performance.now();
      const request = Promise.resolve().then(() => transport(method, params));
      const settled = request.then(() => {}, () => {});
      inFlight.add(settled);
      void settled.then(() => {
        inFlight.delete(settled);
        if (immutable && pendingReads.get(key) === request) pendingReads.delete(key);
      });
      if (immutable) pendingReads.set(key, request);
      if (readOnly) release();
      let value: unknown;
      try { value = await request; }
      catch (error) {
        if (error instanceof ChainRpcError && error.code === "RATE_LIMITED") {
          failures++;
          retryAt = Date.now() + Math.min(60000, 15000 * 2 ** Math.min(failures - 1, 2));
        }
        throw error;
      }
      if (Date.now() >= retryAt) failures = 0;
      if (immutable || method === "status") {
        if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
        cache.set(key, { at: Date.now(), value: structuredClone(value) });
      }
      return value;
    } finally {
      release();
    }
  };
}
