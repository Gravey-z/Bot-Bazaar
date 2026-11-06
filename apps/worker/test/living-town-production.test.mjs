import { controlledMarket } from "./fixtures/living-town-market.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  createLivingTownCompletionCall,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedCompletion,
  livingTownProductionRead,
  livingTownReadEnvelope,
} from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import { LivingTownProjector } from "../dist/private/living-town/projector.js";
import { readReceiptInbox } from "../dist/private/living-town/config.js";
import { readLivingTownHealth } from "../dist/private/living-town/health.js";
import { createReadServer } from "../dist/private/read-api/server.js";

const captured = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-completion-sandbox.json",
    "utf8",
  ),
);
const foundation = captured.steps[0].foundation;
const identity = {
  deployment: foundation.deployment,
  codeHash: captured.steps[0].account.code_hash,
  ownerId: foundation.data.owner_account_id,
  operatorId: foundation.data.operator_account_id,
  controllers: foundation.data.merchant_controllers,
};
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
const now = Date.now();
function baseline(s) {
  return {
    block: block(s.block),
    town: s.town,
    shops: s.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    production: [
      // Captures include both player queues. NPCs have no jobs in this scenario;
      // these empty pages are controlled inputs, not separately captured reads.
      ...["1", "2", "3"].map((shopId) => ({
        shopId,
        pages: [
          {
            ...s.town,
            data: {
              items: [],
              next_after_id: null,
              has_more: false,
              history_gap: false,
              pruned_through: "0",
            },
          },
        ],
      })),
      ...s.shops.map((r) => ({ shopId: r.shop.data.shop_id, pages: [r.jobs] })),
    ],
  };
}
function fixture(t, s = captured.before) {
  const dir = mkdtempSync(join(tmpdir(), "living-town-jobs-"));
  let store = new LivingTownProjectionStore(dir, identity, true);
  store.baseline(baseline(s), now);
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "living-town-jobs-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new LivingTownProjectionStore(dir, identity);
    },
  };
}
const proofs = captured.steps.map((s) => ({
  transactionHash: s.transaction_hash,
  signerId: s.signer_id,
  deployment: identity.deployment,
  call: createLivingTownCompletionCall(s.args),
  referenceBlockHeight: s.reference_block_height,
}));
const evidence = await Promise.all(
  captured.steps.map(async (s, i) => ({
    status: await verifyLivingTownCompletionReceipt(
      s.receipt,
      proofs[i],
      async () => block(s.block),
    ),
    response: s.receipt,
  })),
);

test("finalized clock advances only readiness hints; restart and local clocks cannot settle production", (t) => {
  const f = fixture(t);
  const held = f.store.inventory("4", now).snapshot.data.inventory.held
    .health_potion;
  assert.equal(
    f.store.production("4", null, 20, now).snapshot.data.ready_job_ids.length,
    0,
  );
  // Advancing only the browser/server wall clock cannot make a batch ready.
  assert.equal(
    f.store.production("4", null, 20, now + 86400000).snapshot.data
      .ready_job_ids.length,
    0,
  );
  const town = structuredClone(captured.before.town);
  const timestamp = (
    BigInt(captured.before.shops[0].jobs.data.items[0].ready_at_ns) + 1n
  ).toString();
  town.block_timestamp_ns = timestamp;
  town.block_height = (BigInt(town.block_height) + 1n).toString();
  town.data.epoch = (
    (BigInt(timestamp) - BigInt(town.data.genesis_time_ns)) /
    60000000000n
  ).toString();
  town.data.customer_pool.epoch = town.data.epoch;
  f.store.observe(
    town,
    {
      ...block(captured.before.block),
      height: town.block_height,
      timestampNs: timestamp,
    },
    now + 1,
  );
  const ready = livingTownReadEnvelope(livingTownProductionRead)(
    f.store.production("4", null, 20, now + 1),
  );
  assert.deepEqual(ready.snapshot.data.ready_job_ids, ["1"]);
  assert.equal(ready.snapshot.data.page.items[0].status, "running");
  assert.equal(ready.snapshot.data.settlement, "wallet_claim");
  assert.equal(
    f.store.inventory("4", now + 1).snapshot.data.inventory.held.health_potion,
    held,
  );
  f.restart();
  assert.equal(f.store.production("4", null, 20, now + 2).stale, true);
  assert.equal(
    f.store.inventory("4", now + 2).snapshot.data.inventory.held.health_potion,
    held,
  );
  f.store.baseline(baseline(captured.completed), now + 3);
  assert.equal(
    f.store.production("4", null, 20, now + 3).snapshot.data.page.items[0]
      .status,
    "completed",
  );
  assert.equal(
    f.store.inventory("4", now + 3).snapshot.data.inventory.held.health_potion,
    "1",
  );
  f.store.baseline(baseline(captured.after), now + 4);
  assert.deepEqual(
    f.store
      .production("4", null, 20, now + 4)
      .snapshot.data.page.items.map((j) => j.status),
    ["completed", "running"],
  );
  assert.equal(
    f.store.inventory("4", now + 4).snapshot.data.inventory
      .production_output_reserved.health_potion,
    "1",
  );
});

test("verified completion ingestion deduplicates receipts, retains gaps and rebuilds from finalized jobs", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const client = {
    identity,
    completionReceiptEvidence: async (proof) => {
      reads++;
      return evidence[
        proofs.findIndex((p) => p.transactionHash === proof.transactionHash)
      ];
    },
  };
  const projector = new LivingTownProjector(client, f.store);
  for (let i = 0; i < proofs.length; i++)
    assert.equal(await projector.ingest(proofs[i], now), "indexed");
  const counts = f.store.counts();
  assert.equal(counts.events, 2);
  assert.equal(counts.receipts, 5);
  assert.equal(f.store.production("4", null, 20, now).stale, true);
  assert.equal(
    f.store.inventory("4", now).snapshot.data.inventory.held.health_potion,
    "0",
  );
  f.restart();
  const restored = new LivingTownProjector(client, f.store);
  for (const proof of proofs)
    assert.equal(await restored.ingest(proof, now), "duplicate");
  assert.equal(reads, 5);
  f.store.baseline(baseline(captured.after), now + 1);
  assert.equal(
    f.store.inventory("4", now + 1).snapshot.data.inventory.held.health_potion,
    "1",
  );
  assert.deepEqual(f.store.counts(), counts);
  const unknown = {
    ...client,
    completionReceiptEvidence: async () => ({
      status: { kind: "unknown", transactionHash: proofs[0].transactionHash },
      response: null,
    }),
  };
  const fresh = structuredClone(proofs[0]);
  fresh.transactionHash = identity.deployment.genesis_hash;
  assert.equal(
    await new LivingTownProjector(unknown, f.store).ingest(fresh),
    "unresolved",
  );
  assert.deepEqual(f.store.counts(), counts);
  const inbox = join(f.dir, "inbox.json");
  writeFileSync(
    inbox,
    JSON.stringify({
      schema: "living-town-receipt-inbox-v1",
      requests: proofs.map((p) => ({
        transaction_hash: p.transactionHash,
        signer_id: p.signerId,
        method: p.call.method,
        args: p.call.args,
        reference_block_height: p.referenceBlockHeight,
      })),
    }),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(readReceiptInbox(inbox, identity))),
    JSON.parse(JSON.stringify(proofs)),
  );
  assert.equal(livingTownIndexedCompletion(proofs[0], evidence[0]).event, null);
});

test("restart rescans all bounded pages, preserves running jobs and rolls back partial or inconsistent rebuilds", async (t) => {
  const f = fixture(t, captured.after),
    input = baseline(captured.after);
  // Controlled retained-history stress, not 125 actual economic settlements.
  const prototype = input.production[3].pages[0].data.items[0];
  const items = [
    ...input.production[3].pages[0].data.items,
    ...Array.from({ length: 125 }, (_, i) => ({
      ...prototype,
      job_id: String(i + 10),
    })),
  ];
  input.production[3].pages = Array.from({ length: 3 }, (_, i) => ({
    ...input.town,
    data: {
      items: items.slice(i * 50, i * 50 + 50),
      next_after_id: items.slice(i * 50, i * 50 + 50).at(-1).job_id,
      has_more: i < 2,
      history_gap: false,
      pruned_through: "0",
    },
  }));
  let reads = [],
    fail = false;
  const client = {
    identity,
    finalized: async () => ({
      block: input.block,
      getTown: async () => input.town,
      getListings: async () => controlledMarket(input.town),
      getShop: async (id) =>
        input.shops.find((r) => r.shop.data.shop_id === id).shop,
      getShopInventory: async (id) =>
        input.shops.find((r) => r.shop.data.shop_id === id).ledger,
      getProductionJobs: async (args) => {
        reads.push(args);
        assert.equal(args.limit, "50");
        assert.equal(args.status, "all");
        assert.equal(args.expected_market_revision, input.town.market_revision);
        const pages = input.production.find(
          (r) => r.shopId === args.shop_id,
        ).pages;
        if (fail && args.after_id !== null) throw Error("page unavailable");
        const index =
          args.after_id === null
            ? 0
            : pages.findIndex((p) => p.data.next_after_id === args.after_id) +
              1;
        return pages[index];
      },
    }),
  };
  await new LivingTownProjector(client, f.store).sync();
  assert.equal(reads.length, 7);
  assert.equal(
    f.store.production("4", null, 50).snapshot.data.page.items.length,
    50,
  );
  const first = f.store.production("4", null, 50).snapshot.data;
  const second = f.store.production("4", first.next_cursor, 50).snapshot.data;
  const third = f.store.production("4", second.next_cursor, 50).snapshot.data;
  assert.equal(
    first.page.items.length +
      second.page.items.length +
      third.page.items.length,
    127,
  );
  assert.equal(third.next_cursor, null);
  const generation = f.store.cursor().feed_generation;
  f.restart();
  reads = [];
  await new LivingTownProjector(client, f.store).sync();
  assert.equal(reads.length, 7);
  assert.equal(f.store.cursor().feed_generation, generation);
  const before = f.store.production("4", null, 50).snapshot.data;
  const checkpoint = f.store.cursor();
  const inventory = f.store.inventory("4").snapshot.data;
  f.store.db.exec(
    "CREATE TRIGGER reject_job_write BEFORE INSERT ON production_jobs WHEN NEW.job_id='3' BEGIN SELECT RAISE(ABORT,'injected job write failure'); END",
  );
  assert.throws(() => f.store.baseline(input), /injected job write failure/);
  assert.deepEqual(f.store.production("4", null, 50).snapshot.data, before);
  assert.deepEqual(f.store.cursor(), checkpoint);
  assert.deepEqual(f.store.inventory("4").snapshot.data, inventory);
  f.store.db.exec("DROP TRIGGER reject_job_write");
  fail = true;
  await assert.rejects(
    new LivingTownProjector(client, f.store).sync(),
    /page unavailable/,
  );
  assert.equal(f.store.production("4", null, 50).stale, true);
  assert.deepEqual(f.store.production("4", null, 50).snapshot.data, before);
  for (const mutate of [
    (b) => b.production.pop(),
    (b) => b.production[3].pages.pop(),
    (b) =>
      (b.production[3].pages[0].data.items[1].owner = {
        kind: "player",
        account_id: "other.testnet",
      }),
    (b) => (b.production[3].pages[0].market_revision = "1"),
    (b) => b.production[3].pages[0].data.items.splice(1, 1),
  ]) {
    const bad = structuredClone(input);
    mutate(bad);
    assert.throws(() => f.store.baseline(bad));
    assert.deepEqual(f.store.production("4", null, 50).snapshot.data, before);
  }
});

test("production HTTP reads are bounded, snapshot-bound and read-only with explicit freshness and history gaps", async (t) => {
  const f = fixture(t, captured.after);
  const input = baseline(captured.after);
  for (const group of input.production)
    for (const page of group.pages) {
      page.data.history_gap = true;
      page.data.pruned_through = "2";
    }
  f.store.baseline(input, now);
  const server = createReadServer(
    {
      health: () => readLivingTownHealth(f.store, now),
      activity: () => {
        throw Error("unused");
      },
      livingTown: {
        town: () => f.store.town(now),
        shop: (id) => f.store.shopView(id, now),
        inventory: (id) => f.store.inventory(id, now),
        production: (id, after, limit) =>
          f.store.production(id, after, limit, now),
      },
    },
    {
      allowedOrigins: ["http://127.0.0.1:4201"],
      trustedProxyIps: [],
      clientPerMinute: 600,
      globalPerSecond: 100,
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/shops/4/production`;
  const response = await fetch(base + "?limit=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const page = livingTownReadEnvelope(livingTownProductionRead)(
    await response.json(),
  );
  assert.equal(page.snapshot.data.page.items[0].status, "completed");
  assert.equal(page.snapshot.data.page.history_gap, true);
  assert.equal(page.history_complete, false);
  const cursor = page.snapshot.data.next_cursor;
  const next = await (await fetch(base + "?limit=1&after=" + cursor)).json();
  assert.equal(next.snapshot.data.page.items[0].job_id, "3");
  for (const query of [
    "?limit=0",
    "?limit=51",
    "?limit=1&limit=2",
    "?after=1",
    "?after=%20",
    "?sign=1",
  ])
    assert.equal((await fetch(base + query)).status, 400);
  assert.equal(
    (await fetch(base.replace("/4/", "/5/") + "?after=" + cursor)).status,
    400,
  );
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  assert.equal((await fetch(base.replace("/4/", "/999/"))).status, 404);
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(
    (
      await fetch(base, {
        method: "OPTIONS",
        headers: {
          Origin: "http://127.0.0.1:4201",
          "Access-Control-Request-Method": "GET",
        },
      })
    ).status,
    204,
  );
  f.store.baseline(input, now + 1);
  assert.equal((await fetch(base + "?after=" + cursor)).status, 409);
  f.store.invalidate();
  assert.equal((await (await fetch(base)).json()).stale, true);
  assert.equal(
    f.store.inventory("4", now).snapshot.data.inventory.held.health_potion,
    "1",
  );
});
