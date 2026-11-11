import { controlledMarket } from "./fixtures/living-town-market.mjs";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  verifyLivingTownReceipt,
  livingTownIndexedReceipt,
  createLivingTownCall,
  livingTownReadEnvelope,
  livingTownShop,
  livingTownLedger,
  livingTownTown,
} from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import { LivingTownProjector } from "../dist/private/living-town/projector.js";
import { readLivingTownHealth } from "../dist/private/living-town/health.js";
import {
  parseLivingTownWorkerConfig,
  readReceiptInbox,
} from "../dist/private/living-town/config.js";
import { createReadServer } from "../dist/private/read-api/server.js";

const captured = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/chain/living-town-sandbox.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const foundation = JSON.parse(
  Buffer.from(captured.steps[0].foundation.result).toString(),
);
const identity = {
  deployment: foundation.deployment,
  codeHash: captured.steps[0].account.code_hash,
  ownerId: captured.contract_id,
  operatorId: "operator.testnet",
  controllers: {
    rex: "rex.testnet",
    luna: "luna.testnet",
    bolt: "bolt.testnet",
  },
};
const block = (v) => ({
  hash: v.header.hash,
  height: String(v.header.height),
  timestampNs: v.header.timestamp_nanosec,
});
const emptyProduction = (town) =>
  Array.from({ length: Number(town.data.next_shop_id) - 1 }, (_, i) => ({
    shopId: String(i + 1),
    pages: [
      {
        ...town,
        data: {
          items: [],
          next_after_id: null,
          has_more: false,
          history_gap: false,
          pruned_through: "0",
        },
      },
    ],
  }));
const initial = {
  town: captured.initial_town,
  block: block(captured.initial_block),
  shops: [],
  production: emptyProduction(captured.initial_town),
};
const final = {
  town: captured.final_views.get_town,
  block: block(captured.final_block),
  production: emptyProduction(captured.final_views.get_town),
  shops: [
    {
      shop: captured.final_views.get_shop,
      ledger: captured.final_views.get_shop_inventory,
    },
  ],
};
const proofs = captured.steps.map((s) => ({
  transactionHash: s.transaction_hash,
  signerId: captured.player_id,
  deployment: identity.deployment,
  call: createLivingTownCall(s.method, s.args),
  referenceBlockHeight: String(s.reference_block_height),
}));
const evidence = await Promise.all(
  captured.steps.map(async (s, i) => ({
    status: await verifyLivingTownReceipt(
      s.receipt,
      proofs[i],
      async (hash) => {
        assert.equal(hash, s.block.header.hash);
        assert.equal(s.account.code_hash, identity.codeHash);
        return block(s.block);
      },
    ),
    response: s.receipt,
  })),
);
const receipts = evidence.map((e, i) => livingTownIndexedReceipt(proofs[i], e));
const now = 1_800_000_000_000;
function fixture(t, baseline = initial) {
  const dir = mkdtempSync(join(tmpdir(), "living-town-projection-"));
  let store = new LivingTownProjectionStore(dir, identity, true);
  if (baseline) store.baseline(baseline, now);
  const f = {
    dir,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new LivingTownProjectionStore(dir, identity);
      return store;
    },
  };
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "living-town-projection-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return f;
}

test("V2 disposable projection initializes only its own schema and rejects mismatched or future state", (t) => {
  const f = fixture(t, null);
  assert.throws(() => f.store.town(now), /read_unavailable/);
  assert.throws(() => f.store.shopView("4", now), /read_unavailable/);
  f.store.baseline(initial, now);
  const generation = f.store.cursor().feed_generation;
  f.restart();
  assert.equal(f.store.cursor().feed_generation, generation);
  assert.equal(f.store.town(now).stale, true);
  f.store.close();
  assert.throws(
    () =>
      new LivingTownProjectionStore(f.dir, {
        ...identity,
        codeHash: identity.deployment.genesis_hash,
      }),
    /mismatch/,
  );
  const future = new DatabaseSync(f.store.path);
  future.exec("PRAGMA user_version=99");
  future.close();
  assert.throws(
    () => new LivingTownProjectionStore(f.dir, identity),
    /unsupported projection schema/,
  );
  const reset = new DatabaseSync(f.store.path);
  reset.exec("PRAGMA user_version=5");
  reset.close();
  f.restart();
  assert.throws(
    () => new LivingTownProjectionStore(f.dir, identity),
    /locked|busy/,
  );
  const legacy = join(f.dir, "worker.sqlite");
  writeFileSync(legacy, "preserved legacy fixture");
  f.store.observe(final.town, final.block, now);
  assert.equal(readFileSync(legacy, "utf8"), "preserved legacy fixture");
});

test("actual finalized receipts update one shop, referenced inventory and cursor exactly once", (t) => {
  const f = fixture(t);
  for (const r of receipts) {
    assert.equal(f.store.commit(r, now), "indexed");
    assert.equal(f.store.commit(r, now), "duplicate");
  }
  assert.equal(f.store.observe(final.town, final.block, now), true);
  assert.deepEqual(f.store.counts(), {
    shops: 4,
    ledgers: 4,
    receipts: 6,
    events: 4,
  });
  const shop = f.store.shopView("4", now),
    inventory = f.store.inventory("4", now),
    town = f.store.town(now);
  assert.equal(shop.snapshot.data.name, "Verified Shop");
  assert.equal(inventory.snapshot.data.gold.held, "96");
  assert.equal(inventory.snapshot.data.inventory.held.crystal, "1");
  assert.equal(town.snapshot.data.totals.player_grants, "100");
  assert.equal(town.snapshot.data.registered_player_count, "1");
  assert.equal(town.checkpoint.through_event_sequence, "5");
  assert.equal(
    town.checkpoint.last_receipt_id,
    receipts[3].status.executionReceiptId,
  );
  assert.equal(town.checkpoint.last_log_index, "0");
  assert.equal(town.history_complete, false);
  assert.equal(town.checkpoint.gap_from_sequence, "1");
  assert.equal(town.stale, false);
  livingTownReadEnvelope(livingTownShop)(shop);
  livingTownReadEnvelope(livingTownLedger)(inventory);
  livingTownReadEnvelope(livingTownTown)(town);
  const counts = f.store.counts();
  f.restart();
  assert.equal(f.store.town(now).stale, true);
  assert.equal(f.store.observe(final.town, final.block, now), true);
  for (const r of receipts) assert.equal(f.store.commit(r, now), "duplicate");
  assert.deepEqual(f.store.counts(), counts);
  assert.equal(f.store.inventory("4", now).snapshot.data.gold.held, "96");
});

test("out-of-order receipt ingestion exposes a gap until contiguous effects drain without overspending", (t) => {
  const f = fixture(t);
  f.store.commit(receipts[3], now);
  assert.equal(f.store.cursor().through_event_sequence, "1");
  assert.equal(f.store.town(now).stale, true);
  f.store.commit(receipts[2], now);
  f.store.commit(receipts[1], now);
  assert.equal(f.store.cursor().through_event_sequence, "1");
  f.store.commit(receipts[0], now);
  assert.equal(f.store.cursor().through_event_sequence, "5");
  assert.equal(f.store.observe(final.town, final.block, now), true);
  assert.equal(f.store.inventory("4", now).snapshot.data.gold.held, "96");
  assert.equal(f.store.town(now).snapshot.data.npc_ledgers[0].gold.held, "204");
});

test("SQLite rolls receipt/event, ownership and cursor changes back together on write failure", (t) => {
  const f = fixture(t);
  f.store.commit(receipts[0], now);
  const before = f.store.counts(),
    cursor = f.store.cursor();
  f.store.db.exec(
    "CREATE TRIGGER reject_projection_write BEFORE UPDATE ON projection_state BEGIN SELECT RAISE(ABORT,'injected storage failure'); END",
  );
  assert.throws(
    () => f.store.commit(receipts[1], now),
    /injected storage failure/,
  );
  assert.deepEqual(f.store.counts(), before);
  assert.deepEqual(f.store.cursor(), cursor);
  assert.throws(() => f.store.shopView("4", now), /shop_not_found/);
  f.store.db.exec("DROP TRIGGER reject_projection_write");
  assert.equal(f.store.commit(receipts[1], now), "indexed");
  assert.equal(f.store.inventory("4", now).snapshot.data.gold.held, "100");
});

test("snapshot rebuild preserves current balances, labels missing history and never reapplies old grants", (t) => {
  const f = fixture(t, final);
  const generation = f.store.cursor().feed_generation;
  for (const r of receipts) f.store.commit(r, now);
  assert.equal(f.store.inventory("4", now).snapshot.data.gold.held, "96");
  assert.equal(f.store.town(now).snapshot.data.totals.player_grants, "100");
  assert.equal(f.store.cursor().baseline_event_sequence, "5");
  assert.equal(f.store.cursor().last_receipt_id, null);
  assert.equal(f.store.town(now).history_complete, false);
  f.store.baseline(final, now + 1);
  assert.notEqual(f.store.cursor().feed_generation, generation);
  assert.equal(f.store.town(now + 30002).stale, true);
  assert.equal(f.store.town(now - 1).stale, true);
  const broken = structuredClone(final);
  broken.shops = [];
  assert.throws(() => f.store.baseline(broken, now), /incomplete/);
  assert.equal(f.store.inventory("4", now).snapshot.data.gold.held, "96");
});

test("rebuild cannot hide a newer verified receipt behind an older finalized snapshot", (t) => {
  const f = fixture(t);
  f.store.commit(receipts[3], now);
  const before = f.store.counts(),
    cursor = f.store.cursor();
  assert.equal(f.store.town(now).stale, true);
  assert.throws(() => f.store.baseline(initial, now + 1), /cannot rewind/);
  assert.deepEqual(f.store.counts(), before);
  assert.deepEqual(f.store.cursor(), cursor);
  assert.equal(f.store.town(now + 1).stale, true);
  f.restart();
  assert.throws(() => f.store.baseline(initial, now + 2), /cannot rewind/);
  f.store.baseline(final, now + 3);
  for (const receipt of receipts) f.store.commit(receipt, now + 3);
  assert.equal(f.store.inventory("4", now + 3).snapshot.data.gold.held, "96");
  assert.equal(f.store.town(now + 3).snapshot.data.totals.player_grants, "100");
});

test("conflicting receipt and event identities roll back without replacing ownership or balances", (t) => {
  const f = fixture(t);
  receipts.slice(0, 4).forEach((r) => f.store.commit(r, now));
  const before = f.store.counts(),
    cursor = f.store.cursor(),
    inventory = f.store.inventory("4", now);
  const collision = structuredClone(receipts[3]);
  collision.proof.transactionHash = receipts[4].proof.transactionHash;
  assert.throws(() => f.store.commit(collision, now), /UNIQUE/);
  collision.status.executionReceiptId = receipts[4].status.executionReceiptId;
  assert.throws(
    () => f.store.commit(collision, now),
    /conflicting event sequence/,
  );
  const changedRequest = structuredClone(receipts[3]);
  changedRequest.proof.signerId = "other.testnet";
  assert.throws(
    () => f.store.commit(changedRequest, now),
    /conflicting receipt request/,
  );
  assert.deepEqual(f.store.counts(), before);
  assert.deepEqual(f.store.cursor(), cursor);
  assert.deepEqual(f.store.inventory("4", now), inventory);
  f.restart();
  assert.deepEqual(f.store.counts(), before);
});

test("malformed and duplicate-owner rebuilds preserve the prior complete SQLite projection", (t) => {
  const f = fixture(t, final);
  const before = f.store.counts(),
    cursor = f.store.cursor(),
    inventory = f.store.inventory("4", now);
  for (const mutate of [
    (b) => {
      b.shops[0].shop.data.owner.account_id = "other.testnet";
    },
    (b) => {
      b.shops[0].ledger.market_revision = "1";
    },
    (b) => {
      b.town.deployment.config_sha256 = "b".repeat(64);
    },
    (b) => {
      b.town.data.next_shop_id = "6";
      const duplicate = structuredClone(b.shops[0]);
      duplicate.shop.data.shop_id = "5";
      b.shops.push(duplicate);
    },
  ]) {
    const broken = structuredClone(final);
    mutate(broken);
    assert.throws(() => f.store.baseline(broken, now + 1));
    assert.deepEqual(f.store.counts(), before);
    assert.deepEqual(f.store.cursor(), cursor);
    assert.deepEqual(f.store.inventory("4", now), inventory);
  }
  f.restart();
  assert.equal(f.store.inventory("4", now).snapshot.data.gold.held, "96");
});

test("repeated shuffled ingestion across rebuilds and restarts never reapplies grants or trades", (t) => {
  const f = fixture(t);
  for (const order of [
    [5, 3, 1, 4, 2, 0],
    [0, 0, 1, 2, 3, 4, 5],
    [3, 2, 1, 0, 5, 4],
  ]) {
    for (const index of order) f.store.commit(receipts[index], now);
    f.store.baseline(final, now);
    f.restart();
    for (const index of order)
      assert.equal(f.store.commit(receipts[index], now), "duplicate");
    assert.equal(f.store.observe(final.town, final.block, now), true);
    assert.deepEqual(f.store.counts(), {
      shops: 4,
      ledgers: 4,
      receipts: 6,
      events: 4,
    });
    assert.equal(f.store.inventory("4", now).snapshot.data.gold.held, "96");
    assert.equal(
      f.store.inventory("4", now).snapshot.data.inventory.held.crystal,
      "1",
    );
    assert.equal(f.store.town(now).snapshot.data.totals.player_grants, "100");
  }
});

test("receipt event extraction ignores replay/failure logs and rejects forged successful event metadata", () => {
  assert.equal(receipts[4].event, null);
  assert.equal(receipts[5].event, null);
  const modified = structuredClone(evidence[3]),
    root = modified.status.executionReceiptId;
  const row = modified.response.receipts_outcome.find((r) => r.id === root),
    log = JSON.parse(row.outcome.logs[0].slice(11));
  log.data[0].event_sequence = "999";
  row.outcome.logs[0] = "EVENT_JSON:" + JSON.stringify(log);
  assert.throws(
    () => livingTownIndexedReceipt(proofs[3], modified),
    /mismatch/,
  );
  const failed = structuredClone(evidence[5]);
  failed.response.receipts_outcome[0].outcome.logs = [
    'EVENT_JSON:{"event":"forged"}',
  ];
  assert.equal(livingTownIndexedReceipt(proofs[5], failed).event, null);
});

test("production starts retain a visible gap until coherent snapshot recovery without crediting outputs", async (t) => {
  const p = JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/chain/living-town-production-sandbox.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const foundation = p.steps[0].foundation,
    identity = {
      deployment: foundation.deployment,
      codeHash: p.steps[0].account.code_hash,
      ownerId: foundation.data.owner_account_id,
      operatorId: foundation.data.operator_account_id,
      controllers: foundation.data.merchant_controllers,
    };
  const dir = mkdtempSync(join(tmpdir(), "living-town-production-"));
  const store = new LivingTownProjectionStore(dir, identity, true);
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "living-town-production-")));
    rmSync(dir, { recursive: true, force: true });
  });
  const baseline = (s) => ({
    town: s.town,
    block: block(s.block),
    shops: s.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    production: [
      ...emptyProduction(s.town).slice(0, 3),
      ...s.shops.map((r) => ({ shopId: r.shop.data.shop_id, pages: [r.jobs] })),
    ],
  });
  store.baseline(baseline(p.before), now);
  const step = p.steps[0],
    proof = {
      transactionHash: step.transaction_hash,
      signerId: step.signer_id,
      deployment: foundation.deployment,
      call: createLivingTownCall(step.method, step.args),
      referenceBlockHeight: step.reference_block_height,
    };
  const status = await verifyLivingTownReceipt(step.receipt, proof, async () =>
    block(step.block),
  );
  const indexed = livingTownIndexedReceipt(proof, {
    status,
    response: step.receipt,
  });
  assert.equal(store.commit(indexed, now), "indexed");
  assert.equal(store.town(now).stale, true);
  assert.equal(
    store.cursor().through_event_sequence,
    p.before.town.event_sequence,
  );
  store.baseline(baseline(p.after), now + 1);
  assert.equal(store.commit(indexed, now + 1), "duplicate");
  const inventory = store.inventory("4", now + 1).snapshot.data.inventory;
  assert.equal(inventory.held.herb, "0");
  assert.equal(inventory.held.health_potion, "0");
  assert.equal(inventory.production_output_reserved.health_potion, "3");
  assert.equal(store.town(now + 1).history_complete, false);
});

test("completion snapshot recovery credits finalized output and preserves a newer running promise", (t) => {
  const p = JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/chain/living-town-completion-sandbox.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const f = p.steps[0].foundation,
    identity = {
      deployment: f.deployment,
      codeHash: p.steps[0].account.code_hash,
      ownerId: f.data.owner_account_id,
      operatorId: f.data.operator_account_id,
      controllers: f.data.merchant_controllers,
    };
  const dir = mkdtempSync(join(tmpdir(), "living-town-completion-")),
    store = new LivingTownProjectionStore(dir, identity, true);
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "living-town-completion-")));
    rmSync(dir, { recursive: true, force: true });
  });
  const baseline = (s) => ({
    town: s.town,
    block: block(s.block),
    shops: s.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    production: [
      ...emptyProduction(s.town).slice(0, 3),
      ...s.shops.map((r) => ({ shopId: r.shop.data.shop_id, pages: [r.jobs] })),
    ],
  });
  store.baseline(baseline(p.before), now);
  assert.equal(
    store.inventory("4", now).snapshot.data.inventory.held.health_potion,
    "0",
  );
  store.invalidate();
  store.baseline(baseline(p.completed), now + 1);
  assert.equal(
    store.inventory("4", now + 1).snapshot.data.inventory.held.health_potion,
    "1",
  );
  assert.equal(
    store.inventory("4", now + 1).snapshot.data.inventory
      .production_output_reserved.health_potion,
    "0",
  );
  store.baseline(baseline(p.after), now + 2);
  const before = store.counts();
  store.baseline(baseline(p.after), now + 3);
  assert.deepEqual(store.counts(), before);
  assert.equal(
    store.inventory("4", now + 3).snapshot.data.inventory.held.health_potion,
    "1",
  );
  assert.equal(
    store.inventory("4", now + 3).snapshot.data.inventory
      .production_output_reserved.health_potion,
    "1",
  );
  assert.equal(store.town(now + 3).history_complete, false);
});

test("projector verifies receipt evidence, deduplicates before RPC and bounds coherent snapshot refresh", async (t) => {
  const f = fixture(t);
  let rpcReads = 0,
    snapshot = initial;
  const reader = () => ({
    block: snapshot.block,
    getTown: async () => snapshot.town,
    getListings: async () => controlledMarket(snapshot.town),
    getShop: async () => snapshot.shops[0].shop,
    getShopInventory: async () => snapshot.shops[0].ledger,
    getProductionJobs: async (args) =>
      snapshot.production.find((r) => r.shopId === args.shop_id).pages[0],
  });
  const client = {
    identity,
    receiptEvidence: async (proof) => {
      rpcReads++;
      return evidence[
        proofs.findIndex((p) => p.transactionHash === proof.transactionHash)
      ];
    },
    finalized: async () => reader(),
  };
  const projector = new LivingTownProjector(client, f.store);
  await projector.sync();
  for (const proof of proofs) await projector.ingest(proof, now);
  for (const proof of proofs)
    assert.equal(await projector.ingest(proof, now), "duplicate");
  assert.equal(rpcReads, 6);
  snapshot = final;
  await projector.sync();
  assert.equal(
    f.store.listings(null, 50).snapshot.data.items[0].remaining_quantity,
    "7",
  );
  assert.equal(
    f.store.inventory("4", Date.now()).snapshot.data.gold.held,
    "96",
  );
  await assert.rejects(
    () => projector.ingest({ ...proofs[0], signerId: "other.testnet" }, now),
    /conflicting/,
  );
  client.finalized = async () => {
    throw Error("offline");
  };
  await assert.rejects(() => projector.sync(), /offline/);
  assert.equal(f.store.town(now).stale, true);
});

test("public HTTP town, shop and inventory reads expose freshness/version but no mutation capabilities", async (t) => {
  const f = fixture(t, final);
  const server = createReadServer(
    {
      health: () => readLivingTownHealth(f.store, now),
      activity: () => {
        throw Error("unused");
      },
      livingTown: Object.freeze({
        town: () => f.store.town(now),
        shop: (id) => f.store.shopView(id, now),
        inventory: (id) => f.store.inventory(id, now),
        production: (id, after, limit) =>
          f.store.production(id, after, limit, now),
      }),
      sign: () => {
        throw Error("must not sign");
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  const before = f.store.counts();
  for (const path of ["/api/town", "/api/shops/4", "/api/shops/4/inventory"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.schema, "living-town-read-v1");
    assert.equal(body.deployment.api_version, "2.0.0");
    assert.equal(body.history_complete, false);
    assert.equal(body.stale, false);
    assert.equal(body.checkpoint.verified_code_hash, identity.codeHash);
  }
  assert.equal((await fetch(origin + "/api/shops/999")).status, 404);
  assert.equal((await fetch(origin + "/api/town?sign=1")).status, 400);
  assert.equal(
    (await fetch(origin + "/api/shops/18446744073709551616")).status,
    400,
  );
  assert.equal(
    (await fetch(origin + "/api/town", { method: "POST" })).status,
    405,
  );
  assert.equal((await fetch(origin + "/api/sign")).status, 404);
  const head = await fetch(origin + "/api/shops/4/inventory", {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(origin + "/health")).status, 200);
  f.store.invalidate();
  assert.equal((await (await fetch(origin + "/api/town")).json()).stale, true);
  assert.equal((await fetch(origin + "/health")).status, 503);
  assert.deepEqual(f.store.counts(), before);
});

test("V2 worker configuration and private receipt inbox are bounded, exact and never accept write/secret fields", (t) => {
  const f = fixture(t, null),
    namedIdentity = {
      ...identity,
      deployment: { ...identity.deployment, contract_id: "reader-v2.testnet" },
    };
  const value = {
    schema: "bot-bazaar-living-town-reader-v1",
    identity: namedIdentity,
    public: {
      networkId: "testnet",
      contractId: "reader-v2.testnet",
      rpcUrl: "https://test.rpc.fastnear.com",
      explorerUrl: "https://testnet.nearblocks.io",
      workerUrl: "http://127.0.0.1:3011",
    },
    data_dir: f.dir,
    receipt_inbox: null,
    port: "3011",
    poll_ms: "3000",
    allowed_origins: ["http://127.0.0.1:4201"],
  };
  assert.equal(parseLivingTownWorkerConfig(value).port, 3011);
  assert.throws(() =>
    parseLivingTownWorkerConfig({ ...value, private_key: "never" }),
  );
  assert.throws(() =>
    parseLivingTownWorkerConfig({
      ...value,
      public: { ...value.public, contractId: "other.testnet" },
    }),
  );
  assert.throws(() => parseLivingTownWorkerConfig({ ...value, port: 3011 }));
  const inbox = join(f.dir, "inbox.json");
  const request = {
    transaction_hash: proofs[0].transactionHash,
    signer_id: proofs[0].signerId,
    method: proofs[0].call.method,
    args: proofs[0].call.args,
    reference_block_height: proofs[0].referenceBlockHeight,
  };
  writeFileSync(
    inbox,
    JSON.stringify({
      schema: "living-town-receipt-inbox-v1",
      requests: [request],
    }),
  );
  assert.equal(readReceiptInbox(inbox, identity).length, 1);
  writeFileSync(
    inbox,
    JSON.stringify({
      schema: "living-town-receipt-inbox-v1",
      requests: Array(101).fill(request),
    }),
  );
  assert.throws(() => readReceiptInbox(inbox, identity), /bounded/);
});

test("standalone read worker restarts against the same SQLite projection without duplicating shops", async (t) => {
  const f = fixture(t, null),
    probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const target = "projection-reader.testnet",
    namedIdentity = {
      ...identity,
      ownerId: target,
      deployment: { ...identity.deployment, contract_id: target },
    },
    config = join(f.dir, "reader.json"),
    bootstrap = join(f.dir, "rpc-double.mjs");
  const runtime = join(f.dir, "runtime");
  writeFileSync(
    config,
    JSON.stringify({
      schema: "bot-bazaar-living-town-reader-v1",
      identity: namedIdentity,
      public: {
        networkId: "testnet",
        contractId: target,
        rpcUrl: "https://test.rpc.fastnear.com",
        explorerUrl: "https://testnet.nearblocks.io",
        workerUrl: `http://127.0.0.1:${port}`,
      },
      data_dir: runtime,
      receipt_inbox: null,
      port: String(port),
      poll_ms: "1000",
      allowed_origins: [],
    }),
  );
  // Complete process integration with deterministic RPC doubles. No public RPC
  // or real Testnet identity is claimed for these remapped local snapshots.
  const input = {
    identity: namedIdentity,
    final,
    foundation,
    market: controlledMarket(final.town),
  };
  writeFileSync(
    bootstrap,
    `
const input=${JSON.stringify(input)};
globalThis.fetch=async(_url,options)=>{
 const q=JSON.parse(options.body),p=q.params;let result;
 if(q.method==='status')result={chain_id:'testnet',sync_info:{syncing:false}};
 else if(q.method==='EXPERIMENTAL_genesis_config')result={chain_id:'testnet',genesis_height:7};
 else if(q.method==='block')result={header:p.block_id===7?{height:7,hash:input.identity.deployment.genesis_hash}:{hash:input.final.block.hash,height:input.final.block.height,timestamp_nanosec:input.final.block.timestampNs}};
 else if(q.method==='query'){
  if(p.request_type==='view_account')result={block_hash:input.final.block.hash,block_height:input.final.block.height,code_hash:input.identity.codeHash};
  else {let s;
   if(p.method_name==='get_foundation'){s=structuredClone(input.foundation);s.data.owner_account_id=input.identity.ownerId;}
   else if(p.method_name==='get_town')s=structuredClone(input.final.town);
   else if(p.method_name==='get_listings')s=structuredClone(input.market);
   else if(p.method_name==='get_shop')s=structuredClone(input.final.shops[0].shop);
   else if(p.method_name==='get_shop_inventory')s=structuredClone(input.final.shops[0].ledger);
   else if(p.method_name==='get_production_jobs')s=structuredClone(input.final.production[0].pages[0]);
   else throw Error('unexpected read');
   s.deployment=input.identity.deployment;s.block_height=input.final.block.height;s.block_timestamp_ns=input.final.block.timestampNs;s.market_revision=input.final.town.market_revision;s.event_sequence=input.final.town.event_sequence;
   result={block_hash:input.final.block.hash,block_height:input.final.block.height,result:Array.from(Buffer.from(JSON.stringify(s)))};
  }
 }else throw Error('mutation or unexpected RPC denied');
 return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
};`,
  );
  let child,
    errors = "";
  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, "close");
    }
    child = undefined;
  };
  t.after(stop);
  const run = async () => {
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(bootstrap).href,
        "apps/worker/dist/living-town.js",
        "--config",
        config,
        "--initialize",
      ],
      {
        cwd: new URL("../../../", import.meta.url),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    child.stderr.on("data", (c) => {
      errors = (errors + c.toString()).slice(-16384);
    });
    // The production reader deliberately spaces RPC calls; allow its complete cold scan.
    for (let i = 0; i < 800; i++) {
      if (child.exitCode !== null) throw Error("read worker exited: " + errors);
      try {
        const r = await fetch(
          `http://127.0.0.1:${port}/api/shops/4/inventory`,
          { signal: AbortSignal.timeout(500) },
        );
        if (r.status === 200) {
          const body = await r.json();
          if (!body.stale) return body;
        }
      } catch {
        /* Startup can briefly precede the listening socket. */
      }
      await delay(50);
    }
    throw Error("read worker not ready: " + errors);
  };
  const first = await run();
  assert.equal(first.snapshot.data.gold.held, "96");
  await stop();
  const second = await run();
  assert.equal(second.snapshot.data.gold.held, "96");
  assert.equal(
    second.checkpoint.feed_generation,
    first.checkpoint.feed_generation,
  );
  assert.equal(second.history_complete, false);
  await stop();
  const db = new DatabaseSync(join(runtime, "living-town.sqlite"));
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM projection_shops").get().n,
      4,
    );
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    db.close();
  }
});
