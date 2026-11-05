import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createLivingTownCall,
  livingTownCommandDigest,
  verifyLivingTownReceipt,
  verifyLivingTownEffect,
  livingTownProductionJob,
  livingTownIndexedReceipt,
  FinalizedLivingTownReader,
} from "../../packages/chain/dist/index.js";
const f = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-production-sandbox.json",
    "utf8",
  ),
);
const foundation = f.steps[0].foundation;
const block = (s) => ({
  hash: s.block.header.hash,
  height: String(s.block.header.height),
  timestampNs: s.block.header.timestamp_nanosec,
});
const proof = (s) => ({
  transactionHash: s.transaction_hash,
  signerId: s.signer_id,
  deployment: s.foundation.deployment,
  call: createLivingTownCall(s.method, s.args),
  referenceBlockHeight: s.reference_block_height,
});
const statuses = await Promise.all(
  f.steps.map((s) =>
    verifyLivingTownReceipt(s.receipt, proof(s), async () => block(s)),
  ),
);
const clone = (v) => structuredClone(v);

test("production call codec binds reviewed recipe/shop/revision/batch and rejects invalid requests", async () => {
  const s = f.steps[0],
    call = createLivingTownCall("start_production", s.args);
  assert(Object.isFrozen(call.args));
  assert.equal(call.deposit, "0");
  assert.equal(
    await livingTownCommandDigest(s.foundation.deployment, s.signer_id, call),
    statuses[0].result.data.payload_sha256,
  );
  for (const [field, value] of [
    ["quantity", "0"],
    ["quantity", "11"],
    ["quantity", 1.5],
    ["recipe_id", "unknown"],
    ["recipe_version", "2"],
    ["shop_id", "0"],
    ["expected_shop_revision", "01"],
    ["owner_account_id", "other.testnet"],
  ]) {
    const bad = clone(s.args);
    bad[field] = value;
    assert.throws(() => createLivingTownCall("start_production", bad));
  }
});

test("actual WASM starts verify original jobs/input consumption/output promises and replay once", () => {
  assert(statuses.every((s) => s.kind === "succeeded"));
  assert.deepEqual(
    statuses[0].result.data.outcome,
    statuses[1].result.data.outcome,
  );
  assert.equal(statuses[1].result.data.replayed, true);
  for (const [i, item, q, gold] of [
    [0, "health_potion", "3", "70"],
    [2, "iron_tool", "2", "76"],
  ]) {
    const o = statuses[i].result.data.outcome;
    assert.equal(o.job.recipe_id, item);
    assert.equal(o.job.quantity, q);
    assert.equal(o.ledger.gold.held, gold);
    assert.equal(o.ledger.inventory.held[item], "0");
    assert.equal(o.ledger.inventory.production_output_reserved[item], q);
    assert.equal(
      BigInt(o.job.ready_at_ns) - BigInt(o.job.start_at_ns),
      360_000_000_000n,
    );
    assert.equal(o.job.status, "running");
    assert.equal(o.job.recipe_version, "1");
    assert.equal(o.job.config_version, "1");
  }
  assert.equal(
    livingTownIndexedReceipt(proof(f.steps[0]), {
      status: statuses[0],
      response: f.steps[0].receipt,
    }).event.event,
    "start_production",
  );
  assert.equal(
    livingTownIndexedReceipt(proof(f.steps[1]), {
      status: statuses[1],
      response: f.steps[1].receipt,
    }).event,
    null,
  );
});

test("forged production owners, amounts, timing, reviewed args or command correlation reject", async () => {
  const s = f.steps[0];
  for (const mutate of [
    (v) => (v.data.outcome.job.owner.account_id = "other.testnet"),
    (v) => (v.data.outcome.job.quantity = "2"),
    (v) => (v.data.outcome.job.ready_at_ns = "1"),
    (v) =>
      (v.data.outcome.ledger.inventory.production_output_reserved.health_potion =
        "0"),
    (v) => (v.data.principal = "merchant:rex"),
    (v) => (v.data.command_sequence = "1"),
  ]) {
    const bad = clone(statuses[0].result);
    mutate(bad);
    await assert.rejects(
      verifyLivingTownEffect(
        bad,
        s.foundation.deployment,
        s.signer_id,
        proof(s).call,
      ),
    );
  }
  const args = clone(s.args);
  args.quantity = "2";
  await assert.rejects(
    verifyLivingTownEffect(
      statuses[0].result,
      s.foundation.deployment,
      s.signer_id,
      createLivingTownCall("start_production", args),
    ),
  );
  const bad = clone(statuses[0].result.data.outcome.job);
  bad.completed_at_ns = bad.ready_at_ns;
  assert.throws(() => livingTownProductionJob(bad));
});

test("typed job paging reads only the selected shop at its pinned finalized snapshot", async () => {
  const baseline = f.after,
    b = block(baseline),
    calls = [];
  const identity = {
    deployment: foundation.deployment,
    codeHash: f.steps[0].account.code_hash,
    ownerId: foundation.data.owner_account_id,
    operatorId: foundation.data.operator_account_id,
    controllers: foundation.data.merchant_controllers,
  };
  const rpc = async (m, p) => {
    calls.push({ m, p });
    const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
    const row = baseline.shops.find(
      (r) => r.shop.data.shop_id === args.shop_id,
    );
    const body = clone(row.jobs);
    if (args.status === "completed" || args.after_id !== null) {
      body.data.items = [];
      body.data.next_after_id = args.after_id;
    }
    return {
      block_hash: b.hash,
      block_height: b.height,
      result: [...Buffer.from(JSON.stringify(body))],
    };
  };
  const reader = new FinalizedLivingTownReader(rpc, identity, b),
    args = {
      shop_id: "4",
      status: "all",
      after_id: null,
      limit: "1",
      expected_market_revision: baseline.town.market_revision,
    };
  assert.equal(
    (await reader.getProductionJobs(args)).data.items[0].owner.account_id,
    f.steps[0].signer_id,
  );
  assert.equal(
    (await reader.getProductionJobs({ ...args, shop_id: "5" })).data.items[0]
      .recipe_id,
    "iron_tool",
  );
  assert.equal(
    (await reader.getProductionJobs({ ...args, status: "completed" })).data
      .items.length,
    0,
  );
  assert(calls.every((c) => c.p.block_id === b.hash));
  await assert.rejects(
    reader.getProductionJobs({ ...args, expected_market_revision: "1" }),
  );
});

test("NPC production digests use a merchant lane independent of controller account lanes", async () => {
  const args = { ...f.steps[2].args, shop_id: "3" },
    call = createLivingTownCall("start_production", args);
  const digest = await livingTownCommandDigest(
    foundation.deployment,
    "bolt.testnet",
    call,
  );
  const accountCall = createLivingTownCall("start_production", {
    ...args,
    shop_id: "5",
  });
  assert.notEqual(
    digest,
    await livingTownCommandDigest(
      foundation.deployment,
      "bolt.testnet",
      accountCall,
    ),
  );
  assert.notEqual(
    digest,
    await livingTownCommandDigest(foundation.deployment, "other.testnet", call),
  );
});
