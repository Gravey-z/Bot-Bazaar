import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
  livingTownHistoryEntry,
  livingTownSalesHistoryRead,
  livingTownReadEnvelope,
  livingTownMarketListingsRead,
  canonicalLivingTownJson,
} from "../../../packages/chain/dist/index.js";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import { LivingTownCustomerDemand } from "../dist/private/living-town/customers.js";
import { replayLivingTownArchive } from "../dist/private/living-town/archive.js";
import {
  allocateOutputCosts,
  costTotal,
  encodeCostUnits,
  decodeCostUnits,
} from "../dist/private/living-town/cost-lots.js";
import { createReadServer } from "../dist/private/read-api/server.js";
import { readLivingTownHealth } from "../dist/private/living-town/health.js";
import { assistantFactSource } from "../dist/private/assistant/facts.js";

const p = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-customers-sandbox.json",
    "utf8",
  ),
);
const clone = (v) => structuredClone(v),
  block = (b) => ({
    hash: b.header.hash,
    height: String(b.header.height),
    timestampNs: b.header.timestamp_nanosec,
  });
const identity = {
  deployment: p.steps[0].foundation.deployment,
  codeHash: p.steps[0].account.code_hash,
  ownerId: p.steps[0].foundation.data.owner_account_id,
  operatorId: p.steps[0].foundation.data.operator_account_id,
  controllers: p.steps[0].foundation.data.merchant_controllers,
};
const steps = [...p.setup_steps, ...p.steps],
  blocks = new Map(steps.map((s) => [s.block.header.hash, block(s.block)]));
const records = await Promise.all(
  steps.map(async (s) => {
    const completion = s.method === "complete_production";
    const proof = {
      transactionHash: s.transaction_hash,
      signerId: s.signer_id,
      deployment: identity.deployment,
      call: completion
        ? createLivingTownCompletionCall(s.args)
        : createLivingTownCall(s.method, s.args),
      referenceBlockHeight: s.reference_block_height,
    };
    const status = await (
      completion ? verifyLivingTownCompletionReceipt : verifyLivingTownReceipt
    )(s.receipt, proof, async (hash) => {
      assert(blocks.has(hash));
      return blocks.get(hash);
    });
    return (
      completion ? livingTownIndexedCompletion : livingTownIndexedReceipt
    )(proof, { status, response: s.receipt });
  }),
);
function baseline(s = p.after) {
  return {
    block: block(s.block),
    town: s.town,
    shops: s.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    listings: s.listings_pages,
    production: [
      // Controlled empty NPC job pages around actual player/market snapshot captures.
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
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-sales-"));
  let store = new LivingTownProjectionStore(dir, identity, true);
  store.baseline(baseline());
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "bazaar-sales-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new LivingTownProjectionStore(dir, identity);
      store.baseline(baseline());
    },
  };
}
function ingest(f, rows = records) {
  for (const r of rows) f.store.commit(r);
}

test("actual complete setup-to-sale receipts yield exact FIFO costs, grants, revenue and profit", (t) => {
  const f = fixture(t);
  ingest(f);
  assert.equal(records.length, 27);
  const a = f.store.history("4").snapshot.data,
    b = f.store.history("5").snapshot.data;
  assert.deepEqual(a.costs, {
    recorded_grants: "100",
    recorded_material_spending: "30",
    recorded_sales_revenue: "54",
    recorded_upgrade_spending: "0",
    recorded_cogs: "30",
    recorded_profit: "24",
    cost_history_complete: true,
    through_event_sequence: p.after.town.event_sequence,
    gap_from_sequence: null,
  });
  assert.equal(b.costs.recorded_material_spending, "36");
  assert.equal(b.costs.recorded_sales_revenue, "48");
  assert.equal(b.costs.recorded_cogs, "24");
  assert.equal(b.costs.recorded_profit, "24");
  assert.deepEqual(
    a.items
      .filter((r) => r.kind === "customer_sale")
      .map((r) => [r.gold_amount, r.cogs, r.profit]),
    [
      ["18", "10", "8"],
      ["18", "10", "8"],
      ["18", "10", "8"],
    ],
  );
  assert.equal(
    a.items.find((r) => r.kind === "production_started").production_cost,
    "30",
  );
  assert.equal(
    a.items.find((r) => r.kind === "production_completed").production_cost,
    "30",
  );
  assert(a.items.every((r) => r.proof_available));
  assert.equal(
    f.store.town().history_complete,
    false,
    "no invented global initialization proof",
  );
  const before = f.store.counts();
  ingest(f);
  assert.deepEqual(f.store.counts(), before);
});

test("missing purchase/start history shows unknown sale cost until late verified receipts fill the prefix", (t) => {
  const f = fixture(t);
  assert.equal(f.store.history("4").snapshot.data.costs.recorded_profit, null);
  ingest(f, records.slice(15));
  const unknown = f.store.history("4").snapshot.data;
  assert.equal(unknown.costs.recorded_sales_revenue, "54");
  assert.equal(unknown.costs.recorded_cogs, null);
  assert.equal(unknown.costs.recorded_profit, null);
  assert.equal(unknown.costs.gap_from_sequence, "2");
  assert(unknown.items.every((r) => r.cogs === null));
  const inventory = canonicalLivingTownJson(
    f.store.inventory("4").snapshot.data,
  );
  ingest(f, records.slice(0, 15).reverse());
  assert.equal(f.store.history("4").snapshot.data.costs.recorded_profit, "24");
  assert.equal(
    canonicalLivingTownJson(f.store.inventory("4").snapshot.data),
    inventory,
    "backfilled accounting never rewinds current balances",
  );
});

test("cost units, immutable job input lots and fulfilled shop history survive reopen", (t) => {
  const f = fixture(t);
  ingest(f);
  const before = f.store.history("5").snapshot.data;
  f.reopen();
  assert.deepEqual(f.store.history("5").snapshot.data, before);
  const context = f.store.customerDemand("42", "0");
  assert.equal(context.marketComplete, true);
  assert.equal(context.historyComplete, true);
  for (const candidate of context.candidates)
    assert(candidate.lastSaleEventSequence !== null);
  const demand = new LivingTownCustomerDemand(
    JSON.parse(readFileSync("config/living-town-v1.json", "utf8")),
  );
  assert.doesNotThrow(() => demand.select(context));
  f.store.close();
  const db = new DatabaseSync(join(f.dir, "living-town.sqlite"));
  try {
    const owner = `account:${p.after.shops[1].shop.data.owner.account_id}`;
    const units = decodeCostUnits(
      db
        .prepare(
          "SELECT units FROM cost_inventory WHERE actor=? AND item='iron_tool'",
        )
        .get(owner).units,
    );
    assert.equal(units.length, 1);
    assert.equal(units[0].cost, "12");
    assert.equal(units[0].ordinal, "2");
    assert(
      db.prepare("SELECT count(*) AS n FROM cost_job_inputs").get().n >= 4,
    );
  } finally {
    db.close();
  }
});

test("binary cost lots preserve unknown bits, u128/u64 widths and exact remainder allocations", () => {
  const units = allocateOutputCosts("21", "2", "18446744073709551615");
  assert.deepEqual(
    units.map((r) => r.cost),
    ["11", "10"],
  );
  assert.equal(costTotal(units), "21");
  const mixed = [...units, ...allocateOutputCosts(null, "1", "1")];
  assert.equal(costTotal(mixed), null);
  assert.deepEqual(decodeCostUnits(encodeCostUnits(mixed)), mixed);
  const largest = Array.from({ length: 1000 }, (_, i) => ({
    cost: i % 2 ? null : "340282366920938463463374607431768211455",
    source: "18446744073709551615",
    ordinal: String(i),
  }));
  const packed = encodeCostUnits(largest);
  assert.equal(packed.length, 32129);
  assert.deepEqual(decodeCostUnits(packed), largest);
  assert.throws(() => encodeCostUnits([...largest, largest[0]]));
  assert.throws(() => decodeCostUnits(packed.slice(1)));
  assert.throws(() => allocateOutputCosts("-1", "2", "1"));
});

test("market/history pagination binds deployment generation, finalized block, accounting version and shop", (t) => {
  const f = fixture(t);
  ingest(f);
  const first = f.store.listings(null, 2),
    next = f.store.listings(first.snapshot.data.next_cursor, 2);
  assert.deepEqual(
    first.snapshot.data.items.map((r) => r.listing_id),
    ["1", "2"],
  );
  assert.deepEqual(
    next.snapshot.data.items.map((r) => r.listing_id),
    ["3", "4"],
  );
  const a = f.store.history("4", null, 2);
  assert.equal(a.snapshot.data.has_more, true);
  assert.throws(
    () => f.store.history("5", a.snapshot.data.next_cursor),
    (e) => e.status === 400,
  );
  assert.throws(
    () => f.store.listings(a.snapshot.data.next_cursor),
    (e) => e.status === 400,
  );
  const invalid = clone(baseline());
  invalid.listings[0].data.items.pop();
  assert.throws(() => f.store.baseline(invalid), /market/);
  assert.equal(f.store.listings(null, 50).snapshot.data.items.length, 6);
  const old = f.store.history("4", null, 1).snapshot.data.next_cursor;
  f.store.baseline(baseline());
  assert.throws(
    () => f.store.history("4", old),
    (e) => e.status === 409,
  );
});

test("receipt archives reconstruct FIFO beyond retained contract history without changing finalized balances", async (t) => {
  const original = fixture(t);
  ingest(original);
  const chunks = [];
  let after = null;
  do {
    const part = original.store.archive(after, 5);
    chunks.push(part);
    after = part.next;
  } while (after !== null);
  const rebuilt = fixture(t);
  let checked = 0;
  for (const part of chunks)
    await replayLivingTownArchive(part, rebuilt.store, async (hash) => {
      checked++;
      assert(blocks.has(hash));
      return blocks.get(hash);
    });
  assert(checked > 0);
  assert.deepEqual(
    rebuilt.store.history("4").snapshot.data,
    original.store.history("4").snapshot.data,
  );
  assert.deepEqual(
    rebuilt.store.inventory("4").snapshot.data,
    original.store.inventory("4").snapshot.data,
  );
  const counts = rebuilt.store.counts();
  for (const part of chunks)
    await replayLivingTownArchive(part, rebuilt.store, async (hash) =>
      blocks.get(hash),
    );
  assert.deepEqual(rebuilt.store.counts(), counts);
  await assert.rejects(
    replayLivingTownArchive(
      { ...chunks[0], sha256: "0".repeat(64) },
      rebuilt.store,
      async () => {
        throw Error("must reject before verifier");
      },
    ),
    /checksum/,
  );
  await assert.rejects(
    replayLivingTownArchive(chunks[0], fixture(t).store, async () => {
      throw Error("unverified historical block");
    }),
    /unverified/,
  );
  const forged = JSON.parse(chunks[0].body);
  const response = JSON.parse(
    gunzipSync(
      Buffer.from(forged.entries[0].response_gzip_base64, "base64"),
    ).toString(),
  );
  response.transaction.receiver_id = "forged.testnet";
  forged.entries[0].response_gzip_base64 = gzipSync(
    Buffer.from(JSON.stringify(response)),
  ).toString("base64");
  const body = canonicalLivingTownJson(forged);
  await assert.rejects(
    replayLivingTownArchive(
      { body, sha256: createHash("sha256").update(body).digest("hex") },
      fixture(t).store,
      async (hash) => blocks.get(hash),
    ),
    /mismatch|receiver|contract/,
  );
});

test("strict history codecs refuse fake zero profit and inconsistent sale arithmetic", (t) => {
  const f = fixture(t);
  ingest(f);
  const sale = f.store
    .history("4")
    .snapshot.data.items.find((r) => r.kind === "customer_sale");
  for (const mutate of [
    (r) => (r.profit = "0"),
    (r) => (r.cogs = null),
    (r) => (r.quantity = 1),
    (r) => (r.transaction_hash = "fake"),
    (r) => (r.cost_status = "unknown"),
  ]) {
    const row = clone(sale);
    mutate(row);
    assert.throws(() => livingTownHistoryEntry(row));
  }
  const unknown = { ...sale, cogs: null, profit: null, cost_status: "unknown" };
  assert.doesNotThrow(() => livingTownHistoryEntry(unknown));
  assert.doesNotThrow(() =>
    livingTownHistoryEntry({
      ...sale,
      gold_amount: "1",
      cogs: "10",
      profit: "-9",
    }),
  );
});

test("public listings and history are bounded GET/HEAD reads with no signing capability", async (t) => {
  const f = fixture(t);
  ingest(f);
  const server = createReadServer(
    {
      health: () => readLivingTownHealth(f.store),
      activity: () => {
        throw Error("unused");
      },
      livingTown: {
        town: () => f.store.town(),
        shop: (id) => f.store.shopView(id),
        inventory: (id) => f.store.inventory(id),
        production: (id, a, l) => f.store.production(id, a, l),
        listings: (a, l) => f.store.listings(a, l),
        history: (id, a, l) => f.store.history(id, a, l),
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
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, decode] of [
    ["/api/market/listings?limit=2", livingTownMarketListingsRead],
    ["/api/shops/4/history?limit=2", livingTownSalesHistoryRead],
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200);
    livingTownReadEnvelope(decode)(await r.json());
    assert.equal((await fetch(base + path, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(base + path, { method: "POST" })).status, 405);
  }
  for (const path of [
    "/api/market/listings?limit=51",
    "/api/market/listings?after=bad!",
    "/api/shops/4/history?limit=1&limit=2",
    "/api/shops/4/history?buyer=forged",
  ]) {
    assert.equal((await fetch(base + path)).status, 400);
  }
});

test("assistant collector binds RPC stock to receipt-projected costs and refuses mismatched history", async (t) => {
  const f = fixture(t);
  ingest(f);
  const clock = Number(BigInt(p.after.town.block_timestamp_ns) / 1000000n);
  const row = p.after.shops.find((r) => r.shop.data.shop_id === "4");
  const reader = {
    block: block(p.after.block),
    getTown: async () => clone(p.after.town),
    // This historical sales capture predates assistant methods.
    getFoundation: async () => ({ data: { supported_methods: [] } }),
    getShop: async () => clone(row.shop),
    getShopInventory: async () => clone(row.ledger),
    getListings: async (args) => ({
      ...clone(p.after.town),
      data: {
        items: p.after.listings_pages
          .flatMap((p) => p.data.items)
          .filter((l) => l.shop_id === args.shop_id && l.active),
        next_after_id: null,
        has_more: false,
      },
    }),
  };
  let mutate = (x) => x;
  const source = assistantFactSource(
    { identity, finalized: async () => reader },
    "http://127.0.0.1:3011",
    async (url, init) => {
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      const u = new URL(url),
        envelope = clone(f.store.history("4", u.searchParams.get("after"), 50));
      envelope.observed_at_ms = String(clock);
      envelope.stale = false;
      return Response.json(mutate(envelope));
    },
    () => clock,
  );
  const partial = await source.load(row.shop.data.owner.account_id, "4");
  assert.equal(partial.productionCost.health_potion, "10");
  assert.equal(
    partial.historyComplete,
    false,
    "missing global initialization proof remains a gap",
  );
  assert.equal(partial.snapshot.block_hash, reader.block.hash);
  mutate = (e) => {
    e.history_complete = true;
    e.checkpoint.history_complete = true;
    e.checkpoint.baseline_event_sequence = "0";
    e.checkpoint.gap_from_sequence = null;
    e.checkpoint.last_receipt_id =
      p.steps.at(-1).receipt.receipts_outcome[0].id;
    e.checkpoint.last_log_index = "0";
    return e;
  };
  assert.equal(
    (await source.load(row.shop.data.owner.account_id, "4")).historyComplete,
    true,
    "controlled complete projection declaration, not live proof",
  );
  mutate = (e) => {
    e.checkpoint.verified_code_hash = "11111111111111111111111111111111";
    return e;
  };
  await assert.rejects(source.load(row.shop.data.owner.account_id, "4"));
  await assert.rejects(source.load("other.testnet", "4"));
});
