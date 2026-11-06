import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LivingTownProjectionStore } from "../../apps/worker/dist/private/living-town/store.js";
import {
  decodeCostUnits,
  costTotal,
} from "../../apps/worker/dist/private/living-town/cost-lots.js";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
} from "../../packages/chain/dist/index.js";

const p = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-races-sandbox.json", "utf8"),
);
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
const calls = [...p.setup, ...p.stages.flatMap((s) => s.calls)];
const indexed = await Promise.all(
  calls.map(async (s) => {
    const completion = s.method === "complete_production";
    const proof = {
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
      return block(s.block);
    });
    assert.equal(status.kind, s.succeeded ? "succeeded" : "failed");
    return (
      completion ? livingTownIndexedCompletion : livingTownIndexedReceipt
    )(proof, { status, response: s.receipt });
  }),
);
const n = (v) => BigInt(v);
function conserved(s) {
  const t = s.town.data,
    totals = t.totals,
    ledgers = [...t.npc_ledgers, ...s.shops.map((r) => r.ledger.data)];
  assert.equal(
    ledgers.reduce((sum, l) => sum + n(l.gold.held), n(t.customer_pool.gold)),
    n(totals.initial_gold) +
      n(totals.player_grants) +
      n(totals.customer_topups) -
      n(totals.upgrade_burns) -
      n(totals.treasury_burns),
  );
  for (const item of Object.keys(totals.seed_items)) {
    const held = ledgers.reduce(
      (sum, l) => sum + n(l.inventory.held[item]),
      0n,
    );
    assert.equal(
      held +
        n(totals.recipe_inputs_consumed[item]) +
        n(totals.customer_consumed[item]),
      n(totals.seed_items[item]) +
        n(totals.supplied_items[item]) +
        n(totals.completed_outputs[item]),
      item,
    );
    for (const ledger of ledgers) {
      const inv = ledger.inventory;
      assert.equal(
        n(inv.held[item]),
        n(inv.available[item]) +
          n(inv.listing_reserved[item]) +
          n(inv.trade_reserved[item]),
      );
      assert(
        n(inv.held[item]) +
          n(inv.production_output_reserved[item]) +
          n(inv.trade_inbound_reserved[item]) <=
          1000n,
      );
    }
  }
}

test("actual competing WASM receipts have one economic winner per last-unit or revision race", () => {
  assert.equal(
    new Set(calls.map((r) => r.transaction_hash)).size,
    calls.length,
  );
  for (const name of [
    "last_raw_unit",
    "craft_versus_reserve",
    "sale_versus_cancel",
    "sale_versus_reprice",
  ]) {
    const stage = p.stages.find((s) => s.name === name);
    assert.equal(stage.calls.filter((r) => r.succeeded).length, 1, name);
    const loser = stage.calls.find((r) => !r.succeeded);
    assert.match(loser.error, /LT:E_STALE_LISTING|LT:E_COMMAND_CONFLICT/);
    for (const row of stage.calls) {
      const record = indexed[calls.indexOf(row)];
      assert.equal(record.event !== null, row.succeeded);
    }
  }
  const raw = p.stages.find((s) => s.name === "last_raw_unit");
  assert.equal(
    n(raw.after.town.data.next_trade_id) -
      n(raw.before.town.data.next_trade_id),
    1n,
  );
  assert.equal(
    n(raw.after.town.data.npc_ledgers[0].gold.held) -
      n(raw.before.town.data.npc_ledgers[0].gold.held),
    4n,
  );
});

test("all actual race checkpoints reconcile gold, six-item sources/sinks and reservation headroom", () => {
  for (const stage of p.stages) {
    conserved(stage.before);
    conserved(stage.after);
  }
  conserved(p.after);
  for (const name of ["sale_versus_cancel", "sale_versus_reprice"]) {
    const stage = p.stages.find((s) => s.name === name),
      sale = stage.calls.find(
        (r) => r.succeeded && r.method === "settle_customer_purchase",
      ),
      before = stage.before,
      after = stage.after;
    const count = sale ? 1n : 0n,
      price = sale ? n(sale.effect.data.outcome.trade.total_price) : 0n;
    assert.equal(
      n(after.town.data.totals.customer_consumed.health_potion) -
        n(before.town.data.totals.customer_consumed.health_potion),
      count,
    );
    assert.equal(
      n(before.town.data.customer_pool.gold) -
        n(after.town.data.customer_pool.gold),
      price,
    );
    assert.equal(
      n(after.shops[0].ledger.data.gold.held) -
        n(before.shops[0].ledger.data.gold.held),
      price,
    );
    assert.equal(
      n(before.shops[0].ledger.data.inventory.held.health_potion) -
        n(after.shops[0].ledger.data.inventory.held.health_potion),
      count,
    );
  }
});

test("duplicate funding and retained/pruned sale retries cannot create another payment or source allocation", () => {
  const funding = p.stages.find((s) => s.name === "duplicate_funding"),
    replay = p.stages.find((s) => s.name === "retained_sale_replay");
  assert(funding.calls.every((r) => r.succeeded));
  assert.equal(funding.calls.filter((r) => !r.effect.data.replayed).length, 1);
  const issued = n(funding.calls[0].effect.data.outcome.issued_gold),
    old = n(funding.before.town.data.customer_pool.gold);
  assert.equal(issued, 200n - old < 100n ? 200n - old : 100n);
  assert.equal(
    n(funding.after.town.data.totals.customer_topups) -
      n(funding.before.town.data.totals.customer_topups),
    issued,
  );
  assert.equal(n(funding.after.town.data.customer_pool.gold) - old, issued);
  assert.equal(replay.calls[0].effect.data.replayed, true);
  assert.deepEqual(
    replay.before.shops.map((r) => r.ledger.data),
    replay.after.shops.map((r) => r.ledger.data),
  );
  assert.deepEqual(
    replay.before.town.data.totals,
    replay.after.town.data.totals,
  );
  assert.equal(p.pruned_command.data.kind, "pruned");
  for (const r of indexed)
    if (r.status.kind === "failed" || r.status.result.data.replayed)
      assert.equal(r.event, null);
});

test("actual race receipts preserve FIFO cost conservation through failures, acknowledgements and restart", (t) => {
  const first = p.setup[0],
    f = first.foundation,
    identity = {
      deployment: f.deployment,
      codeHash: first.account.code_hash,
      ownerId: f.data.owner_account_id,
      operatorId: f.data.operator_account_id,
      controllers: f.data.merchant_controllers,
    };
  const dir = mkdtempSync(join(tmpdir(), "bazaar-race-cost-"));
  const store = new LivingTownProjectionStore(dir, identity, true);
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "bazaar-race-cost-")));
    rmSync(dir, { recursive: true, force: true });
  });
  const snapshot = p.after;
  // Controlled page aggregation of immutable captured NPC job facts under the
  // actual final checkpoint, not additional RPC capture or invented production.
  const npcJobs = calls
    .filter(
      (r) =>
        r.succeeded &&
        r.method === "start_production" &&
        r.effect.data.outcome.job.owner.kind === "merchant",
    )
    .map((r) => r.effect.data.outcome.job);
  store.baseline({
    block: block(snapshot.block),
    town: snapshot.town,
    shops: snapshot.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    production: [
      ...["1", "2", "3"].map((shopId) => ({
        shopId,
        pages: [
          {
            ...snapshot.town,
            data: {
              items: npcJobs.filter((j) => j.shop_id === shopId),
              next_after_id:
                npcJobs.filter((j) => j.shop_id === shopId).at(-1)?.job_id ??
                null,
              has_more: false,
              history_gap: false,
              pruned_through: "0",
            },
          },
        ],
      })),
      ...snapshot.shops.map((r) => ({
        shopId: r.shop.data.shop_id,
        pages: [r.jobs],
      })),
    ],
  });
  // Deliberately ingest non-chronologically. Only contiguous verified events may price lots.
  for (const receipt of [...indexed].reverse()) store.commit(receipt);
  const summaries = snapshot.shops.map(
    (r) => store.history(r.shop.data.shop_id).snapshot.data.costs,
  );
  assert(
    summaries.every((s) => s.cost_history_complete && s.recorded_cogs !== null),
  );
  const spending = summaries.reduce(
    (v, s) => v + n(s.recorded_material_spending),
    0n,
  );
  const cogs = summaries.reduce((v, s) => v + n(s.recorded_cogs), 0n);
  const before = store.counts();
  for (const receipt of indexed) store.commit(receipt);
  assert.deepEqual(store.counts(), before);
  store.close();
  const db = new DatabaseSync(join(dir, "living-town.sqlite"));
  try {
    let heldCost = 0n;
    for (const row of snapshot.shops)
      for (const item of Object.keys(snapshot.town.data.totals.seed_items)) {
        const actor = `account:${row.shop.data.owner.account_id}`;
        const saved = db
          .prepare("SELECT units FROM cost_inventory WHERE actor=? AND item=?")
          .get(actor, item);
        const units = saved ? decodeCostUnits(saved.units) : [];
        assert.equal(
          BigInt(units.length),
          n(row.ledger.data.inventory.held[item]),
        );
        assert.notEqual(costTotal(units), null);
        heldCost += n(costTotal(units));
      }
    assert.equal(spending, cogs + heldCost);
  } finally {
    db.close();
  }
  const restored = new LivingTownProjectionStore(dir, identity);
  try {
    assert.deepEqual(
      snapshot.shops.map(
        (r) => restored.history(r.shop.data.shop_id).snapshot.data.costs,
      ),
      summaries,
    );
  } finally {
    restored.close();
  }
});
