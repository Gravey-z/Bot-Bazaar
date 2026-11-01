import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request } from "node:http";
import { connect } from "node:net";
import { createReadServer } from "../dist/private/read-api/server.js";
import { createReadHandler } from "../dist/private/read-api/handler.js";
import {
  parseBoundaryConfig,
  defaultBoundary,
  clientIp,
} from "../dist/private/read-api/config.js";
import { ReadLimits } from "../dist/private/read-api/limits.js";
import { setupInferenceFixture as setup } from "./inference-fixture.mjs";
import { readHealth } from "../dist/private/read-api/health.js";

const origin = "https://bazaar.example";
const config = parseBoundaryConfig({ WORKER_ALLOWED_ORIGINS: origin });
const peer = (address, forwarded) => ({
  socket: { remoteAddress: address },
  headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
});

async function serverFor(t, boundary = config, read) {
  let calls = 0;
  const server = createReadServer(
    read ?? {
      health: () => {
        calls++;
        return { status: "not_ready" };
      },
      activity: () => {
        calls++;
        return { entries: [] };
      },
    },
    boundary,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    server,
    get calls() {
      return calls;
    },
    port: server.address().port,
  };
}
function get(f, path = "/activity", options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port: f.port, path, ...options },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

test("boundary configuration is private, immutable and rejects wildcard, credential and malformed origins", () => {
  const parsed = parseBoundaryConfig({
    WORKER_ALLOWED_ORIGINS: `${origin},http://localhost:4200,http://[::1]:4200`,
    WORKER_TRUSTED_PROXY_IPS: "127.0.0.1,::ffff:127.0.0.1",
  });
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.allowedOrigins));
  assert.deepEqual(parsed.trustedProxyIps, ["127.0.0.1"]);
  for (const bad of [
    "*",
    "null",
    "https://*.example",
    "http://remote.example",
    origin + "/",
    origin + "/path",
    origin + "?key=PRIVATE_CANARY",
    "https://user:PRIVATE_CANARY@bazaar.example",
    origin + ",",
    "https://example.com\nX-Injected: value",
  ]) {
    assert.throws(
      () => parseBoundaryConfig({ WORKER_ALLOWED_ORIGINS: bad }),
      (e) => !e.message.includes("PRIVATE_CANARY"),
    );
  }
  for (const value of [
    "localhost",
    "127.0.0.1:3000",
    "10.0.0.0/8",
    "::1%zone",
    "*",
  ])
    assert.throws(() =>
      parseBoundaryConfig({ WORKER_TRUSTED_PROXY_IPS: value }),
    );
  for (const name of ["WORKER_READS_PER_MINUTE", "WORKER_READS_PER_SECOND"])
    for (const value of ["", "0", "01", "-1", "1.5", "10000", "PRIVATE_CANARY"])
      assert.throws(
        () => parseBoundaryConfig({ [name]: value }),
        (e) => !e.message.includes("PRIVATE_CANARY"),
      );
  assert.equal(defaultBoundary.clientPerMinute, 60);
  assert.equal(defaultBoundary.globalPerSecond, 10);
});

test("CORS uses exact configured origins, includes errors, and never enables credentials", async (t) => {
  const f = await serverFor(t);
  const allowed = await get(f, "/activity", { headers: { Origin: origin } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["access-control-allow-origin"], origin);
  assert.equal(allowed.headers["access-control-allow-credentials"], undefined);
  assert.match(allowed.headers.vary, /Origin/);
  const error = await get(f, "/activity?private=PRIVATE_CANARY", {
    headers: { Origin: origin },
  });
  assert.equal(error.status, 400);
  assert.equal(error.headers["access-control-allow-origin"], origin);
  assert.doesNotMatch(error.text, /PRIVATE_CANARY/);
  const health = await get(f, "/health", { headers: { Origin: origin } });
  assert.equal(health.status, 503);
  assert.equal(health.headers["access-control-allow-origin"], origin);
  const before = f.calls;
  for (const bad of [
    "null",
    "https://bazaar.example.evil",
    "http://bazaar.example",
    origin + "/",
    "https://other.example",
  ]) {
    const denied = await get(f, "/activity", { headers: { Origin: bad } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(f.calls, before);
  assert.equal((await get(f)).status, 200); // CLI without Origin remains read-only.
});

test("empty origin configuration permits CLI reads but grants no browser cross-origin access", async (t) => {
  const f = await serverFor(t, defaultBoundary);
  assert.equal((await get(f)).status, 200);
  assert.equal(
    (await get(f, "/activity", { headers: { Origin: origin } })).status,
    403,
  );
});

test("preflight grants only GET/HEAD and Accept without invoking a read", async (t) => {
  const f = await serverFor(t);
  const headers = {
    Origin: origin,
    "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "accept",
  };
  const allowed = await get(f, "/activity", { method: "OPTIONS", headers });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.text, "");
  assert.equal(allowed.headers["access-control-allow-methods"], "GET, HEAD");
  assert.equal(allowed.headers["access-control-allow-headers"], "Accept");
  for (const extra of [
    { "Access-Control-Request-Method": "POST" },
    { "Access-Control-Request-Headers": "authorization" },
    { "Access-Control-Request-Headers": "accept, x-admin" },
  ]) {
    assert.equal(
      (
        await get(f, "/activity", {
          method: "OPTIONS",
          headers: { ...headers, ...extra },
        })
      ).status,
      400,
    );
  }
  assert.equal((await get(f, "/activity", { method: "OPTIONS" })).status, 400);
  assert.equal(
    (await get(f, "/admin", { method: "OPTIONS", headers })).status,
    404,
  );
  assert.equal(f.calls, 0);
});

test("methods, bodies and admin-shaped queries cannot reach read or mutation capabilities", async (t) => {
  const f = await serverFor(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const result = await get(f, "/activity", {
      method,
      body: "PRIVATE_SIGNING_CANARY",
      headers: { "Content-Length": "22" },
    });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "GET, HEAD, OPTIONS");
    assert.doesNotMatch(result.text, /PRIVATE_SIGNING_CANARY/);
  }
  const body = await get(f, "/activity", {
    method: "GET",
    body: "secret",
    headers: { "Content-Length": "6" },
  });
  assert.equal(body.status, 400);
  for (const path of [
    "/activity?job=start",
    "/activity?sign=true",
    "/health?api_key=PRIVATE_CANARY",
    "/admin",
    "/inference",
    "/sign",
  ])
    assert.ok([400, 404].includes((await get(f, path)).status));
  assert.equal(f.calls, 0);
});

test("untrusted forwarded headers never select rate-limit identity; mapped IPv4 shares a bucket", () => {
  let now = 0;
  const limits = new ReadLimits(defaultBoundary, () => now);
  for (let i = 0; i < 20; i++) {
    const result = limits.admit(
      peer(i % 2 ? "::ffff:127.0.0.1" : "127.0.0.1", `10.0.0.${i}`),
    );
    assert.equal(result.ok, true);
    result.release();
  }
  now = 100;
  assert.equal(limits.admit(peer("127.0.0.1", "203.0.113.1")).status, 429);
  now = 1000;
  const restored = limits.admit(peer("127.0.0.1"));
  assert.equal(restored.ok, true);
  restored.release();
  assert.equal(clientIp("2001:0db8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(clientIp("::ffff:7f00:1"), "127.0.0.1");
});

test("only exact trusted peers can supply one overwritten client IP; chains and malformed addresses fail closed", () => {
  let now = 0;
  const limits = new ReadLimits(
    { ...defaultBoundary, trustedProxyIps: ["127.0.0.1"] },
    () => now,
  );
  for (const value of [
    undefined,
    "1.2.3.4, 5.6.7.8",
    "unknown",
    "localhost",
    "127.0.0.1:443",
    ["1.2.3.4", "5.6.7.8"],
  ])
    assert.equal(limits.admit(peer("127.0.0.1", value)).status, 400);
  for (let i = 0; i < 20; i++) {
    const result = limits.admit(peer("127.0.0.1", "203.0.113.1"));
    assert.equal(result.ok, true);
    result.release();
  }
  now = 100;
  assert.equal(limits.admit(peer("127.0.0.1", "203.0.113.1")).status, 429);
  const other = limits.admit(peer("127.0.0.1", "203.0.113.2"));
  assert.equal(other.ok, true);
  other.release();
});

test("global throttling survives rotating clients and returns usable refill delays", () => {
  let now = 0;
  const limits = new ReadLimits(defaultBoundary, () => now);
  for (let i = 0; i < 20; i++) {
    const result = limits.admit(peer(`10.0.0.${i}`));
    assert.equal(result.ok, true);
    result.release();
  }
  const denied = limits.admit(peer("203.0.113.50"));
  assert.equal(denied.status, 429);
  assert.equal(denied.retryAfter, 1);
  now = 100;
  const allowed = limits.admit(peer("203.0.113.50"));
  assert.equal(allowed.ok, true);
  allowed.release();
});

test("eight active responses bound concurrency and release is idempotent", () => {
  const limits = new ReadLimits(defaultBoundary, () => 0),
    active = [];
  for (let i = 0; i < 8; i++) {
    const result = limits.admit(peer("127.0.0.1"));
    assert.equal(result.ok, true);
    active.push(result);
  }
  assert.equal(
    limits.admit(peer("127.0.0.1")).code,
    "read_concurrency_limited",
  );
  active[0].release();
  active[0].release();
  const next = limits.admit(peer("127.0.0.1"));
  assert.equal(next.ok, true);
  assert.equal(
    limits.admit(peer("127.0.0.1")).code,
    "read_concurrency_limited",
  );
  for (const result of [...active, next]) result.release();
});

test("client rate state is bounded and only idle refilled identities expire", () => {
  let now = 0;
  const limits = new ReadLimits(
    { ...defaultBoundary, globalPerSecond: 100 },
    () => now,
  );
  for (let i = 0; i < 4096; i++) {
    now += 10;
    const result = limits.admit(peer(`10.0.${i >> 8}.${i & 255}`));
    assert.equal(result.ok, true);
    result.release();
  }
  now += 10;
  assert.equal(limits.admit(peer("203.0.113.1")).status, 429);
  now += 120000;
  const after = limits.admit(peer("203.0.113.1"));
  assert.equal(after.ok, true);
  after.release();
});

test("HTTP overload yields bounded CORS-readable 429s before storage work; journal writes remain available", async (t) => {
  const f = await setup(t);
  let reads = 0;
  const original = f.store.activity.page.bind(f.store.activity);
  const http = await serverFor(t, config, {
    health: () =>
      readHealth(f.store, {
        backup: "verified",
        discovery: "ready",
        scheduling: "ready",
        aiMode: "disabled",
      }),
    activity: (after, limit) => {
      reads++;
      return original(after, limit, "https://testnet.nearblocks.io");
    },
  });
  const calls = f.chain.calls.length,
    loads = f.chain.loads.length;
  const sql = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (query) => {
    assert.match(query.trim(), /^SELECT\b/i);
    return sql(query);
  };
  try {
    const results = [];
    for (let i = 0; i < 35; i++)
      results.push(
        await get(http, "/activity", { headers: { Origin: origin } }),
      );
    const denied = results.filter((r) => r.status === 429);
    assert.ok(denied.length > 0);
    assert.equal(reads, results.filter((r) => r.status === 200).length);
    for (const response of denied) {
      assert.equal(response.headers["access-control-allow-origin"], origin);
      assert.ok(Number(response.headers["retry-after"]) >= 1);
      assert.ok(Buffer.byteLength(response.text) < 128);
    }
    assert.equal(f.chain.calls.length, calls);
    assert.equal(f.chain.loads.length, loads);
  } finally {
    f.store.db.prepare = sql;
  }
  f.store.saveDecision({
    id: "after:flood",
    jobId: f.turn.job_id,
    merchantId: "rex",
    provider: "near-ai",
    model: "fixture-model",
    promptVersion: "fixture",
    action: { method: "hold" },
    reason: "Retain reserves.",
  });
  assert.ok(f.store.getDecision("after:flood"));
  assert.equal(f.store.budget.history().entries.length, 0);
});

test("server transport bounds headers/connections and sanitizes HTTP parser errors", async (t) => {
  const f = await serverFor(t);
  assert.equal(f.server.maxConnections, 64);
  assert.equal(f.server.requestTimeout, 5000);
  assert.equal(f.server.headersTimeout, 5000);
  const response = await new Promise((resolve, reject) => {
    const socket = connect(f.port, "127.0.0.1");
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(raw));
    socket.on("connect", () =>
      socket.end(
        "GET /activity HTTP/1.1\r\nHost: localhost\r\nX-Private: " +
          "PRIVATE_CANARY".repeat(1000) +
          "\r\n\r\n",
      ),
    );
  });
  assert.match(response, /^HTTP\/1.1 400/);
  assert.doesNotMatch(response, /PRIVATE_CANARY/);
  assert.equal(f.calls, 0);
});

test("the handler holds capacity until finish/close, including failed or disconnected responses", async () => {
  const { EventEmitter } = await import("node:events");
  let reads = 0;
  const handler = createReadHandler(
    {
      health: () => ({}),
      activity: () => {
        reads++;
        return {};
      },
    },
    config,
    () => 0,
  );
  class Response extends EventEmitter {
    status = 0;
    setHeader() {}
    writeHead(status) {
      this.status = status;
    }
    end() {}
  }
  const pending = [];
  for (let i = 0; i < 9; i++) {
    const response = new Response();
    handler(
      { ...peer("127.0.0.1"), url: "/activity", method: "GET" },
      response,
    );
    pending.push(response);
  }
  assert.equal(reads, 8);
  assert.equal(pending[8].status, 429);
  pending[0].emit("close");
  pending[0].emit("finish");
  const next = new Response();
  handler({ ...peer("127.0.0.1"), url: "/activity", method: "GET" }, next);
  assert.equal(next.status, 200);
});
