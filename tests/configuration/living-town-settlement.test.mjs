import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  verifyLivingTownEffect,
  livingTownIndexedReceipt,
  canonicalLivingTownJson,
} from "../../packages/chain/dist/index.js";
import { LivingTownProjectionStore } from "../../apps/worker/dist/private/living-town/store.js";
const p = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-settlement-sandbox.json",
    "utf8",
  ),
);
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
const foundation = p.steps[0].foundation;
const identity = {
  deployment: foundation.deployment,
  codeHash: p.steps[0].account.code_hash,
  ownerId: foundation.data.owner_account_id,
  operatorId: foundation.data.operator_account_id,
  controllers: foundation.data.merchant_controllers,
};
const proofs = p.steps.map((s) => ({
  transactionHash: s.transaction_hash,
  signerId: s.signer_id,
  deployment: identity.deployment,
  call: createLivingTownCall(s.method, s.args),
  referenceBlockHeight: s.reference_block_height,
}));
const statuses = await Promise.all(
  p.steps.map((s, i) =>
    verifyLivingTownReceipt(s.receipt, proofs[i], async () => block(s.block)),
  ),
);
const events = p.steps.map((s, i) =>
  livingTownIndexedReceipt(proofs[i], {
    status: statuses[i],
    response: s.receipt,
  }),
);
test("actual edited-listing purchases bind quotes and cached receipts return original effects after another sale/reprice", () => {
  assert.equal(statuses.length, 5);
  assert(statuses.every((s) => s.kind === "succeeded"));
  assert.deepEqual(
    statuses.map((s) => s.result.data.replayed),
    [false, true, false, true, false],
  );
  assert.equal(events.filter((e) => e.event !== null).length, 3);
  assert.deepEqual(
    statuses.map((s) => s.result.data.outcome.trade.trade_id),
    ["1", "1", "2", "1", "3"],
  );
  assert.deepEqual(
    statuses.map((s) => s.result.data.outcome.trade.total_price),
    ["5", "5", "5", "5", "6"],
  );
  assert.equal(
    canonicalLivingTownJson(statuses[3].result.data.outcome),
    canonicalLivingTownJson(statuses[0].result.data.outcome),
  );
  assert(
    BigInt(statuses[3].result.market_revision) >
      BigInt(statuses[0].result.market_revision),
  );
  assert.equal(statuses[3].result.data.outcome.listing.unit_price, "5");
  assert.equal(statuses[4].result.data.outcome.listing.unit_price, "6");
  assert.equal(statuses[4].result.data.outcome.listing.revision, "7");
});
test("settlement conserves all held items and game gold without consuming customer budget or creating sources", () => {
  const ledgers = (s) => [
    ...s.town.data.npc_ledgers,
    ...s.shops.map((r) => r.ledger.data),
  ];
  const gold = (s) =>
    ledgers(s).reduce(
      (sum, l) => sum + BigInt(l.gold.held),
      BigInt(s.town.data.customer_pool.gold),
    );
  assert.equal(gold(p.before), 900n);
  assert.equal(gold(p.after), 900n);
  for (const item of Object.keys(
    p.before.shops[0].ledger.data.inventory.held,
  )) {
    const total = (s) =>
      ledgers(s).reduce((sum, l) => sum + BigInt(l.inventory.held[item]), 0n);
    assert.equal(total(p.before), total(p.after));
  }
  assert.equal(p.after.shops[0].ledger.data.gold.held, "89");
  assert.equal(p.after.shops[1].ledger.data.gold.held, "95");
  assert.equal(p.after.town.data.npc_ledgers[0].gold.held, "216");
  assert.equal(
    p.after.town.data.npc_ledgers[0].inventory.listing_reserved.crystal,
    "0",
  );
  assert.equal(
    p.after.town.data.customer_pool.gold,
    p.before.town.data.customer_pool.gold,
  );
  assert.equal(
    canonicalLivingTownJson(p.after.town.data.totals),
    canonicalLivingTownJson(p.before.town.data.totals),
  );
});
test("purchase codecs and effect checks reject arbitrary counterparties, products and forged settlement math", async () => {
  const args = p.steps[0].args;
  for (const [key, value] of [
    ["buyer_account_id", "other.testnet"],
    ["merchant_id", "player.testnet"],
    ["item_id", "health_potion"],
    ["quantity", "0"],
    ["quantity", "101"],
    ["max_total_price", "0"],
    ["max_total_price", "10001"],
  ])
    assert.throws(() =>
      createLivingTownCall("buy_from_merchant", { ...args, [key]: value }),
    );
  assert.throws(() => createLivingTownCall("purchase_listing", args));
  for (const mutate of [
    (v) => (v.data.outcome.trade.buyer.account_id = "other.testnet"),
    (v) => (v.data.outcome.trade.quantity = "2"),
    (v) => (v.data.outcome.trade.total_price = "4"),
    (v) => (v.data.outcome.listing.revision = "99"),
    (v) => (v.data.outcome.buyer.gold.available = "100"),
    (v) => (v.data.outcome.seller.inventory.listing_reserved.crystal = "2"),
  ]) {
    const forged = structuredClone(statuses[0].result);
    mutate(forged);
    await assert.rejects(
      verifyLivingTownEffect(
        forged,
        identity.deployment,
        p.steps[0].signer_id,
        proofs[0].call,
      ),
    );
  }
});
test("a late verified purchase replay cannot overwrite balances or hide a newer finalized state from recovery", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "living-town-settlement-"));
  const store = new LivingTownProjectionStore(dir, identity, true);
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "living-town-settlement-")));
    rmSync(dir, { recursive: true, force: true });
  });
  const baseline = (s) => ({
    block: block(s.block),
    town: s.town,
    shops: s.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    production: [
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
  });
  // Empty NPC production pages are controlled; player snapshots and receipts
  // belong to the actual same disposable sandbox contract.
  store.baseline(baseline(p.before));
  store.commit(events[0]);
  store.commit(events[1]);
  store.commit(events[2]);
  assert.equal(store.inventory("4").snapshot.data.gold.held, "95");
  const cursor = store.cursor();
  const before = store.inventory("4").snapshot.data;
  const town = store.town().snapshot;
  const older = {
    town,
    block: {
      header: {
        hash: cursor.finalized_block_hash,
        height: cursor.finalized_block_height,
        timestamp_nanosec: town.block_timestamp_ns,
      },
    },
    shops: ["4", "5"].map((id) => ({
      shop: store.shopView(id).snapshot,
      ledger: store.inventory(id).snapshot,
      jobs: {
        ...town,
        data: {
          items: [],
          next_after_id: null,
          has_more: false,
          history_gap: false,
          pruned_through: "0",
        },
      },
    })),
  };
  store.commit(events[3]);
  assert.equal(store.inventory("4").stale, true);
  assert.equal(
    canonicalLivingTownJson(store.inventory("4").snapshot.data),
    canonicalLivingTownJson(before),
  );
  assert.equal(
    store.cursor().through_event_sequence,
    cursor.through_event_sequence,
  );
  assert.throws(() => store.baseline(baseline(older)), /rewind/);
  store.commit(events[4]);
  store.baseline(baseline(p.after));
  assert.equal(store.inventory("4").snapshot.data.gold.held, "89");
  assert.equal(store.inventory("5").snapshot.data.gold.held, "95");
  for (const event of events) assert.equal(store.commit(event), "duplicate");
  assert.equal(store.counts().events, 3);
});
