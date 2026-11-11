import { ChainRpcError, createRpcTransport } from "@bot-bazaar/chain";
import type { RpcTransport } from "@bot-bazaar/chain";

interface RpcLane {
  tail: Promise<void>;
  lastStarted: number;
  retryAt: number;
  failures: number;
  cache: Map<string, { expires: number; value: unknown }>;
  pending: Map<string, Promise<unknown>>;
}
const lanes = new WeakMap<typeof fetch, Map<string, RpcLane>>();

/** Share a bounded read lane across guest, wallet and per-refresh SDK clients. */
export function createTownRpc(url: string, fetcher: typeof fetch = fetch, scope = fetcher): RpcTransport {
  let endpoints = lanes.get(scope);
  if (!endpoints) { endpoints = new Map(); lanes.set(scope, endpoints); }
  const endpoint = new URL(url).href;
  let lane = endpoints.get(endpoint);
  if (!lane) {
    lane = { tail: Promise.resolve(), lastStarted: 0, retryAt: 0, failures: 0, cache: new Map(), pending: new Map() };
    endpoints.set(endpoint, lane);
  }
  const shared = lane;
  let cancelled = false;
  const transport = createRpcTransport(url, async (input, init) => {
    const local = typeof location !== "undefined" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
    try {
      return await fetcher(local ? "/api/town-rpc" : input,
        local ? { ...init, credentials: "omit", redirect: "error" } : init);
    }
    catch (error) { cancelled = init?.signal?.aborted === true; throw error; }
  });
  return (method, params) => {
    const key = JSON.stringify([method, params]);
    const cached = shared.cache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(structuredClone(cached.value));
    const pending = shared.pending.get(key);
    if (pending) return pending.then(value => structuredClone(value));
    if (Date.now() < shared.retryAt) return Promise.reject(new ChainRpcError("RATE_LIMITED"));
    const previous = shared.tail;
    let release!: () => void;
    shared.tail = new Promise<void>(resolve => { release = resolve; });
    const request = (async () => {
      await previous;
      try {
        if (Date.now() < shared.retryAt) throw new ChainRpcError("RATE_LIMITED");
        const wait = 250 - (Date.now() - shared.lastStarted);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        shared.lastStarted = Date.now(); cancelled = false;
        let value: unknown;
        try { value = await transport(method, params); }
        catch (error) {
          if (!cancelled && error instanceof ChainRpcError &&
            ["RATE_LIMITED", "UNAVAILABLE", "UNAVAILABLE_OR_INVALID_RESPONSE"].includes(error.code)) {
            shared.failures++;
            shared.retryAt = Date.now() + Math.min(60000, 15000 * 2 ** Math.min(shared.failures - 1, 2));
          }
          throw error;
        }
        shared.failures = 0;
        const p = params as Record<string, unknown> | null;
        const immutable = method === "EXPERIMENTAL_genesis_config" ||
          ((method === "query" || method === "block") && p?.["block_id"] !== undefined);
        if (immutable || method === "status") {
          if (shared.cache.size >= 256) shared.cache.delete(shared.cache.keys().next().value!);
          shared.cache.set(key, { expires: Date.now() + (immutable ? 300000 : 5000), value: structuredClone(value) });
        }
        return value;
      } finally { release(); }
    })().finally(() => { shared.pending.delete(key); });
    shared.pending.set(key, request);
    return request.then(value => structuredClone(value));
  };
}
