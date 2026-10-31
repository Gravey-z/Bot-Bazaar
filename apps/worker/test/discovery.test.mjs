import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkerStore } from "../dist/private/storage/database.js";
import { DiscoveryObserver } from "../dist/private/discovery/observer.js";
import { DiscoveryLoop } from "../dist/private/discovery/loop.js";
import { verifyBackup } from "../dist/private/storage/backup.js";
import { captured, fixture } from "./chain-fixture.mjs";
const dropScheduling =
  "DROP TABLE provider_attempts;DROP TABLE retry_state;DROP TABLE scheduler_mutations;DROP TABLE scheduler_turns;DROP TABLE scheduler_sources;DROP TABLE scheduler_inputs;DROP TABLE scheduler_roots;DROP TABLE scheduler_state;";

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "bazaar-discovery-test-"));
  let offers = options.offers;
  let trades = options.trades;
  const chain = fixture({
    state: options.state ?? "seed",
    patch: async (method, params, result) => {
      if (
        params.method_name === "get_offers_for_merchant" ||
        params.method_name === "get_recent_trades"
      ) {
        const args = JSON.parse(
          Buffer.from(params.args_base64, "base64").toString("utf8"),
        );
        const offerView = params.method_name === "get_offers_for_merchant";
        let rows = offerView
          ? (offers ??
            (chain.state.offer.data.kind === "found"
              ? [chain.state.offer.data.offer]
              : []))
          : (trades ?? chain.state.trades.data.items);
        if (offerView)
          rows = rows.filter(
            (row) =>
              [row.buyer, row.seller].includes(args.merchant_id) &&
              (args.status === "all" ||
                (args.status === "pending"
                  ? row.status === "pending"
                  : row.status !== "pending")),
          );
        const key = offerView ? "offer_id" : "trade_id";
        rows = [...rows]
          .sort((a, b) => (BigInt(a[key]) < BigInt(b[key]) ? -1 : 1))
          .filter(
            (row) =>
              args.after_id === null ||
              BigInt(row[key]) > BigInt(args.after_id),
          );
        const items = rows.slice(0, Number(args.limit));
        const watermark =
          chain.state.market.data[
            offerView ? "offers_pruned_through" : "trades_pruned_through"
          ];
        const view = {
          ...chain.state.market,
          data: {
            items,
            next_after_id: items.at(-1)?.[key] ?? args.after_id,
            has_more: rows.length > items.length,
            history_gap:
              BigInt(watermark) > 0n &&
              (args.after_id === null ||
                BigInt(args.after_id) < BigInt(watermark)),
            pruned_through: watermark,
          },
        };
        result = {
          ...result,
          result: Array.from(Buffer.from(JSON.stringify(view))),
        };
      }
      return options.patch
        ? await options.patch(method, params, result)
        : result;
    },
  });
  const storeOptions = {
    dataDir: root,
    identity: chain.identity,
    policyVersion: "v1",
    create: true,
  };
  let store = new WorkerStore(storeOptions),
    observer = new DiscoveryObserver(chain.client, store);
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    chain,
    storeOptions,
    get store() {
      return store;
    },
    get observer() {
      return observer;
    },
    setOffers(value) {
      offers = value;
    },
    setTrades(value) {
      trades = value;
    },
    async reopen() {
      await store.close();
      store = new WorkerStore({ ...storeOptions, create: false });
      observer = new DiscoveryObserver(chain.client, store);
    },
  };
}
const offer = () => structuredClone(captured.pending.offer.data.offer);
const purchase = () => structuredClone(captured.steps[1].result.data);
function advance(f, timestamp) {
  const state = f.chain.state;
  state.finalized_block.height += 1;
  state.finalized_block.hash = "11111111111111111111111111111111";
  state.finalized_block.timestamp_ns = timestamp;
  state.contract_account.block_height = state.finalized_block.height;
  state.contract_account.block_hash = state.finalized_block.hash;
  state.market.block_height = String(state.finalized_block.height);
  state.market.block_timestamp_ns = timestamp;
}

test("a new proposal wakes its stored counterparty before any merchant trade settles", async (t) => {
  const f = await setup(t);
  await f.observer.poll();
  assert.deepEqual(f.store.discoverySignals(), []);
  Object.assign(f.chain.state, structuredClone(captured.pending));
  const state = await f.observer.poll(),
    signals = f.store.discoverySignals();
  const wake = signals.find((row) => row.kind === "offer_pending");
  assert.equal(wake.merchantId, "luna");
  assert.equal(wake.offer.offer_id, "1");
  assert.equal(
    state.trades.some((row) => row.kind === "merchant_trade"),
    false,
  );
  assert.equal(f.store.checkpoint().observed_revision, "4");
  assert.equal(f.chain.loads.length, 0);
  assert.equal(
    f.chain.calls.some((row) => ["send_tx", "tx"].includes(row.method)),
    false,
  );
});

test("unchanged revisions and restart retain one wake identity and never create jobs", async (t) => {
  const f = await setup(t, { state: "pending" });
  await f.observer.poll();
  const first = f.store.discoverySignals();
  await f.observer.poll();
  await f.reopen();
  await f.observer.poll();
  assert.deepEqual(f.store.discoverySignals(), first);
  assert.deepEqual(f.store.jobs(), []);
  assert.equal(f.store.checkpoint().recovery_required, 1);
});

test("all pages are pinned and complete; duplicated participant offers produce one wake", async (t) => {
  const rows = Array.from({ length: 102 }, (_, i) => ({
    ...structuredClone(captured.final.offer.data.offer),
    offer_id: String(i + 1),
  }));
  rows.push({ ...offer(), offer_id: "103" });
  const f = await setup(t, { state: "pending", offers: rows });
  f.chain.state.market.data.next_offer_id = "104";
  const state = await f.observer.poll();
  assert.equal(state.offers.length, 103);
  assert.equal(
    f.store.discoverySignals().filter((row) => row.kind === "offer_pending")
      .length,
    1,
  );
  const queries = f.chain.calls.filter((row) => row.method === "query");
  assert.ok(queries.every((row) => row.params.block_id === state.block.hash));
  const rex = queries
    .filter((row) => row.params.method_name === "get_offers_for_merchant")
    .map((row) =>
      JSON.parse(Buffer.from(row.params.args_base64, "base64").toString()),
    )
    .filter((args) => args.merchant_id === "rex" && args.status === "all");
  assert.deepEqual(
    rex.map((row) => row.after_id),
    [null, "50", "100"],
  );
});

test("offer pruning gaps refresh authoritative state and retain old live offers below the watermark", async (t) => {
  const live = { ...offer(), offer_id: "1" };
  const f = await setup(t, { state: "pending", offers: [live] });
  f.chain.state.market.data.offers_pruned_through = "20";
  f.chain.state.market.data.next_offer_id = "22";
  const state = await f.observer.poll();
  assert.equal(state.mode, "resync");
  assert.equal(state.offers[0].offer_id, "1");
  assert.ok(
    f.store.discoverySignals().some((row) => row.kind === "offer_pending"),
  );
  const first = f.store
    .discoverySignals()
    .filter((row) => row.kind === "history_gap");
  assert.equal(first.length, 1);
  await f.observer.poll();
  assert.deepEqual(
    f.store.discoverySignals().filter((row) => row.kind === "history_gap"),
    first,
  );
  assert.ok(
    f.chain.calls.filter((row) => row.params.method_name === "get_market_state")
      .length >= 3,
  );
});

test("trade cursor gaps restart retained history and preserve an explicit missing-interval signal", async (t) => {
  const f = await setup(t, { state: "pending" });
  await f.observer.poll();
  const trades = Array.from({ length: 100 }, (_, i) => ({
    ...purchase(),
    trade_id: String(i + 51),
  }));
  f.setTrades(trades);
  advance(
    f,
    (BigInt(f.chain.state.finalized_block.timestamp_ns) + 1n).toString(),
  );
  f.chain.state.market.market_revision = "200";
  f.chain.state.market.data.next_trade_id = "151";
  f.chain.state.market.data.trades_pruned_through = "50";
  const state = await f.observer.poll();
  assert.equal(state.mode, "resync");
  assert.equal(state.trades.length, 100);
  assert.equal(state.tradeCursor, "150");
  const gap = f.store
    .discoverySignals()
    .find((row) => row.kind === "history_gap");
  assert.equal(gap.stream, "trades");
  assert.equal(gap.after, "1");
  assert.equal(gap.prunedThrough, "50");
  const count = f.store.discoverySignals().length;
  await f.observer.poll();
  assert.equal(f.store.discoverySignals().length, count);
});

test("chain-time expiry is discovered without a revision change and never releases workflow locks", async (t) => {
  const f = await setup(t, { state: "pending" });
  await f.observer.poll();
  const now = Date.now();
  f.store.enqueue({
    id: "job",
    triggerKey: "test:job",
    triggerRef: "offer:1",
    deadline: now + 120000,
  });
  f.store.activateJob("job");
  f.store.claimLocks("job", ["rex", "luna"], "commitment");
  f.store.putOffer({
    id: "1",
    jobId: "job",
    status: "pending",
    expiresAtNs: offer().expires_at_ns,
    cleanupAck: false,
  });
  const expired = {
    ...offer(),
    status: "expired",
    closed_at_ns: offer().expires_at_ns,
  };
  f.setOffers([expired]);
  advance(f, (BigInt(expired.expires_at_ns) + 1n).toString());
  const state = await f.observer.poll();
  assert.equal(state.market.market_revision, "4");
  assert.equal(state.offers[0].status, "expired");
  assert.equal(f.store.offers()[0].cleanup_ack, 0);
  assert.equal(f.store.locks().length, 2);
  assert.throws(() => f.store.releaseLocks("job", "commitment"));
});

for (const [name, patch] of [
  [
    "wrong network",
    (method, _params, result) =>
      method === "status" ? { ...result, chain_id: "mainnet" } : result,
  ],
  [
    "wrong deployment code",
    (_method, params, result) =>
      params.request_type === "view_account"
        ? { ...result, code_hash: "11111111111111111111111111111111" }
        : result,
  ],
  [
    "unavailable pinned read",
    (_method, params, result) => {
      if (params.method_name === "get_offers_for_merchant")
        throw new Error("UNKNOWN_BLOCK secret-canary");
      return result;
    },
  ],
  [
    "page at another block",
    (_method, params, result) =>
      params.method_name === "get_offers_for_merchant"
        ? { ...result, block_hash: "11111111111111111111111111111111" }
        : result,
  ],
  [
    "contradictory pending filter",
    (_method, params, result) => {
      if (params.method_name !== "get_offers_for_merchant") return result;
      const args = JSON.parse(
        Buffer.from(params.args_base64, "base64").toString(),
      );
      if (args.status !== "pending") return result;
      const view = JSON.parse(Buffer.from(result.result).toString());
      view.data.items = [];
      view.data.next_after_id = null;
      return {
        ...result,
        result: Array.from(Buffer.from(JSON.stringify(view))),
      };
    },
  ],
])
  test(`failed discovery ${name} commits no partial cursor or wake signals`, async (t) => {
    const f = await setup(t, { state: "pending", patch });
    await assert.rejects(f.observer.poll());
    assert.equal(f.store.discoveryState(), null);
    assert.deepEqual(f.store.discoverySignals(), []);
    assert.equal(f.store.checkpoint().observed_revision, null);
  });

test("inbox saturation rolls back the entire observation instead of advancing past missing work", async (t) => {
  const f = await setup(t, { state: "pending" });
  await f.observer.poll();
  const before = f.store.discoveryState();
  // Fill with existing durable signals to simulate scheduler backpressure.
  const statement = f.store.db.prepare(
    "INSERT INTO discovery_signals(signal_key,kind,merchant_id,payload_json,observed_at) VALUES(?,'history_gap',NULL,'{}',0)",
  );
  const count = f.store.discoverySignals().length;
  for (let i = count; i < 256; i++) statement.run(`filler:${i}`);
  Object.assign(f.chain.state, structuredClone(captured.final));
  f.setOffers([{ ...offer(), offer_id: "2" }]);
  f.chain.state.market.data.next_offer_id = "3";
  await assert.rejects(f.observer.poll());
  assert.deepEqual(f.store.discoveryState(), before);
});

test("aborted observations cannot commit late responses", async (t) => {
  const abort = new AbortController();
  const f = await setup(t, {
    state: "pending",
    patch: (_method, params, result) => {
      if (params.method_name === "get_recent_trades") abort.abort();
      return result;
    },
  });
  await assert.rejects(f.observer.poll(abort.signal));
  assert.equal(f.store.discoveryState(), null);
});

test("loop serializes polls, reports sanitized failure and stops without a late commit", async () => {
  let active = 0,
    maximum = 0,
    calls = 0,
    errors = 0;
  const observer = {
    async poll(signal) {
      active++;
      maximum = Math.max(maximum, active);
      calls++;
      try {
        await delay(5);
        signal.throwIfAborted();
        if (calls === 1) throw new Error("secret-canary");
      } finally {
        active--;
      }
    },
  };
  const loop = new DiscoveryLoop(
    observer,
    () => {
      errors++;
    },
    2,
  );
  loop.start();
  loop.start();
  try {
    for (let i = 0; i < 100 && calls < 3; i++) await delay(2);
    assert.ok(calls >= 3);
    assert.equal(maximum, 1);
    assert.equal(errors, 1);
  } finally {
    await loop.stop();
  }
  const stopped = calls;
  await delay(10);
  assert.equal(calls, stopped);
  assert.equal(loop.status, "stopped");
});

test("v1 migration preserves jobs/locks with a verifiable pre-migration snapshot", async (t) => {
  const f = await setup(t);
  const now = Date.now();
  f.store.enqueue({
    id: "kept",
    triggerKey: "trade:old",
    triggerRef: "trade:1",
    deadline: now + 120000,
  });
  f.store.activateJob("kept");
  f.store.claimLocks("kept", ["rex"], "controller");
  await f.store.close();
  const db = new DatabaseSync(join(f.root, "worker.sqlite"));
  db.exec(
    dropScheduling +
      "DROP TABLE discovery_signals; DROP TABLE discovery_state; PRAGMA user_version=1;",
  );
  db.close();
  await f.reopen();
  assert.equal(f.store.getJob("kept").status, "active");
  assert.equal(f.store.locks().length, 1);
  const backupRoot = join(f.root, "backups");
  const names = await readdir(backupRoot);
  assert.equal(names.length, 1);
  const manifest = await verifyBackup(join(backupRoot, names[0]));
  assert.equal(manifest.schema, 1);
  assert.equal(f.store.discoveryState(), null);
  assert.equal(f.store.checkpoint().recovery_required, 1);
  await f.reopen();
  assert.equal((await readdir(backupRoot)).length, 1);
});

test("an unreported missing retained trade cannot advance the cursor", async (t) => {
  const f = await setup(t, {
    state: "pending",
    trades: [{ ...purchase(), trade_id: "2" }],
  });
  f.chain.state.market.data.next_trade_id = "3";
  await assert.rejects(f.observer.poll(), /missing retained/);
  assert.equal(f.store.discoveryState(), null);
});

test("failed refresh preserves the last complete observation and resumes from a new pinned pass", async (t) => {
  let fail = false;
  const f = await setup(t, {
    state: "pending",
    patch: (_method, params, result) => {
      if (fail && params.method_name === "get_offers_for_merchant")
        throw new Error("unavailable");
      return result;
    },
  });
  await f.observer.poll();
  const before = f.store.discoveryState(),
    signals = f.store.discoverySignals();
  Object.assign(f.chain.state, structuredClone(captured.final));
  fail = true;
  await assert.rejects(f.observer.poll());
  assert.deepEqual(f.store.discoveryState(), before);
  assert.deepEqual(f.store.discoverySignals(), signals);
  fail = false;
  const after = await f.observer.poll();
  assert.equal(after.market.market_revision, "5");
  assert.equal(after.tradeCursor, "2");
});

test("failed pre-migration backup leaves the v1 database and its jobs intact", async (t) => {
  const f = await setup(t);
  const now = Date.now();
  f.store.enqueue({
    id: "kept",
    triggerKey: "kept",
    triggerRef: "old",
    deadline: now + 120000,
  });
  await f.store.close();
  let db = new DatabaseSync(join(f.root, "worker.sqlite"));
  db.exec(
    dropScheduling +
      "DROP TABLE discovery_signals; DROP TABLE discovery_state; PRAGMA user_version=1;",
  );
  db.close();
  const blocked = join(f.root, "not-a-directory");
  await writeFile(blocked, "existing");
  assert.throws(
    () =>
      new WorkerStore({ ...f.storeOptions, backupDir: blocked, create: false }),
  );
  db = new DatabaseSync(join(f.root, "worker.sqlite"));
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(db.prepare("SELECT id FROM jobs").get().id, "kept");
  } finally {
    db.close();
  }
});
