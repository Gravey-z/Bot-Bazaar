import { setTimeout as delay } from "node:timers/promises";
import type { RpcTransport } from "@bot-bazaar/chain";
import { ChainRpcError, createRpcTransport } from "@bot-bazaar/chain";

const providerPool = new Map<string, { rpc: RpcTransport; retryAt: number; failures: number; host: string; generation: number }>();
const transports = new Map<string, RpcTransport>();

/** Use approved Testnet fallbacks only for dependency failures, never RPC rejections. */
export function resilientTownRpc(primary: string): RpcTransport {
  const normalized = new URL(primary).href;
  const existing = transports.get(normalized);
  if (existing) return existing;
  const urls = [...new Set([normalized, "https://test.rpc.fastnear.com/",
    "https://archival-rpc.testnet.near.org/", "https://testnet-rpc.intea.rs/"])];
  const providers = urls.map(url => {
    let state = providerPool.get(url);
    if (!state) {
      state = { rpc: createRpcTransport(url), retryAt: 0, failures: 0, host: new URL(url).host, generation: 0 };
      providerPool.set(url, state);
    }
    return state;
  });
  let preferred = 0;
  const transport: RpcTransport = async (method, params) => {
    let failure: unknown = new ChainRpcError("RATE_LIMITED");
    // Retry the primary after its cooldown. A transient outage must not leave
    // the whole runtime permanently attached to a slower archival fallback.
    const first = preferred !== 0 && providers[0]!.retryAt <= Date.now() ? 0 : preferred;
    const order = [...new Set([first, preferred, ...providers.map((_, index) => index)])];
    for (const index of order) {
      const provider = providers[index]!;
      if (provider.retryAt > Date.now()) continue;
      const generation = provider.generation;
      try {
        const result = await provider.rpc(method, params);
        preferred = index;
        // A success from an older concurrent request cannot cancel a newer cooldown.
        if (provider.generation === generation) {
          provider.failures = 0;
          provider.retryAt = 0;
        }
        return result;
      } catch (error) {
        if (!(error instanceof ChainRpcError) ||
          !["RATE_LIMITED", "UNAVAILABLE", "UNAVAILABLE_OR_INVALID_RESPONSE"].includes(error.code)) throw error;
        provider.generation++;
        provider.failures++;
        const cooldownMs = Math.min(60000, 15000 * 2 ** Math.min(provider.failures - 1, 2));
        provider.retryAt = Date.now() + cooldownMs;
        console.warn(JSON.stringify({ role: "town_rpc", event: "rpc_provider_cooldown",
          endpoint: provider.host, method, error_code: error.code,
          retry_after_ms: cooldownMs, retry_at: new Date(provider.retryAt).toISOString() }));
        failure = error;
        // A broadcast may have reached the provider. Recover the original hash
        // on the next cycle rather than immediately broadcasting elsewhere.
        if (method === "send_tx") throw error;
      }
    }
    throw failure;
  };
  transports.set(normalized, transport);
  return transport;
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
      const movingRead = method === "status" ||
        (method === "block" && p?.["finality"] === "final");
      const shareRead = immutable || movingRead;
      const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
      const key = JSON.stringify([method, stable(params)]),
        saved = cache.get(key);
      if (
        saved &&
        (immutable || (method === "status" && Date.now() - saved.at < 1000))
      )
        return structuredClone(saved.value);
      const shared = shareRead ? pendingReads.get(key) : undefined;
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
        if (shareRead && pendingReads.get(key) === request) pendingReads.delete(key);
      });
      if (shareRead) pendingReads.set(key, request);
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
