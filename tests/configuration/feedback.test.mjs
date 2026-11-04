import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";

const output = await build({
  entryPoints: ["apps/web/src/app/market-feedback.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const { SnapshotFeedback, CompletionFeedback } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
);
const fixture = JSON.parse(
  await readFile("tests/fixtures/chain/market.json", "utf8"),
);
function snapshot() {
  return {
    status: "ready",
    refreshing: false,
    readFailed: false,
    observation: {
      block: {
        hash: fixture.seed.finalized_block.hash,
        height: fixture.seed.market.block_height,
        timestampNs: fixture.seed.market.block_timestamp_ns,
      },
      market: structuredClone(fixture.seed.market),
      receivedAt: 1000,
    },
  };
}
function next(state) {
  const copy = structuredClone(state);
  copy.observation.block.hash = "B".repeat(44);
  copy.observation.block.height = (
    BigInt(copy.observation.block.height) + 1n
  ).toString();
  copy.observation.market.market_revision = (
    BigInt(copy.observation.market.market_revision) + 1n
  ).toString();
  return copy;
}
const row = (id, time, fields = {}) => ({
  id: `trade:${id}`,
  status: "confirmed",
  time,
  deltas: ["buyer +4", "seller −4"],
  ...fields,
});
const feed = (rows = [], fields = {}) => ({
  rows,
  chainStatus: "ready",
  hasMore: false,
  historyGap: false,
  workerGeneration: "first",
  ...fields,
});

test("first snapshot and unchanged reads do not animate initial history", () => {
  const feedback = new SnapshotFeedback(),
    state = snapshot();
  assert.deepEqual(feedback.accept(state), []);
  assert.equal(feedback.accept(state), null);
  assert.equal(feedback.accept(next(state)), null);
});

test("finalized inventory, listing, gold and price changes retain exact signed terms", () => {
  const feedback = new SnapshotFeedback(),
    state = snapshot();
  feedback.accept(state);
  const changed = next(state),
    rex = changed.observation.market.data.merchants.find(
      (merchant) => merchant.merchant_id === "rex",
    );
  const prior = state.observation.market.data.merchants.find(
    (merchant) => merchant.merchant_id === "rex",
  );
  rex.inventory.crystal = (BigInt(rex.inventory.crystal) + 4n).toString();
  rex.gold = (BigInt(rex.gold) - 24n).toString();
  const listing = rex.listings.find((item) => item.resource === "crystal");
  listing.quantity = (BigInt(listing.quantity) + 3n).toString();
  listing.unit_price = (BigInt(listing.unit_price) + 1n).toString();
  listing.active = false;
  const changes = feedback.accept(changed);
  assert.ok(
    changes.some(
      (item) =>
        item.key === "rex:crystal:inventory" &&
        item.text === "crystal inventory +4",
    ),
  );
  assert.ok(changes.some((item) => item.text === "Virtual gold −24"));
  assert.ok(changes.some((item) => item.text === "crystal listed stock +3"));
  assert.ok(
    changes.some(
      (item) =>
        item.text ===
        `crystal stored price ${prior.listings.find((item) => item.resource === "crystal").unit_price} → ${listing.unit_price} gold`,
    ),
  );
  assert.ok(
    changes.some((item) => item.text === "crystal listing deactivated"),
  );
  assert.equal(feedback.accept(changed), null);
});

test("reader-owned mutation cannot rewrite the comparison baseline", () => {
  const feedback = new SnapshotFeedback(),
    state = snapshot();
  feedback.accept(state);
  const rex = state.observation.market.data.merchants[0];
  rex.gold = (BigInt(rex.gold) + 1n).toString();
  assert.ok(
    feedback
      .accept(next(state))
      .some((item) => item.text === "Virtual gold +1"),
  );
});

test("stale reads, hidden-tab reset and changed deployments rebase without effects", () => {
  const feedback = new SnapshotFeedback(),
    state = snapshot(),
    changed = next(state);
  changed.observation.market.data.merchants[0].gold = "1";
  feedback.accept(state);
  assert.deepEqual(feedback.accept({ ...state, status: "stale" }), []);
  assert.deepEqual(feedback.accept(changed), []);
  feedback.reset();
  assert.deepEqual(feedback.accept(state), []);
  feedback.reset(state.observation);
  assert.equal(feedback.accept(state), null);
  assert.deepEqual(feedback.accept(next(state)), []);
  changed.observation.market.data.contract_account_id = "other.testnet";
  assert.deepEqual(feedback.accept(changed), []);
});

test("regressed snapshots do not animate or replace the comparison baseline", () => {
  const feedback = new SnapshotFeedback(),
    state = snapshot();
  feedback.accept(next(state));
  state.observation.market.data.merchants[0].gold = "1";
  assert.deepEqual(feedback.accept(state), []);
});

test("only a newly observed confirmed transfer receives completion feedback, once", () => {
  const feedback = new CompletionFeedback();
  assert.deepEqual(feedback.accept(feed([row("1", 500)]), 1000), []);
  const current = feed([
    row("1", 500),
    row("2", 1500),
    row("3", 1500, { status: "submitted" }),
    row("4", 1500, { deltas: [] }),
  ]);
  assert.deepEqual(feedback.accept(current, 2000), ["trade:2"]);
  assert.deepEqual(feedback.accept(current, 2001), []);
});

test("multiple fresh confirmations use lossless IDs despite timestamp ordering", () => {
  const feedback = new CompletionFeedback();
  feedback.accept(feed([row("9007199254740992", 500)]), 1000);
  assert.deepEqual(
    feedback.accept(
      feed([row("9007199254740994", 1500), row("9007199254740993", 1501)]),
      2000,
    ),
    ["trade:9007199254740994", "trade:9007199254740993"],
  );
});

test("old pages, duplicate evidence and future timestamps cannot act like new trades", () => {
  const feedback = new CompletionFeedback();
  feedback.accept(feed(), 1000);
  assert.deepEqual(
    feedback.accept(feed([row("1", 500), row("2", 3000)]), 2000),
    [],
  );
  assert.deepEqual(feedback.accept(feed([row("2", 3000)]), 4000), []);
  assert.deepEqual(feedback.accept(feed([row("3", 1500)]), 20000), []);
});

test("pagination, retention gaps, stale reads and restored generations suppress historical completions", () => {
  for (const fields of [
    { hasMore: true },
    { historyGap: true },
    { chainStatus: "stale" },
  ]) {
    const feedback = new CompletionFeedback();
    feedback.accept(feed(), 1000);
    assert.deepEqual(feedback.accept(feed([row("1", 1500)], fields), 2000), []);
    assert.deepEqual(feedback.accept(feed([row("1", 1500)]), 3000), []);
  }
  const feedback = new CompletionFeedback();
  feedback.accept(feed(), 1000);
  assert.deepEqual(
    feedback.accept(
      feed([row("1", 1500)], { workerGeneration: "restored" }),
      2000,
    ),
    [],
  );
  feedback.reset();
  assert.deepEqual(feedback.accept(feed([row("1", 1500)]), 3000), []);
});

test("clock rollback cannot replay a completion", () => {
  const feedback = new CompletionFeedback();
  feedback.accept(feed(), 2000);
  assert.deepEqual(feedback.accept(feed([row("1", 500)]), 1000), []);
  assert.deepEqual(feedback.accept(feed([row("1", 500)]), 3000), []);
});
