import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const output = await build({
  stdin: {
    contents: "export * from './apps/web/src/app/living-town-live.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { LivingTownLiveFeed, TownActivityReset, townActivityText } =
  await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString("base64")}`
  );
const captured = JSON.parse(
    readFileSync(
      "tests/fixtures/chain/living-town-market-event-sandbox.json",
      "utf8",
    ),
  ),
  s = captured.steps[0],
  identity = {
    deployment: s.foundation.deployment,
    codeHash: s.account.code_hash,
  };
const cursor = (n, g = "fixture-generation") =>
  Buffer.from(
    JSON.stringify({ generation: g, identity: "c".repeat(64), sequence: n }),
  ).toString("base64url");
const event = (n) => ({
  event_id: n.toString(16).padStart(64, "0"),
  type: "production_ready",
  source: "production_ready_hint",
  checkpoint: {
    block_hash: s.block.header.hash,
    block_height: String(s.block.header.height),
    block_timestamp_ns: s.block.header.timestamp_nanosec,
    market_revision: "1",
    event_sequence: "1",
  },
  data: {
    job_id: String(n),
    shop_id: "4",
    recipe_id: "health_potion",
    ready_at_ns: "1",
  },
});
const page = (
  events = [],
  g = "fixture-generation",
  n = events.at(-1) ?? 0,
) => ({
  schema: "living-town-activity-v1",
  deployment: identity.deployment,
  code_hash: identity.codeHash,
  feed_generation: g,
  events: events.map((i) => ({ cursor: cursor(i, g), event: event(i) })),
  next_cursor: cursor(n, g),
  has_more: false,
});
class Source extends EventTarget {
  closed = false;
  onerror = null;
  close() {
    this.closed = true;
  }
  send(type, data, id = "") {
    this.dispatchEvent(
      new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }),
    );
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
}
const until = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await delay(5);
  }
  assert.fail("timed out waiting for controlled feed");
};
test("browser validates identity, resumes from its last delivered cursor and falls back to polling without duplicate rows", async (t) => {
  const sources = [],
    states = [],
    reads = [];
  let available = [1],
    time = 0;
  const feed = new LivingTownLiveFeed(
    identity,
    "http://127.0.0.1:3011/api/events/stream",
    async (after) => {
      reads.push(after);
      return page(available);
    },
    (state) => states.push(state),
    (url) => {
      const source = new Source();
      source.url = url;
      sources.push(source);
      return source;
    },
    () => time,
    20,
  );
  t.after(() => feed.stop());
  feed.start();
  await until(() => sources.length === 1);
  assert.equal(new URL(sources[0].url).searchParams.get("after"), cursor(1));
  sources[0].send("ready", page([], undefined, 1));
  await until(() => states.at(-1).mode === "live");
  sources[0].send("production_ready", event(2), cursor(2));
  sources[0].send("production_ready", event(2), cursor(2));
  assert.equal(states.at(-1).events.length, 2);
  available = [2, 3];
  sources[0].fail();
  await until(() => states.at(-1).events.length === 3);
  assert.equal(states.at(-1).mode, "polling");
  assert(sources[0].closed);
  assert(reads.includes(cursor(2)));
  sources[0].send("production_ready", event(99), cursor(99));
  assert.equal(states.at(-1).events.length, 3);
  time = 31000;
  await until(() => sources.length === 2);
  assert.equal(new URL(sources[1].url).searchParams.get("after"), cursor(3));
});
test("an explicit retention gap resets the cursor, reports missing history and keeps confirmed rows deduplicated", async (t) => {
  let calls = 0;
  const states = [],
    reads = [];
  const feed = new LivingTownLiveFeed(
    identity,
    "http://127.0.0.1:3011/api/events/stream",
    async (after) => {
      reads.push(after);
      calls++;
      if (calls === 2) throw new TownActivityReset();
      return calls < 2 ? page([1]) : page([1, 2], "next-generation");
    },
    (v) => states.push(v),
    () => {
      throw Error("SSE unavailable in this fixture");
    },
    () => 0,
    20,
  );
  t.after(() => feed.stop());
  feed.start();
  await until(() => states.at(-1)?.events.length === 2);
  assert.equal(states.at(-1).gap, true);
  assert.equal(reads[2], null);
  assert.deepEqual(
    states.at(-1).events.map((e) => e.data.job_id),
    ["2", "1"],
  );
});
test("malformed, wrong-generation and fake-confirmation stream frames never advance activity or request a wallet", async (t) => {
  const sources = [],
    states = [],
    reads = [];
  const feed = new LivingTownLiveFeed(
    identity,
    "http://127.0.0.1:3011/api/events/stream",
    async (after) => {
      reads.push(after);
      return page([1]);
    },
    (v) => states.push(v),
    () => {
      const source = new Source();
      sources.push(source);
      return source;
    },
    () => 0,
    20,
  );
  t.after(() => feed.stop());
  feed.start();
  await until(() => sources.length === 1);
  sources[0].send("ready", page([], undefined, 1));
  sources[0].send(
    "production_ready",
    {
      ...event(2),
      source: "confirmed",
      data: { ...event(2).data, transaction_hash: s.transaction_hash },
    },
    cursor(2),
  );
  assert(sources[0].closed);
  assert.equal(states.at(-1).events.length, 1);
  await until(() => reads.length >= 2);
  assert.equal(reads[1], cursor(1));
  assert.match(townActivityText(event(1)), /not a completed claim/);
});
test("stopping aborts pending polling, closes the stream and ignores late results", async () => {
  const states = [];
  let release, signal;
  const feed = new LivingTownLiveFeed(
    identity,
    "http://127.0.0.1:3011/api/events/stream",
    async (_after, s) => {
      signal = s;
      return new Promise((r) => {
        release = r;
      });
    },
    (s) => states.push(s),
    () => new Source(),
    () => 0,
    20,
  );
  feed.start();
  await until(() => release);
  feed.stop();
  const count = states.length;
  assert(signal.aborted);
  release(page([1]));
  await delay(30);
  assert.equal(states.length, count);
});
test("a response from another deployment or artifact remains unavailable instead of mixing town activity", async (t) => {
  const states = [];
  const feed = new LivingTownLiveFeed(
    identity,
    "http://127.0.0.1:3011/api/events/stream",
    async () => ({ ...page([1]), code_hash: identity.deployment.genesis_hash }),
    (s) => states.push(s),
    () => new Source(),
    () => 0,
    20,
  );
  t.after(() => feed.stop());
  feed.start();
  await until(() => states.at(-1)?.mode === "unavailable");
  assert.equal(states.at(-1).events.length, 0);
});
