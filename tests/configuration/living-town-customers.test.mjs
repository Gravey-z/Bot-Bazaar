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
  FinalizedLivingTownReader,
} from "../../packages/chain/dist/index.js";
import { LivingTownProjectionStore } from "../../apps/worker/dist/private/living-town/store.js";
const p = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-customers-sandbox.json",
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
test("actual customer receipts enforce one-unit sinks, operator correlation and capped funding including zero", () => {
  assert.equal(statuses.length, 12);
  assert(statuses.every((s) => s.kind === "succeeded"));
  assert.equal(events.filter((e) => e.event !== null).length, 9);
  const originals = statuses
    .filter((s) => !s.result.data.replayed)
    .map((s) => s.result.data.outcome);
  const funds = originals.filter((o) => o.kind === "customer_funded"),
    sales = originals.filter((o) => o.kind === "customer_sale");
  assert.deepEqual(
    funds.map((o) => o.issued_gold),
    ["100", "100", "2", "0"],
  );
  assert.equal(sales.length, 5);
  for (const sale of sales) {
    assert.equal(sale.trade.buyer, null);
    assert.equal(sale.trade.quantity, "1");
    assert.equal(sale.trade.consumed_quantity, "1");
    assert.equal(sale.trade.customer_pool_id, "town_customers");
  }
  for (const i of [1, 6, 11]) assert.equal(events[i].event, null);
  assert.equal(
    canonicalLivingTownJson(statuses[1].result.data.outcome),
    canonicalLivingTownJson(statuses[0].result.data.outcome),
  );
  assert.equal(
    p.after.town.data.customer_pool.last_funded_epoch,
    p.steps[10].args.epoch,
  );
  assert(
    BigInt(p.after.town.data.customer_pool.epoch) >
      BigInt(p.after.town.data.customer_pool.last_funded_epoch),
  );
});
test("actual funded purchases reconcile gold sources and every item sink without invented inventory", () => {
  const ledgers = (s) => [
    ...s.town.data.npc_ledgers,
    ...s.shops.map((row) => row.ledger.data),
  ];
  for (const snapshot of [
    p.before,
    p.after_quota,
    p.rollover,
    p.after_sale,
    p.after,
  ]) {
    const t = snapshot.town.data,
      totals = t.totals;
    const gold = ledgers(snapshot).reduce(
      (sum, l) => sum + BigInt(l.gold.held),
      BigInt(t.customer_pool.gold),
    );
    assert.equal(
      gold,
      BigInt(totals.initial_gold) +
        BigInt(totals.player_grants) +
        BigInt(totals.customer_topups) -
        BigInt(totals.upgrade_burns) -
        BigInt(totals.treasury_burns),
    );
    for (const item of Object.keys(totals.seed_items)) {
      const held = ledgers(snapshot).reduce(
        (sum, l) => sum + BigInt(l.inventory.held[item]),
        0n,
      );
      assert.equal(
        held +
          BigInt(totals.recipe_inputs_consumed[item]) +
          BigInt(totals.customer_consumed[item]),
        BigInt(totals.seed_items[item]) +
          BigInt(totals.supplied_items[item]) +
          BigInt(totals.completed_outputs[item]),
      );
    }
  }
  assert.equal(p.after.town.data.totals.customer_topups, "202");
  assert.equal(p.after.town.data.customer_pool.gold, "200");
  assert.equal(p.after.town.data.totals.customer_consumed.health_potion, "3");
  assert.equal(p.after.town.data.totals.customer_consumed.iron_tool, "2");
  assert.equal(p.after.shops[0].ledger.data.inventory.held.health_potion, "0");
  assert.equal(p.after.shops[1].ledger.data.inventory.held.iron_tool, "1");
  assert.equal(p.after.shops[0].ledger.data.gold.held, "124");
  assert.equal(p.after.shops[1].ledger.data.gold.held, "112");
});
test("customer codecs reject arbitrary buyer, quantity, issuance and forged source/sink effects", async () => {
  const args = p.steps[0].args;
  for (const [key, value] of [
    ["buyer_account_id", "other.testnet"],
    ["quantity", "2"],
    ["epoch", 1],
    ["listing_id", "0"],
    ["expected_listing_revision", null],
    ["max_total_price", "0"],
    ["max_total_price", "10001"],
  ])
    assert.throws(() =>
      createLivingTownCall("settle_customer_purchase", {
        ...args,
        [key]: value,
      }),
    );
  assert.throws(() =>
    createLivingTownCall("fund_customer_budget", {
      ...p.steps[5].args,
      amount: "100",
    }),
  );
  for (const mutate of [
    (v) =>
      (v.data.outcome.trade.buyer = {
        kind: "player",
        account_id: "other.testnet",
      }),
    (v) => (v.data.outcome.trade.quantity = "2"),
    (v) => (v.data.outcome.trade.consumed_quantity = "0"),
    (v) => (v.data.outcome.trade.customer_pool_id = null),
    (v) => (v.data.outcome.pool.potion_units_bought = "0"),
    (v) => (v.data.outcome.listing.remaining_quantity = "3"),
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
  for (const mutate of [
    (v) => (v.data.outcome.issued_gold = "101"),
    (v) => (v.data.outcome.issued_gold = "99"),
    (v) => (v.data.outcome.pool.gold = "201"),
    (v) => (v.data.outcome.pool.last_funded_epoch = "0"),
  ]) {
    const forged = structuredClone(statuses[5].result);
    mutate(forged);
    await assert.rejects(
      verifyLivingTownEffect(
        forged,
        identity.deployment,
        p.steps[5].signer_id,
        proofs[5].call,
      ),
    );
  }
});
test("pinned trade and operator-command reads distinguish customer sinks from raw transfers and zero funding", async () => {
  const finalized = block(p.after.block);
  const reader = new FinalizedLivingTownReader(
    async (method, args) => {
      assert.equal(method, "query");
      assert.equal(args.block_id, finalized.hash);
      const value =
        args.method_name === "get_trade" ? p.trade : p.operator_command;
      return {
        block_hash: finalized.hash,
        block_height: finalized.height,
        result: Array.from(Buffer.from(JSON.stringify(value))),
      };
    },
    identity,
    finalized,
  );
  const trade = await reader.getTrade("5");
  assert.equal(trade.data.kind, "found");
  assert.equal(trade.data.value.kind, "customer_sale");
  assert.equal(trade.data.value.buyer, null);
  const cmd = await reader.getCommand(identity.operatorId, "9");
  assert.equal(cmd.data.kind, "found");
  assert.equal(cmd.data.effect.outcome.kind, "customer_funded");
  assert.equal(cmd.data.effect.outcome.issued_gold, "0");
});
test("customer projections remain stale until baseline recovery and epoch rollover resets only quota hints", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "living-town-customers-"));
  const store = new LivingTownProjectionStore(dir, identity, true);
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "living-town-customers-")));
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
  // Empty NPC production pages are controlled inputs; player queues, ledgers,
  // pool snapshots and effect receipts are actual captures of this contract.
  store.baseline(baseline(p.before));
  store.commit(events[0]);
  assert.equal(store.town().stale, true);
  assert.equal(store.inventory("4").snapshot.data.gold.held, "70");
  store.baseline(baseline(p.after_quota));
  assert.equal(
    store.town().snapshot.data.customer_pool.potion_units_bought,
    "2",
  );
  const before = store.inventory("4").snapshot.data;
  assert.equal(store.observe(p.rollover.town, block(p.rollover.block)), true);
  assert.equal(
    store.town().snapshot.data.customer_pool.potion_units_bought,
    "0",
  );
  assert.equal(store.town().snapshot.data.customer_pool.gold, "16");
  assert.equal(
    canonicalLivingTownJson(store.inventory("4").snapshot.data),
    canonicalLivingTownJson(before),
  );
  for (const event of events) store.commit(event);
  store.baseline(baseline(p.after));
  assert.equal(store.town().snapshot.data.customer_pool.gold, "200");
  assert.equal(store.town().snapshot.data.totals.customer_topups, "202");
  assert.equal(store.inventory("4").snapshot.data.gold.held, "124");
  assert.equal(store.town().history_complete, false);
});
