import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["apps/web/src/app/market-reader.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const { createMarketReader, MarketFeed, formatMarketAmount } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/chain/market.json", import.meta.url),
    "utf8",
  ),
);
const seed = fixture.seed;
const baseTime = Number(BigInt(seed.finalized_block.timestamp_ns) / 1000000n);
function observation() {
  return {
    block: {
      hash: seed.finalized_block.hash,
      height: String(seed.finalized_block.height),
      timestampNs: seed.finalized_block.timestamp_ns,
    },
    market: structuredClone(seed.market),
    receivedAt: baseTime + 1000,
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(read) {
  let clock = baseTime + 1000;
  let sequence = 0;
  const scheduled = new Map();
  const feed = new MarketFeed(
    read,
    () => {},
    () => clock,
    {
      set(callback, delay) {
        const id = ++sequence;
        scheduled.set(id, { callback, due: clock + delay });
        return id;
      },
      clear(id) {
        scheduled.delete(id);
      },
    },
  );
  return {
    feed,
    scheduled,
    async advance(milliseconds) {
      clock += milliseconds;
      for (const [id, item] of [...scheduled]) {
        if (item.due <= clock && scheduled.delete(id)) item.callback();
      }
      await settle();
    },
    delays: () => [...scheduled.values()].map((item) => item.due - clock),
  };
}

test("scene reader pins all merchant data to one finalized Testnet block", async () => {
  const requests = [];
  const read = createMarketReader(
    {
      contractId: fixture.contract_id,
      rpcUrl: "https://test.rpc.fastnear.com",
    },
    async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      let result;
      if (request.method === "status")
        result = { chain_id: "testnet", sync_info: { syncing: false } };
      else if (request.method === "block")
        result = {
          header: {
            hash: seed.finalized_block.hash,
            height: seed.finalized_block.height,
            timestamp_nanosec: seed.finalized_block.timestamp_ns,
          },
        };
      else {
        assert.equal(request.method, "query");
        assert.equal(request.params.request_type, "call_function");
        assert.equal(request.params.account_id, fixture.contract_id);
        assert.equal(request.params.method_name, "get_market_state");
        assert.equal(request.params.block_id, seed.finalized_block.hash);
        result = {
          result: [...Buffer.from(JSON.stringify(seed.market))],
          block_hash: seed.finalized_block.hash,
          block_height: seed.finalized_block.height,
        };
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      );
    },
    () => baseTime + 1000,
  );
  const value = await read();
  assert.deepEqual(
    requests.map((request) => request.method),
    ["status", "block", "query"],
  );
  assert.deepEqual(value.market, seed.market);
  assert.equal(value.block.hash, seed.finalized_block.hash);
  const rex = value.market.data.merchants[0];
  assert.equal(rex.inventory.wood, "4");
  assert.equal(
    rex.listings.find((item) => item.resource === "wood").quantity,
    "2",
  );
});

test("amount formatting retains every u64 digit", () => {
  assert.equal(
    formatMarketAmount("18446744073709551615"),
    "18,446,744,073,709,551,615",
  );
});

test("first read failure shows unavailable without inventing prices", async () => {
  const h = harness(async () => {
    throw new Error("private transport details");
  });
  h.feed.start();
  await settle();
  assert.equal(h.feed.state.status, "unavailable");
  assert.equal(h.feed.state.observation, null);
  assert.equal(JSON.stringify(h.feed.state).includes("private"), false);
  assert.deepEqual(h.delays(), [6000]);
  h.feed.stop();
});

test("refresh failure retains the previous snapshot and recovery clears the warning", async () => {
  let fail = false;
  const first = observation();
  const h = harness(async () => {
    if (fail) throw new Error("offline");
    return first;
  });
  h.feed.start();
  await settle();
  assert.equal(h.feed.state.status, "ready");
  fail = true;
  await h.feed.refresh();
  assert.equal(h.feed.state.status, "stale");
  assert.equal(h.feed.state.observation, first);
  fail = false;
  await h.feed.refresh();
  assert.equal(h.feed.state.status, "ready");
  assert.equal(h.feed.state.readFailed, false);
  h.feed.stop();
  assert.equal(h.scheduled.size, 0);
});

test("requests never overlap and stopped generations cannot publish late values", async () => {
  let resolve;
  let calls = 0;
  const h = harness(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  h.feed.start();
  await h.feed.refresh();
  assert.equal(calls, 1);
  h.feed.stop();
  h.feed.start();
  resolve(observation());
  await settle();
  assert.equal(h.feed.state.observation, null);
  await h.advance(0);
  assert.equal(calls, 2);
  h.feed.stop();
  resolve(observation());
  await settle();
  assert.equal(h.feed.state.observation, null);
  assert.equal(h.scheduled.size, 0);
});

test("snapshot ages while a refresh is pending; hidden polling stops", async () => {
  let calls = 0;
  const h = harness(() =>
    ++calls === 1 ? Promise.resolve(observation()) : new Promise(() => {}),
  );
  h.feed.start();
  await settle();
  await h.advance(15001);
  assert.equal(h.feed.state.status, "stale");
  h.feed.stop();
  await h.advance(60000);
  assert.equal(calls, 2);
  assert.equal(h.scheduled.size, 0);
});

test("outage retries back off to a bounded thirty seconds", async () => {
  const h = harness(async () => {
    throw new Error("offline");
  });
  h.feed.start();
  await settle();
  for (const delay of [6000, 12000, 24000, 30000, 30000]) {
    assert.deepEqual(h.delays(), [delay]);
    await h.advance(delay);
  }
  h.feed.stop();
});

for (const [name, change] of [
  [
    "regressed height",
    (next) => {
      next.block.height = "1";
    },
  ],
  [
    "regressed revision",
    (next) => {
      next.market.market_revision = "0";
    },
  ],
  [
    "changed contract",
    (next) => {
      next.market.data.contract_account_id = "other.testnet";
    },
  ],
  [
    "conflicting same-block values",
    (next) => {
      next.market.data.merchants[0].gold = "1";
    },
  ],
  [
    "conflicting same-height hash",
    (next) => {
      next.block.hash = "other";
    },
  ],
]) {
  test(`scene rejects ${name} and preserves the last observation`, async () => {
    let next = observation();
    const first = next;
    const h = harness(async () => next);
    h.feed.start();
    await settle();
    next = observation();
    change(next);
    await h.feed.refresh();
    assert.equal(h.feed.state.status, "stale");
    assert.equal(h.feed.state.observation, first);
    h.feed.stop();
  });
}

test("recently received old blocks remain stale; pause is authoritative", async () => {
  const next = observation();
  next.market.data.paused = true;
  const h = harness(async () => next);
  await h.advance(20000);
  h.feed.start();
  await settle();
  assert.equal(h.feed.state.status, "stale");
  assert.equal(h.feed.state.observation.market.data.paused, true);
  h.feed.stop();
});
