import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createReadServer } from "../dist/private/read-api/server.js";
import { LivingTownStreams } from "../dist/private/read-api/streams.js";
import { readLivingTownHealth } from "../dist/private/living-town/health.js";
import {
  projectionFixture,
  agent,
  basicRecords,
  final,
} from "./fixtures/living-town-feed.mjs";
const origin = "http://127.0.0.1:4201";
async function server(t, store, trusted = false) {
  const s = createReadServer(
    {
      health: () => readLivingTownHealth(store),
      activity: () => {
        throw Error("unused V1 feed");
      },
      livingTown: {
        town: () => store.town(),
        shop: () => null,
        inventory: () => null,
        production: () => null,
        events: (a, n) => store.events(a, n),
      },
    },
    {
      allowedOrigins: [origin],
      trustedProxyIps: trusted ? ["127.0.0.1"] : [],
      clientPerMinute: 600,
      globalPerSecond: 100,
    },
  );
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(() => new Promise((resolve) => s.close(resolve)));
  return { s, url: `http://127.0.0.1:${s.address().port}` };
}
async function stream(t, url, headers = {}) {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 12000);
  t.after(() => {
    clearTimeout(timer);
    abort.abort();
  });
  const response = await fetch(url, {
    headers: { Origin: origin, ...headers },
    signal: abort.signal,
  });
  if (response.status !== 200) return { response, abort };
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  const queue = [];
  return {
    response,
    abort,
    async next(type) {
      while (true) {
        while (queue.length) {
          const frame = queue.shift(),
            kind = /^event: (.+)$/m.exec(frame)?.[1];
          if (!type || kind === type)
            return {
              kind,
              id: /^id: (.+)$/m.exec(frame)?.[1],
              data: /^data: (.+)$/m.exec(frame)?.[1],
              raw: frame,
            };
        }
        const r = await reader.read();
        if (r.done) return null;
        buffer += decoder.decode(r.value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          queue.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    },
  };
}
test("real SSE resumes with Last-Event-ID and broadcasts only durable projection outcomes; close releases open streams", async (t) => {
  const f = projectionFixture(t),
    { s, url } = await server(t, f.store),
    a = agent();
  f.store.agentActivity([a]);
  const first = f.store.events().events[0];
  const live = await stream(t, url + "/api/events/stream", {
    "Last-Event-ID": first.cursor,
  });
  assert.equal(
    live.response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(
    live.response.headers.get("access-control-allow-origin"),
    origin,
  );
  await live.next("ready");
  const sale = basicRecords.find(
    (r) =>
      r.status.kind === "succeeded" &&
      r.status.result.data.outcome.kind === "raw_purchased",
  );
  f.store.commit(sale);
  assert.equal(f.store.events(first.cursor).events.length, 0);
  f.store.baseline(final, Date.now(), true);
  const frame = await live.next("sale_confirmed");
  assert.equal(
    JSON.parse(frame.data).data.transaction_hash,
    sale.proof.transactionHash,
  );
  live.abort.abort();
  const again = await stream(t, url + "/api/events/stream", {
    "Last-Event-ID": frame.id,
  });
  await again.next("ready");
  assert.equal(f.store.events(frame.id).events.length, 0);
  await new Promise((resolve) => s.close(resolve));
});
test("SSE keeps exact CORS/read boundaries, rejects ambiguous cursors, supports preflight and limits concurrent connections", async (t) => {
  const f = projectionFixture(t),
    { url } = await server(t, f.store),
    cursor = f.store.events().next_cursor;
  for (const [path, options, status] of [
    [
      "/api/events/stream",
      { headers: { Origin: "https://blocked.invalid" } },
      403,
    ],
    ["/api/events/stream?limit=1", {}, 400],
    [
      "/api/events/stream?after=" + cursor,
      { headers: { "Last-Event-ID": "other" } },
      400,
    ],
    ["/api/events/stream", { method: "POST" }, 405],
    ["/api/events/stream", { headers: { "Last-Event-ID": "bad" } }, 400],
  ]) {
    const r = await fetch(url + path, options);
    assert.equal(r.status, status);
    await r.arrayBuffer();
  }
  const preflight = await fetch(url + "/api/events/stream", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "last-event-id, accept",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers.get("access-control-allow-headers"),
    /Last-Event-ID/,
  );
  const one = await stream(t, url + "/api/events/stream"),
    two = await stream(t, url + "/api/events/stream");
  await one.next("ready");
  await two.next("ready");
  const third = await stream(t, url + "/api/events/stream");
  assert.equal(third.response.status, 503);
  assert.equal((await third.response.json()).error, "stream_capacity");
  one.abort.abort();
  two.abort.abort();
});
test("heartbeat, connection expiry and server shutdown are bounded without a pending economic broadcast", async (t) => {
  const f = projectionFixture(t),
    hub = new LivingTownStreams(10, 25, 120),
    s = createServer((req, res) =>
      hub.open(req, res, (a, n) => f.store.events(a, n), null),
    );
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => s.close(resolve));
  });
  const live = await stream(t, `http://127.0.0.1:${s.address().port}/`);
  await live.next("ready");
  let heartbeat = false,
    frame;
  while ((frame = await live.next()))
    if (frame.raw.includes("heartbeat")) heartbeat = true;
  assert(heartbeat);
});
test("a stream reports generation reset and shuts down instead of silently skipping invalidated history", async (t) => {
  const f = projectionFixture(t),
    { url } = await server(t, f.store),
    live = await stream(t, url + "/api/events/stream");
  await live.next("ready");
  f.store.baseline(final);
  const reset = await live.next("reset");
  assert.equal(JSON.parse(reset.data).reset_required, true);
  assert.equal(await live.next(), null);
});

test("the global SSE cap applies across trusted-proxy client addresses and shutdown releases every connection", async (t) => {
  const f = projectionFixture(t),
    { s, url } = await server(t, f.store, true),
    connections = [];
  for (let n = 1; n <= 16; n++) {
    const live = await stream(t, url + "/api/events/stream", {
      "X-Forwarded-For": `10.0.0.${n}`,
    });
    assert.equal(live.response.status, 200);
    await live.next("ready");
    connections.push(live);
  }
  const town = await fetch(url + "/api/town", {
    headers: { "X-Forwarded-For": "10.0.0.99" },
  });
  assert.equal(town.status, 200);
  await town.arrayBuffer();
  const refused = await stream(t, url + "/api/events/stream", {
    "X-Forwarded-For": "10.0.0.17",
  });
  assert.equal(refused.response.status, 503);
  await new Promise((resolve) => s.close(resolve));
  for (const live of connections) assert.equal(await live.next(), null);
});

test("HTTP polling and initial SSE both report an expired cursor as an explicit retention gap", async (t) => {
  const f = projectionFixture(t),
    old = f.store.events().next_cursor;
  for (let base = 0; base < 260; base += 100) {
    const records = [];
    for (let n = base + 1; n <= Math.min(base + 100, 260); n++) {
      const a = agent();
      a.data.action_id = n.toString(16).padStart(64, "0");
      records.push(a);
    }
    f.store.agentActivity(records);
  }
  const { url } = await server(t, f.store);
  for (const path of ["/api/events", "/api/events/stream"]) {
    const r = await fetch(url + path + "?after=" + old);
    assert.equal(r.status, 410);
    assert.deepEqual(await r.json(), {
      error: "feed_retention_gap",
      reset_required: true,
    });
  }
});
