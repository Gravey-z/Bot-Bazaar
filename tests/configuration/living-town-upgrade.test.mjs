import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
  verifyLivingTownEffect,
  livingTownUpgrade,
  livingTownFoundation,
} from "../../packages/chain/dist/index.js";
const f = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-upgrade-sandbox.json", "utf8"),
);
const upgrade = f.steps.find(
  (s) => s.method === "purchase_upgrade" && s.succeeded,
);
const identity = {
  deployment: upgrade.foundation.deployment,
  codeHash: upgrade.account.code_hash,
  ownerId: upgrade.foundation.data.owner_account_id,
  operatorId: upgrade.foundation.data.operator_account_id,
  controllers: upgrade.foundation.data.merchant_controllers,
};
const block = (s) => ({
  hash: s.block.header.hash,
  height: String(s.block.header.height),
  timestampNs: s.block.header.timestamp_nanosec,
});
test("actual earned upgrade receipts verify through the SDK without changing original captures", async () => {
  for (const s of [...f.steps, ...f.rejected]) {
    const completion = s.method === "complete_production";
    // Invalid raw argument/upgrade-ID calls deliberately cannot enter the typed SDK.
    let call;
    try {
      call = completion
        ? createLivingTownCompletionCall(s.args)
        : createLivingTownCall(s.method, s.args);
    } catch {
      assert.equal(s.succeeded, false);
      continue;
    }
    const proof = {
      transactionHash: s.transaction_hash,
      signerId: s.signer_id,
      deployment: identity.deployment,
      call,
      referenceBlockHeight: s.reference_block_height,
    };
    const status = await (
      completion ? verifyLivingTownCompletionReceipt : verifyLivingTownReceipt
    )(s.receipt, proof, async () => block(s));
    assert.equal(status.kind, s.succeeded ? "succeeded" : "failed");
    (completion ? livingTownIndexedCompletion : livingTownIndexedReceipt)(
      proof,
      { status, response: s.receipt },
    );
  }
  assert.equal(f.upgrade_before.data.gold.available, "184");
  assert.equal(f.upgrade_after.data.gold.available, "34");
  assert.equal(f.baseline.town.data.totals.upgrade_burns, "150");
  assert.equal(f.running.data.items.length, 2);
  livingTownFoundation(upgrade.foundation.data);
  assert.equal(livingTownUpgrade(f.eligible.data).eligible, true);
  for (const name of ["web", "reader", "assistant"])
    assert.equal(
      JSON.parse(
        readFileSync(`config/living-town-${name}.example.json`, "utf8"),
      ).identity.codeHash,
      identity.codeHash,
    );
});
test("upgrade call and effect bind owner, shop, exact price, capacity and revision", async () => {
  for (const extra of [
    { gold_cost: "1" },
    { recipient: "attacker.testnet" },
    { upgrade_id: "third_slot" },
    { shop_id: "0" },
    { expected_shop_revision: "01" },
  ])
    assert.throws(() =>
      createLivingTownCall("purchase_upgrade", { ...upgrade.args, ...extra }),
    );
  for (const change of [
    (o) => {
      o.gold_burned = "1";
    },
    (o) => {
      o.shop.production_slots = "1";
    },
    (o) => {
      o.shop.revision = "1";
    },
    (o) => {
      o.ledger.actor.account_id = "other.testnet";
    },
  ]) {
    const result = structuredClone(upgrade.effect);
    change(result.data.outcome);
    await assert.rejects(
      verifyLivingTownEffect(
        result,
        identity.deployment,
        upgrade.signer_id,
        createLivingTownCall("purchase_upgrade", upgrade.args),
      ),
    );
  }
});
const bundled = await build({
  stdin: {
    contents:
      "export {LivingTownTransactions} from './apps/web/src/app/living-town-transactions.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const { LivingTownTransactions } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
function wallet() {
  const values = new Map();
  let sends = 0,
    eligible = true;
  const shop = {
    ...structuredClone(upgrade.effect.data.outcome.shop),
    production_slots: "1",
    revision: upgrade.args.expected_shop_revision,
  };
  const reader = {
    block: {
      ...block(upgrade),
      timestampNs: String(
        BigInt(upgrade.args.command.valid_until_ns) - 100000000000n,
      ),
    },
    async getCommand() {
      return {
        data: {
          kind: "not_applied",
          next_sequence: upgrade.args.command.sequence,
        },
      };
    },
    async getTown() {
      return { data: { paused: false } };
    },
    async getShop() {
      return { data: shop };
    },
    async getUpgrade() {
      return { data: { ...f.eligible.data, eligible } };
    },
  };
  const client = {
    identity,
    finalized: async () => reader,
    receipt: async (p) => ({
      kind: "unknown",
      transactionHash: p.transactionHash,
    }),
  };
  const make = () =>
    new LivingTownTransactions(
      client,
      {
        getItem: (k) => values.get(k) ?? null,
        setItem: (k, v) => values.set(k, v),
      },
      async () => {
        sends++;
        return { transaction: { hash: upgrade.transaction_hash } };
      },
      async (_name, work) => work(),
      () => "11111111-1111-4111-8111-111111111111",
    );
  return {
    make,
    shop,
    get sends() {
      return sends;
    },
    set eligible(v) {
      eligible = v;
    },
  };
}
test("upgrade uses one owner wallet attempt and unknown reload never resends", async () => {
  const f = wallet(),
    j = f.make();
  const attempt = await j.prepare(
    upgrade.signer_id,
    "purchase_upgrade",
    upgrade.args,
  );
  await j.submit(attempt.id);
  assert.equal(f.sends, 1);
  const restored = f.make();
  await restored.restore();
  await assert.rejects(restored.submit(attempt.id));
  await restored.refresh();
  assert.equal(f.sends, 1);
  assert.equal((await restored.read()).phase, "unknown");
});
for (const changed of ["eligibility", "owner", "revision"])
  test(`upgrade wallet handoff rejects changed ${changed}`, async () => {
    const f = wallet(),
      j = f.make();
    const a = await j.prepare(
      upgrade.signer_id,
      "purchase_upgrade",
      upgrade.args,
    );
    if (changed === "eligibility") f.eligible = false;
    if (changed === "owner")
      f.shop.owner = { kind: "player", account_id: "other.testnet" };
    if (changed === "revision") f.shop.revision = "999";
    await assert.rejects(j.submit(a.id));
    assert.equal(f.sends, 0);
    assert.equal((await j.read()).phase, "prepared");
  });
