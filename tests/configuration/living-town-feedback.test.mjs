import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/app/living-town-feedback.ts'; export {initialTownState} from './apps/web/src/app/living-town-controller.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { TownFeedbackTracker, TownFeedbackSound, initialTownState } =
  await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
  );
const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-upgrade-sandbox.json", "utf8"),
);
const now = 10000;
function state() {
  const shop = structuredClone(capture.baseline.shops[0].shop.data);
  shop.production_slots = "1";
  const ledger = structuredClone(capture.baseline.shops[0].ledger.data);
  return {
    ...structuredClone(initialTownState),
    phase: "ready",
    accountId: shop.owner.account_id,
    observation: {
      accountId: shop.owner.account_id,
      shop,
      player: { shop_id: shop.shop_id },
      ledger,
      town: structuredClone(capture.baseline.town.data),
      listings: [],
      ownListings: [],
      production: { items: [], historyGap: false },
      ownershipKnown: true,
      stale: false,
      receivedAt: now,
      chainTimestampNs: "100",
      source: "chain",
    },
    history: { shopId: shop.shop_id, items: [], stale: false },
  };
}
function advance(s, time = "200") {
  s.observation.chainTimestampNs = time;
  s.observation.ledger.revision = (
    BigInt(s.observation.ledger.revision) + 1n
  ).toString();
}
function sale(s, sequence = "10", timestamp = "150") {
  return {
    event_sequence: sequence,
    kind: "customer_sale",
    item_id: "health_potion",
    quantity: "2",
    gold_amount: "36",
    profit: "12",
    receipt_id: "a".repeat(64),
    log_index: "0",
    block_timestamp_ns: timestamp,
  };
}
function job(s) {
  return {
    ...structuredClone(capture.running.data.items[0]),
    shop_id: s.observation.shop.shop_id,
    owner: s.observation.shop.owner,
    start_at_ns: "90",
    ready_at_ns: "150",
  };
}

test("feedback quietly baselines initial connection and compares exact BigInt gold and stock values", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  const before = s.observation.ledger.gold.held;
  assert.deepEqual(tracker.observe(s, now), []);
  advance(s);
  s.observation.ledger.gold.held = (BigInt(before) - 9n).toString();
  s.observation.ledger.gold.available = (
    BigInt(s.observation.ledger.gold.available) - 9n
  ).toString();
  const stockBefore = s.observation.ledger.inventory.held.herb;
  s.observation.ledger.inventory.held.herb = (
    BigInt(stockBefore) + 3n
  ).toString();
  s.observation.ledger.inventory.available.herb = (
    BigInt(s.observation.ledger.inventory.available.herb) + 3n
  ).toString();
  const frozen = JSON.stringify(s),
    events = tracker.observe(s, now);
  assert.match(
    events.find((e) => e.kind === "gold").text,
    /\(-9\).*not proof of a sale or profit/,
  );
  assert.match(events.find((e) => e.kind === "stock").text, /Herbs:.*\(\+3\)/);
  assert.equal(
    events.some((e) => e.kind === "sale"),
    false,
  );
  assert.equal(JSON.stringify(s), frozen);
  assert.deepEqual(tracker.observe(structuredClone(s), now), []);
});
test("reservation movements show exact available/reserved changes without inventing stock acquisition", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  s.observation.ledger.inventory.held.health_potion = "3";
  s.observation.ledger.inventory.available.health_potion = "3";
  tracker.observe(s, now);
  advance(s);
  s.observation.ledger.inventory.available.health_potion = "1";
  s.observation.ledger.inventory.listing_reserved.health_potion = "2";
  const events = tracker.observe(s, now);
  assert.match(
    events[0].text,
    /available 3 → 1 \(-2\); reserved 0 → 2 \(\+2\)/,
  );
  assert.doesNotMatch(events[0].text, /held|sale/);
});
test("ready notifications require finalized readiness, owner scope and retain exact pinned output", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  s.observation.production.items = [job(s)];
  tracker.observe(s, now);
  assert.deepEqual(tracker.observe(s, now + 20000), []);
  advance(s);
  const events = tracker.observe(s, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "ready");
  assert.ok(
    events[0].text.includes(s.observation.production.items[0].output_quantity),
  );
  assert.match(
    events[0].text,
    /no output is credited until completion confirms/,
  );
  advance(s, "300");
  assert.deepEqual(tracker.observe(s, now), []);
});
test("initially ready and late historical jobs are not replayed as new ready notifications", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  const historical = job(s);
  historical.ready_at_ns = "99";
  s.observation.production.items = [historical];
  tracker.observe(s, now);
  advance(s);
  assert.deepEqual(tracker.observe(s, now), []);
  s.observation.production.items.push({ ...historical, job_id: "999" });
  advance(s, "300");
  assert.deepEqual(tracker.observe(s, now), []);
});
test("only new scoped receipt sales announce; paging, grants, future rows and repeats are safe", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  tracker.observe(s, now);
  s.history.items = [
    sale(s, "1", "50"),
    { ...sale(s, "2"), kind: "player_grant" },
    sale(s, "10", "250"),
  ];
  advance(s);
  assert.deepEqual(tracker.observe(s, now), []);
  s.history.items.push(sale(s, "9"));
  const events = tracker.observe(s, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "sale");
  assert.match(
    events[0].text,
    /2 health_potion for 36 game gold revenue.*profit: 12/,
  );
  assert.deepEqual(tracker.observe(s, now), []);
  advance(s, "300");
  assert.equal(tracker.observe(s, now).length, 1);
  s.history.items = [sale(s, "3", "140")];
  assert.deepEqual(tracker.observe(s, now), []);
});
test("confirmed feed sales match finalized own listings and deduplicate against history and feed replay", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  tracker.observe(s, now);
  advance(s);
  const listing = {
    listing_id: "5",
    shop_id: s.observation.shop.shop_id,
    owner: s.observation.shop.owner,
  };
  const event = {
    type: "sale_confirmed",
    source: "confirmed",
    checkpoint: { block_timestamp_ns: "150" },
    data: {
      listing_id: "5",
      effect_event_sequence: "10",
      receipt_id: "a".repeat(64),
      quantity: "2",
      item_id: "health_potion",
      total_price: "36",
    },
  };
  s.activity.events = [event];
  assert.deepEqual(tracker.observe(s, now), []);
  s.observation.ownListings = [listing];
  assert.equal(tracker.observe(s, now)[0].kind, "sale");
  s.history.items = [sale(s)];
  assert.deepEqual(tracker.observe(s, now), []);
  advance(s, "300");
  assert.deepEqual(tracker.observe(s, now), []);
});
test("upgrade feedback follows confirmed capacity, never wallet success or a pending request", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  tracker.observe(s, now);
  s.pending = { phase: "unknown", call: { method: "purchase_upgrade" } };
  s.lastAttempt = { phase: "confirmed" };
  advance(s);
  assert.deepEqual(tracker.observe(s, now), []);
  s.observation.shop.production_slots = "2";
  advance(s, "300");
  assert.match(
    tracker.observe(s, now)[0].text,
    /1 → 2 slots.*original timing and output/,
  );
});
test("stale, reordered, foreign and reconnect snapshots never replay deltas or historical sale notifications", () => {
  const s = state(),
    tracker = new TownFeedbackTracker();
  tracker.observe(s, now);
  advance(s);
  tracker.observe(s, now);
  s.observation.chainTimestampNs = "150";
  s.observation.shop.production_slots = "2";
  assert.deepEqual(tracker.observe(s, now), []);
  s.observation.stale = true;
  assert.deepEqual(tracker.observe(s, now), []);
  s.observation.stale = false;
  s.observation.chainTimestampNs = "300";
  s.history.items = [sale(s)];
  assert.deepEqual(tracker.observe(s, now), []);
  assert.deepEqual(new TownFeedbackTracker().observe(s, now), []);
  s.accountId = "foreign.testnet";
  assert.deepEqual(tracker.observe(s, now), []);
  s.accountId = s.observation.accountId;
  assert.deepEqual(tracker.observe(s, now), []);
});
function audio() {
  const calls = { tones: 0, volume: 0, closed: 0 };
  const context = {
    state: "suspended",
    currentTime: 1,
    destination: {},
    async resume() {
      this.state = "running";
    },
    async close() {
      calls.closed++;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime(v) {
            calls.volume = v;
          },
        },
        connect() {},
        disconnect() {},
      };
    },
    createOscillator() {
      calls.tones++;
      return {
        frequency: { value: 0 },
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      };
    },
  };
  return { context, calls };
}
test("sound is locally synthesized, explicit opt-in, immediately muted and disposed", async () => {
  const { context, calls } = audio();
  let creates = 0;
  const sound = new TownFeedbackSound(() => {
    creates++;
    return context;
  });
  sound.play();
  assert.equal(creates, 0);
  assert.equal(await sound.enable(), true);
  sound.play();
  assert.equal(calls.tones, 1);
  sound.mute();
  assert.equal(calls.volume, 0);
  sound.play();
  assert.equal(calls.tones, 1);
  assert.equal(await sound.enable(), true);
  sound.dispose();
  assert.equal(calls.closed, 1);
  sound.play();
  assert.equal(calls.tones, 1);
});
test("unavailable audio and mute during async resume cannot change gameplay or enable sound", async () => {
  const failing = new TownFeedbackSound(() => {
    throw Error("unavailable");
  });
  assert.equal(await failing.enable(), false);
  failing.play();
  failing.dispose();
  const { context, calls } = audio();
  let resolve;
  context.resume = () =>
    new Promise((r) => {
      resolve = r;
    });
  const sound = new TownFeedbackSound(() => context),
    pending = sound.enable();
  sound.mute();
  context.state = "running";
  resolve();
  assert.equal(await pending, false);
  sound.play();
  assert.equal(calls.tones, 0);
});
