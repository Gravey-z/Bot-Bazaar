import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LivingTownAccounting } from "../dist/private/living-town/accounting.js";
import { projectionSchema } from "../dist/private/living-town/schema.js";
import { encodeCostUnits } from "../dist/private/living-town/cost-lots.js";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
} from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import {
  runtimeMethods,
  townMerchantMethods,
  townSourceMethods,
  townOperatorMethods,
  customerRuntimeMethods,
} from "../dist/private/near-signer.js";
const f = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-upgrade-sandbox.json", "utf8"),
);
const u = f.steps.find((s) => s.method === "purchase_upgrade" && s.succeeded);
const identity = {
  deployment: u.foundation.deployment,
  codeHash: u.account.code_hash,
  ownerId: u.foundation.data.owner_account_id,
  operatorId: u.foundation.data.operator_account_id,
  controllers: u.foundation.data.merchant_controllers,
};
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
const records = await Promise.all(
  f.steps.map(async (s) => {
    const complete = s.method === "complete_production",
      proof = {
        transactionHash: s.transaction_hash,
        signerId: s.signer_id,
        deployment: identity.deployment,
        call: complete
          ? createLivingTownCompletionCall(s.args)
          : createLivingTownCall(s.method, s.args),
        referenceBlockHeight: s.reference_block_height,
      };
    const status = await (
      complete ? verifyLivingTownCompletionReceipt : verifyLivingTownReceipt
    )(s.receipt, proof, async () => block(s.block));
    return (complete ? livingTownIndexedCompletion : livingTownIndexedReceipt)(
      proof,
      { status, response: s.receipt },
    );
  }),
);
test("actual upgrade burn projects once, preserves profit/COGS and rebuilds with two-slot state", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-upgrade-"));
  let store = new LivingTownProjectionStore(dir, identity, true);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const baseline = { ...f.baseline, block: block(f.baseline.block) };
  store.baseline(baseline);
  for (const r of records) store.commit(r);
  const history = store.history("4", null, 50).snapshot.data;
  assert.equal(history.costs.recorded_upgrade_spending, "150");
  assert.equal(history.costs.recorded_sales_revenue, "180");
  assert.equal(history.costs.recorded_material_spending, "120");
  assert.equal(history.costs.recorded_cogs, "96");
  assert.equal(history.costs.recorded_profit, "84");
  assert.equal(history.costs.unsold_inventory_cost, "24");
  assert.equal(history.costs.work_in_progress_cost, "0");
  assert.equal(history.costs.recorded_cash_change, "10");
  assert.equal(
    history.costs.recorded_cash_change,
    f.baseline.shops[0].ledger.data.gold.held,
  );
  assert.equal(history.costs.native_fee_history_complete, true);
  assert.ok(BigInt(history.costs.recorded_native_fees_yocto) > 0n);
  const burns = history.items.filter((r) => r.kind === "upgrade_purchase");
  assert.equal(burns.length, 1);
  assert.equal(burns[0].gold_amount, "150");
  assert.equal(burns[0].cogs, null);
  assert.equal(burns[0].profit, null);
  const upgraded = records.find(
    (r) => r.proof.transactionHash === u.transaction_hash,
  );
  assert.equal(store.commit(upgraded), "duplicate");
  assert.deepEqual(store.history("4").snapshot.data.costs, history.costs);
  store.close();
  store = new LivingTownProjectionStore(dir, identity);
  store.baseline(baseline);
  assert.deepEqual(store.history("4").snapshot.data.costs, history.costs);
  assert.equal(store.shopView("4").snapshot.data.production_slots, "2");
});
test("automatic runtime scopes cannot sign an owner upgrade", () => {
  for (const methods of [
    runtimeMethods,
    townMerchantMethods,
    townSourceMethods,
    townOperatorMethods,
    customerRuntimeMethods,
  ])
    assert.equal(methods.includes("purchase_upgrade"), false);
});

// Isolated real accounting storage, fed only SDK-verified actual fixture effects.
function costEngine(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(projectionSchema);
  t.after(() => db.close());
  const accounting = new LivingTownAccounting(db);
  return {
    db,
    accounting,
    add(r) {
      const s = r.status;
      db.prepare("INSERT INTO projection_receipts VALUES(?,?,?,?,?,?,?)").run(
        r.proof.transactionHash,
        "verified fixture",
        s.executionReceiptId,
        s.block.hash,
        s.block.height,
        s.kind,
        0,
      );
      accounting.recordFee(r);
      if (r.event) {
        db.prepare("INSERT INTO projection_events VALUES(?,?,?,?)").run(
          s.result.event_sequence,
          s.executionReceiptId,
          String(r.logIndex),
          JSON.stringify({ result: s.result }),
        );
        accounting.record(s.result);
      }
      accounting.advance();
    },
  };
}
test("acquisition cost moves from inventory to WIP to output and only sold units become COGS", (t) => {
  const e = costEngine(t),
    actor = `account:${u.signer_id}`;
  let start, completion, sale;
  for (const r of records) {
    e.add(r);
    const o =
      r.status.kind === "succeeded" ? r.status.result.data.outcome : null;
    const costs = e.accounting.summary(actor, e.accounting.through());
    if (o?.kind === "production_started" && !start) {
      start = costs;
      assert.equal(costs.unsold_inventory_cost, "0");
      assert.equal(costs.work_in_progress_cost, "30");
      assert.equal(costs.recorded_cogs, "0");
    }
    if (o?.kind === "production_completed" && !completion) {
      completion = costs;
      assert.equal(costs.unsold_inventory_cost, "30");
      assert.equal(costs.work_in_progress_cost, "0");
    }
    if (o?.kind === "customer_sale" && !sale) {
      sale = costs;
      assert.equal(costs.recorded_sales_revenue, "18");
      assert.equal(costs.recorded_material_spending, "30");
      assert.equal(costs.recorded_cogs, "10");
      assert.equal(costs.recorded_profit, "8");
      assert.equal(costs.unsold_inventory_cost, "20");
      assert.equal(costs.recorded_cash_change, "88");
      break;
    }
  }
  assert.ok(start && completion && sale);
});
test("mixed-cost unsold lots total exactly; unknown lots and checkpoints ahead of the view remain unknown", (t) => {
  const e = costEngine(t);
  for (const r of records) e.add(r);
  const actor = `account:${u.signer_id}`,
    through = e.accounting.through();
  const put = (units) =>
    e.db
      .prepare(
        "UPDATE cost_inventory SET units=? WHERE actor=? AND item='iron_tool'",
      )
      .run(encodeCostUnits(units), actor);
  const unit = (cost, ordinal) => ({ cost, source: through, ordinal });
  put([unit("7", "0"), unit("8", "1")]);
  assert.equal(
    e.accounting.summary(actor, through).unsold_inventory_cost,
    "15",
  );
  put([unit("7", "0"), unit(null, "1")]);
  assert.equal(
    e.accounting.summary(actor, through).unsold_inventory_cost,
    null,
  );
  assert.equal(
    e.accounting.summary(actor, String(BigInt(through) - 1n))
      .work_in_progress_cost,
    null,
  );
});
test("missing gas amounts never become zero and another signer's fees cannot inflate owner fees", (t) => {
  const e = costEngine(t),
    actor = `account:${u.signer_id}`;
  for (const r of records) e.add(r);
  const original = e.accounting.summary(actor, e.accounting.through());
  const op = e.db
    .prepare("SELECT tx_hash FROM projection_fees WHERE actor=? LIMIT 1")
    .get(`account:${identity.operatorId}`);
  assert.ok(op);
  e.db
    .prepare("UPDATE projection_fees SET amount=NULL WHERE tx_hash=?")
    .run(op.tx_hash);
  assert.equal(
    e.accounting.summary(actor, e.accounting.through())
      .recorded_native_fees_yocto,
    original.recorded_native_fees_yocto,
  );
  e.db
    .prepare("UPDATE projection_fees SET amount=NULL WHERE actor=?")
    .run(actor);
  const unknown = e.accounting.summary(actor, e.accounting.through());
  assert.equal(unknown.recorded_native_fees_yocto, null);
  assert.equal(unknown.native_fee_history_complete, false);
  assert.equal(unknown.recorded_cash_change, original.recorded_cash_change);
});
test("a verified receipt without its raw gas archive keeps native fees unknown", (t) => {
  const e = costEngine(t);
  e.add({ ...records[0], response: undefined });
  const costs = e.accounting.summary(
    `account:${u.signer_id}`,
    e.accounting.through(),
  );
  assert.equal(costs.recorded_native_fees_yocto, null);
  assert.equal(costs.native_fee_history_complete, false);
});
