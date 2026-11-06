import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
  livingTownSourceEffect,
  livingTownSourceState,
} from "../../packages/chain/dist/index.js";
const p = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sources-sandbox.json", "utf8"),
);
const n = BigInt;
const verified = await Promise.all(
  p.steps.map(async (s) => {
    const completion = s.method === "complete_production",
      proof = {
        transactionHash: s.transaction_hash,
        signerId: s.signer_id,
        deployment: s.foundation.deployment,
        call: completion
          ? createLivingTownCompletionCall(s.args)
          : createLivingTownCall(s.method, s.args),
        referenceBlockHeight: s.reference_block_height,
      };
    const status = await (
      completion ? verifyLivingTownCompletionReceipt : verifyLivingTownReceipt
    )(s.receipt, proof, async (hash) => {
      assert.equal(hash, s.block.header.hash);
      return {
        hash,
        height: String(s.block.header.height),
        timestampNs: s.block.header.timestamp_nanosec,
      };
    });
    assert.equal(status.kind, "succeeded");
    return (
      completion ? livingTownIndexedCompletion : livingTownIndexedReceipt
    )(proof, { status, response: s.receipt });
  }),
);
test("actual source and sink receipts verify exact methods, fixed recipients, formulas and replay event suppression", () => {
  const sources = p.steps.filter((s) => s.method === "allocate_raw_supply"),
    sweeps = p.steps.filter((s) => s.method === "sweep_merchant_treasury");
  assert(sources.length >= 16);
  assert.equal(sweeps.length, 12);
  for (const s of [...sources, ...sweeps]) {
    const e = livingTownSourceEffect(s.effect.data);
    assert.equal(s.signer_id, s.foundation.data.operator_account_id);
    assert.equal(e.outcome.epoch, s.args.epoch);
    assert.equal(e.outcome.ledger.actor.merchant_id, e.outcome.merchant_id);
    assert.equal(verified[p.steps.indexOf(s)].event === null, e.replayed);
  }
  assert(sources.some((s) => s.effect.data.outcome.issued_quantity === "0"));
  assert(sources.some((s) => n(s.effect.data.outcome.issued_quantity) > 0n));
  assert(sweeps.some((s) => n(s.effect.data.outcome.burned_gold) > 0n));
});
test("four actual buy/craft/sell loops exceed initialized seed and reconcile gold and all six item sources/sinks", () => {
  for (const point of p.checkpoints) {
    const t = point.town.data,
      totals = t.totals,
      ledgers = [...t.npc_ledgers, point.player.data];
    assert.equal(
      ledgers.reduce((sum, l) => sum + n(l.gold.held), n(t.customer_pool.gold)),
      n(totals.initial_gold) +
        n(totals.player_grants) +
        n(totals.customer_topups) -
        n(totals.upgrade_burns) -
        n(totals.treasury_burns),
    );
    for (const item of Object.keys(totals.seed_items)) {
      assert.equal(
        ledgers.reduce((sum, l) => sum + n(l.inventory.held[item]), 0n) +
          n(totals.recipe_inputs_consumed[item]) +
          n(totals.customer_consumed[item]),
        n(totals.seed_items[item]) +
          n(totals.supplied_items[item]) +
          n(totals.completed_outputs[item]),
        item,
      );
      for (const l of ledgers) {
        const i = l.inventory;
        assert.equal(
          n(i.held[item]),
          n(i.available[item]) +
            n(i.listing_reserved[item]) +
            n(i.trade_reserved[item]),
        );
        assert(
          n(i.held[item]) +
            n(i.production_output_reserved[item]) +
            n(i.trade_inbound_reserved[item]) <=
            1000n,
        );
      }
    }
  }
  const last = p.checkpoints.at(-1).town.data.totals;
  assert.equal(last.recipe_inputs_consumed.crystal, "12");
  assert.equal(last.recipe_inputs_consumed.herb, "24");
  assert(n(last.recipe_inputs_consumed.crystal) > n(last.seed_items.crystal));
  assert(n(last.recipe_inputs_consumed.herb) > n(last.seed_items.herb));
  assert.equal(last.customer_consumed.health_potion, "8");
  assert.equal(last.completed_outputs.health_potion, "12");
});
test("persistent per-item and treasury markers survive zero allocations and source totals equal original effects only", () => {
  const final = p.checkpoints.at(-1),
    markers = livingTownSourceState(final.sources.data),
    issued = { crystal: 0n, wood: 0n, herb: 0n, iron: 0n };
  let burns = 0n;
  const allocated = new Set();
  for (const s of p.steps) {
    const e = s.effect?.data;
    if (!e || e.replayed) continue;
    if (e.outcome.kind === "raw_supplied") {
      const o = e.outcome,
        key = `${o.item_id}:${o.epoch}`;
      assert(!allocated.has(key));
      allocated.add(key);
      issued[o.item_id] += n(o.issued_quantity);
      assert(n(markers.raw_epochs[o.item_id]) >= n(o.epoch));
    }
    if (e.outcome.kind === "treasury_swept") {
      const o = e.outcome,
        key = `${o.merchant_id}:${o.epoch}`;
      assert(!allocated.has(key));
      allocated.add(key);
      burns += n(o.burned_gold);
      assert(n(o.ledger.gold.available) >= 200n);
      assert(n(markers.treasury_epochs[o.merchant_id]) >= n(o.epoch));
    }
  }
  for (const [item, value] of Object.entries(issued))
    assert.equal(n(final.town.data.totals.supplied_items[item]), value);
  assert.equal(n(final.town.data.totals.treasury_burns), burns);
});
test("strict SDK source boundaries reject product minting, recipient/quantity overrides and forged economic effects", () => {
  const s = p.steps.find(
      (s) => s.method === "allocate_raw_supply" && !s.effect.data.replayed,
    ),
    args = s.args;
  assert.throws(() =>
    createLivingTownCall("allocate_raw_supply", {
      ...args,
      item_id: "iron_tool",
    }),
  );
  assert.throws(() =>
    createLivingTownCall("allocate_raw_supply", {
      ...args,
      recipient_id: s.signer_id,
    }),
  );
  assert.throws(() =>
    createLivingTownCall("allocate_raw_supply", { ...args, quantity: "1000" }),
  );
  const e = structuredClone(s.effect.data);
  e.outcome.issued_quantity = "8";
  assert.throws(() => livingTownSourceEffect(e));
  const wrong = structuredClone(s.effect.data);
  wrong.outcome.merchant_id = "bolt";
  assert.throws(() => livingTownSourceEffect(wrong));
});
