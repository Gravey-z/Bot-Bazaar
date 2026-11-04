import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents: `export * from './apps/web/src/app/depletion-guidance.ts'; export * from './apps/web/src/app/market-reader.ts'; export * from './apps/web/src/app/degraded-states.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const { shortageGuidance, historicalAlternative, MarketFeed, marketNotice } =
  await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
  );
const fixture = JSON.parse(
  await readFile("tests/fixtures/chain/market.json", "utf8"),
);
function state(snapshot = fixture.seed) {
  return {
    status: "ready",
    refreshing: false,
    readFailed: false,
    observation: {
      market: structuredClone(snapshot.market),
      block: {
        hash: snapshot.finalized_block.hash,
        height: snapshot.market.block_height,
        timestampNs: snapshot.market.block_timestamp_ns,
      },
      receivedAt: Number(BigInt(snapshot.market.block_timestamp_ns) / 1000000n),
    },
  };
}
const rex = (value) => value.observation.market.data.merchants[0];

test("normal stock and exactly twelve crystals at four leave the opening guidance hidden", () => {
  const value = state(),
    before = JSON.stringify(value);
  assert.equal(shortageGuidance(value), null);
  assert.equal(JSON.stringify(value), before);
  rex(value).inventory.crystal = "12";
  rex(value).listings[0].quantity = "12";
  assert.equal(shortageGuidance(value), null);
});

test("a well-stocked Rex is distinguished from depletion at the exact shortage threshold", () => {
  const value = state();
  rex(value).inventory.crystal = "16";
  assert.equal(shortageGuidance(value), null);
  rex(value).inventory.crystal = "17";
  assert.equal(shortageGuidance(value).code, "stocked");
  assert.match(shortageGuidance(value).detail, /leave 5/);
  assert.match(shortageGuidance(value).detail, /shortage starts below five/);
  rex(value).inventory.crystal = "100";
  assert.match(shortageGuidance(value).detail, /leave 88/);
});

test("the actual recorded public final state explains Rex's limited crystals without calling the whole market exhausted", () => {
  const value = state(fixture.final),
    original = JSON.stringify(value);
  const result = shortageGuidance(value);
  assert.equal(result.code, "stock");
  assert.match(result.detail, /Rex now owns 7 crystals/);
  assert.match(result.detail, /needs twelve/);
  assert.equal(marketNotice(value), "");
  assert.equal(JSON.stringify(value), original);
  rex(value).inventory.crystal = "0";
  assert.match(shortageGuidance(value).detail, /owns 0 crystals/);
});

test("inactive and insufficient listings stay distinct from inventory depletion", () => {
  const value = state();
  rex(value).listings[0].active = false;
  rex(value).listings[0].quantity = "0";
  assert.equal(shortageGuidance(value).code, "inactive");
  assert.match(
    shortageGuidance(value).detail,
    /inventory is not all available/,
  );
  rex(value).listings[0].active = true;
  rex(value).listings[0].quantity = "11";
  assert.equal(shortageGuidance(value).code, "quantity");
  assert.match(shortageGuidance(value).detail, /lists 11 crystals/);
  assert.equal(rex(value).inventory.crystal, "15");
});

test("changed prices explain the exact opening terms without blocking other current quotes", () => {
  const value = state();
  for (const price of ["1", "5", "100"]) {
    rex(value).listings[0].unit_price = price;
    const result = shortageGuidance(value);
    assert.equal(result.code, "price");
    assert.ok(result.detail.includes(`at ${price} virtual gold each`));
    assert.match(result.detail, /48 gold/);
    assert.match(result.detail, /Other live purchases use their current quote/);
  }
});

test("stale, failed, loading, missing and paused observations never become depletion claims", () => {
  const value = state(fixture.final);
  for (const status of ["stale", "unavailable", "loading"])
    assert.equal(shortageGuidance({ ...value, status }), null);
  assert.equal(shortageGuidance({ ...value, observation: null }), null);
  assert.equal(shortageGuidance({ ...value, readFailed: true }), null);
  value.observation.market.data.paused = true;
  assert.equal(shortageGuidance(value), null);
  assert.match(marketNotice(value), /contract is paused/);
});

test("registration capacity, unrelated resources and other merchants do not imply depleted Rex stock", () => {
  const value = state(),
    market = value.observation.market.data;
  market.registered_player_count = market.limits.max_players;
  assert.equal(shortageGuidance(value), null);
  market.merchants[1].inventory.crystal = "0";
  market.merchants[2].listings.forEach((listing) => {
    listing.active = false;
    listing.quantity = "0";
  });
  rex(value).listings[1].active = false;
  rex(value).listings[1].quantity = "0";
  assert.equal(shortageGuidance(value), null);
  // Missing data must not be invented as zero stock.
  market.merchants = market.merchants.filter(
    (merchant) => merchant.merchant_id !== "rex",
  );
  assert.equal(shortageGuidance(value), null);
});

test("historical guidance never offers an unpublished example as available", () => {
  assert.equal(
    historicalAlternative("available").label,
    "Watch a recorded example",
  );
  assert.match(
    historicalAlternative("available").message,
    /separate from your live progress/,
  );
  assert.match(
    historicalAlternative("empty").message,
    /No verified recording has been published/,
  );
  for (const status of ["empty", "loading", "unavailable"])
    assert.notEqual(
      historicalAlternative(status).label,
      "Watch a recorded example",
    );
  assert.match(
    historicalAlternative("unavailable").message,
    /could not be checked/,
  );
});

test("a changing live feed removes depleted guidance on stale reads and clears it after replenishment", async () => {
  let next = state().observation,
    now = next.receivedAt;
  const feed = new MarketFeed(
    async () => {
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
    () => {},
    () => now,
    { set: () => 1, clear: () => {} },
  );
  feed.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shortageGuidance(feed.state), null);
  next = state(fixture.final).observation;
  now = next.receivedAt;
  await feed.refresh();
  assert.equal(shortageGuidance(feed.state).code, "stock");
  next = new Error("Controlled read outage");
  await feed.refresh();
  assert.equal(feed.state.status, "stale");
  assert.equal(shortageGuidance(feed.state), null);
  next = state(fixture.final).observation;
  next.market.market_revision = "6";
  next.block.height = String(BigInt(next.block.height) + 1n);
  next.market.block_height = next.block.height;
  next.market.data.merchants[0].inventory.crystal = "15";
  next.market.data.merchants[0].listings[0].quantity = "15";
  next.market.data.merchants[0].listings[0].active = true;
  next.market.data.merchants[0].listings[0].unit_price = "4";
  await feed.refresh();
  assert.equal(feed.state.status, "ready");
  assert.equal(shortageGuidance(feed.state), null);
  feed.stop();
});
