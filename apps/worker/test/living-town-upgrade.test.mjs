import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  const burns = history.items.filter((r) => r.kind === "upgrade_purchase");
  assert.equal(burns.length, 1);
  assert.equal(burns[0].gold_amount, "150");
  assert.equal(burns[0].cogs, null);
  assert.equal(burns[0].profit, null);
  const upgraded = records.find(
    (r) => r.proof.transactionHash === u.transaction_hash,
  );
  assert.equal(store.commit(upgraded), "duplicate");
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
