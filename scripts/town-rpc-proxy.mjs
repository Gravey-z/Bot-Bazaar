import { readFile } from "node:fs/promises";

const approved = ["https://test.rpc.fastnear.com/", "https://archival-rpc.testnet.near.org/", "https://testnet-rpc.intea.rs/"];
const methods = new Set(["status", "block", "query", "EXPERIMENTAL_genesis_config", "tx"]);

/** Local public reads only. No signing, broadcasts, arbitrary targets or credentials. */
export function townRpcProxy(profileFile) {
  const cache = new Map(), cooldown = new Map();
  let tail = Promise.resolve(), queued = 0, last = 0;
  return async (req, res) => {
    if (req.url !== "/api/town-rpc") return false;
    const reply = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        ...(status === 429 || status === 503 ? { "Retry-After": "30" } : {}) });
      res.end(JSON.stringify(body));
    };
    let id = null;
    try {
      const origin = new URL(`http://${req.headers.host}`);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
        req.headers.origin !== origin.origin) { reply(403, { error: "same_origin_required" }); return true; }
      if (req.method !== "POST" || req.headers["content-type"] !== "application/json") {
        reply(405, { error: "json_post_required" }); return true;
      }
      if (queued >= 24) { reply(429, { error: "rpc_busy" }); return true; }
      if (Number(req.headers["content-length"] ?? 0) > 16384 || req.headers["content-encoding"])
        throw Error("invalid body");
      let length = 0; const chunks = [];
      for await (const chunk of req) {
        length += chunk.length; if (length > 16384) throw Error("invalid body"); chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!request || request.jsonrpc !== "2.0" || !methods.has(request.method) ||
        typeof request.id !== "string" || request.id.length > 128 ||
        !Object.hasOwn(request, "params") || Object.keys(request).sort().join() !== "id,jsonrpc,method,params")
        throw Error("invalid request");
      id = request.id;
      if (request.method === "query" && !["view_account", "view_access_key", "call_function"].includes(request.params?.request_type))
        throw Error("unsupported read");
      // Lookups return their current milestone; no upstream wait for unknown hashes.
      if (request.method === "tx") request.params = { ...request.params, wait_until: "NONE" };
      const key = JSON.stringify([request.method, request.params]);
      const respond = envelope => reply(200, { ...envelope, id });
      const saved = cache.get(key);
      if (saved && saved.expires > Date.now()) { respond(saved.value); return true; }
      if (queued >= 24) { reply(429, { error: "rpc_busy" }); return true; }
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; }); queued++;
      try {
        await previous;
        if (res.destroyed) return true;
        const found = cache.get(key);
        if (found && found.expires > Date.now()) { respond(found.value); return true; }
        const profile = JSON.parse(await readFile(profileFile, "utf8"));
        const primary = new URL(profile.public.rpcUrl).href;
        if (!approved.includes(primary)) throw Error("unapproved endpoint");
        for (const endpoint of [primary, ...approved.filter(url => url !== primary)]) {
          if ((cooldown.get(endpoint) ?? 0) > Date.now()) continue;
          const wait = 400 - (Date.now() - last);
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
          last = Date.now();
          try {
            const upstream = await fetch(endpoint, { method: "POST", redirect: "error", credentials: "omit",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(2500) });
            if (!upstream.ok || !upstream.body) {
              await upstream.body?.cancel(); cooldown.set(endpoint, Date.now() + 60000); continue;
            }
            const reader = upstream.body.getReader(); let size = 0; const parts = [];
            try {
              for (;;) { const part = await reader.read(); if (part.done) break;
                size += part.value.length; if (size > 2 * 1024 * 1024) throw Error("oversize response"); parts.push(part.value); }
            } finally { await reader.cancel(); }
            const envelope = JSON.parse(Buffer.concat(parts).toString("utf8"));
            if (!envelope || envelope.jsonrpc !== "2.0" || envelope.id !== id ||
              (!Object.hasOwn(envelope, "result") && !Object.hasOwn(envelope, "error"))) throw Error("invalid envelope");
            const immutable = request.method === "EXPERIMENTAL_genesis_config" ||
              (["block", "query"].includes(request.method) && request.params?.block_id !== undefined);
            if (Object.hasOwn(envelope, "result") && (immutable || request.method === "status")) {
              if (cache.size >= 256) cache.delete(cache.keys().next().value);
              cache.set(key, { expires: Date.now() + (immutable ? 300000 : 5000), value: envelope });
            }
            respond(envelope); return true;
          } catch { cooldown.set(endpoint, Date.now() + 30000); }
        }
        reply(503, { jsonrpc: "2.0", id, error: { code: -32000, message: "Testnet RPC temporarily unavailable" } });
      } finally { queued--; release(); }
    } catch {
      reply(400, { jsonrpc: "2.0", id, error: { code: -32600, message: "Local town RPC request unavailable or invalid" } });
    }
    return true;
  };
}
