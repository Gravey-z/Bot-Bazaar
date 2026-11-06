import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  executionFixture,
  closeFixturesAt,
  identity,
} from "./fixtures/living-town-execution.mjs";
import { LivingTownExecutionStore } from "../dist/private/living-town/execution-store.js";
import { readCustomerPrepared } from "../dist/private/living-town/customer-chain.js";
import {
  assertRuntimePermission,
  runtimeMethods,
} from "../dist/private/near-signer.js";

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-customer-execution-"));
  t.after(() => {
    assert(dir.startsWith(join(tmpdir(), "bazaar-customer-execution-")));
    closeFixturesAt(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
async function fixture(t, options) {
  const dir = directory(t),
    f = await executionFixture(dir, options);
  t.after(() => {
    try {
      f.close();
    } catch {
      /* reopened/closed tests */
    }
  });
  return { ...f, dir };
}

test("customer decision and signed bytes persist before send; final receipt unlocks exactly one action", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /recovery|continuity/,
  );
  assert.equal((await f.processor.recover()).kind, "ready");
  const input = f.input(),
    proposal = f.demand.select(input);
  const submitted = await f.processor.executeCustomer(input);
  assert.equal(submitted.kind, "submitted");
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
  const saved = f.store.get(proposal.customerId);
  assert.equal(saved.status, "submitted");
  assert(saved.signed_json);
  assert.deepEqual(JSON.parse(saved.decision_json), proposal);
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /continuity|recovery/,
  );
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.get(proposal.customerId).status, "confirmed");
  assert.equal(f.store.checkpoint("operator").last_action_id, "1");
  assert.equal(
    (await f.processor.executeCustomer(f.input())).kind,
    "duplicate",
  );
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});

test("unknown receipts retain shared locks through restart and epoch expiry; no replacement signature", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  f.mode("timeout_before_execution");
  const pending = await f.processor.executeCustomer(f.input());
  assert.equal(pending.kind, "unknown");
  f.close();
  const reopened = await executionFixture(f.dir);
  t.after(() => reopened.close());
  let result = await reopened.processor.recover();
  assert.equal(result.kind, "blocked");
  assert(result.reasons.includes("unknown_customer_receipt"));
  reopened.state.town.block_timestamp_ns = (
    BigInt(reopened.state.town.block_timestamp_ns) + 120_000_000_000n
  ).toString();
  reopened.state.town.data.epoch =
    reopened.state.town.data.customer_pool.epoch = (
      BigInt(reopened.state.town.data.epoch) + 2n
    ).toString();
  result = await reopened.processor.recover();
  assert.equal(result.kind, "blocked");
  await assert.rejects(
    reopened.processor.executeCustomer(reopened.input()),
    /recovery|continuity/,
  );
  assert.throws(() => reopened.store.abandon(pending.actionId), /broadcast/);
  await assert.rejects(
    reopened.processor.resumeSigned(pending.actionId),
    /unsubmitted|recovery/,
  );
  assert.equal(reopened.counts.sign, 0);
  assert.equal(reopened.counts.send, 0);
});

test("a pruned command cannot turn an unknown broadcast into permission to sign or fund again", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  f.mode("timeout_before_execution");
  const pending = await f.processor.executeCustomer(f.input());
  assert.equal(pending.kind, "unknown");
  const original = f.store.get(pending.actionId).signed_json;
  // Controlled missing-history/high-water input, not an additional chain execution.
  f.state.sequence = "9";
  f.state.effect = null;
  const report = await f.processor.recover();
  assert.equal(report.kind, "blocked");
  assert(report.reasons.includes("unknown_customer_receipt"));
  assert.equal(f.store.get(pending.actionId).signed_json, original);
  assert.throws(() => f.store.abandon(pending.actionId), /broadcast/);
  await assert.rejects(f.processor.fundCurrentEpoch(), /recovery/);
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /recovery|continuity/,
  );
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
  assert.equal(f.state.town.data.customer_pool.gold, "100");
});

test("matching command checkpoint recovers a timed-out executed purchase without fabricating its receipt", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  f.mode("timeout_after_execution");
  const result = await f.processor.executeCustomer(f.input());
  assert.equal(result.kind, "unknown");
  f.state.receipts = false;
  f.save();
  f.close();
  const reopened = await executionFixture(f.dir);
  t.after(() => reopened.close());
  assert.equal((await reopened.processor.recover()).kind, "ready");
  assert.equal(reopened.store.get(result.actionId).status, "confirmed");
  assert.equal(reopened.counts.sign, 0);
  assert.equal(reopened.counts.send, 0);
  assert.equal(
    (await reopened.processor.executeCustomer(reopened.input())).kind,
    "duplicate",
  );
});

test("durable funding uses the same operator lane and cannot repeat the epoch", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  const result = await f.processor.fundCurrentEpoch();
  assert.equal(result.kind, "submitted");
  assert.equal(f.state.town.data.customer_pool.gold, "200");
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal((await f.processor.fundCurrentEpoch()).kind, "duplicate");
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});

test("no-purchase decisions are durable, sequential and never load credentials", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  const skipped = f.input();
  skipped.candidates = [];
  const result = await f.processor.executeCustomer(skipped);
  assert.equal(result.kind, "no_purchase");
  assert.equal((await f.processor.executeCustomer(skipped)).kind, "duplicate");
  const next = f.input();
  next.arrivalIndex = "2";
  await assert.rejects(f.processor.executeCustomer(next), /in order/);
  await f.processor.recover();
  next.arrivalIndex = "1";
  next.candidates = [];
  assert.equal((await f.processor.executeCustomer(next)).kind, "no_purchase");
  assert.equal(f.counts.sign, 0);
  assert.equal(f.counts.send, 0);
});

test("merchant work shares admission and all four controller lanes are recovered", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  for (const lane of ["rex", "luna", "bolt", "operator"])
    assert.equal(f.store.checkpoint(lane).last_action_id, "0");
  f.store.claimRuntimeJob(
    "merchant-turn",
    ["rex", "luna", "bolt"],
    Date.now() + 60000,
  );
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /shared admission/,
  );
  await f.processor.recover();
  f.store.completeRuntimeJob("merchant-turn");
  assert.equal(
    (await f.processor.executeCustomer(f.input())).kind,
    "submitted",
  );
  assert.throws(
    () =>
      f.store.claimRuntimeJob(
        "competing-merchant",
        ["bolt"],
        Date.now() + 60000,
      ),
    /recovery|shared/,
  );
});

test("exclusive ownership, identity/code/seed binding and continuity fail closed", async (t) => {
  const f = await fixture(t, { continuityVerifier: async () => undefined });
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.throws(
    () => new LivingTownExecutionStore(f.dir, identity, "42"),
    /locked|busy/,
  );
  f.close();
  assert.throws(
    () => new LivingTownExecutionStore(f.dir, identity, "43"),
    /mismatch/,
  );
  assert.throws(
    () =>
      new LivingTownExecutionStore(
        f.dir,
        { ...identity, codeHash: "11111111111111111111111111111111" },
        "42",
      ),
    /mismatch/,
  );
  assert.equal(f.counts.sign, 0);
});

test("operator key scope is exact and preserves the V1 merchant allowlist", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  assert.throws(
    () =>
      assertRuntimePermission(f.permission, identity.deployment.contract_id),
    /five merchant/,
  );
  for (const permission of [
    "FullAccess",
    { FunctionCall: { ...f.permission.FunctionCall, method_names: [] } },
    {
      FunctionCall: {
        ...f.permission.FunctionCall,
        method_names: [...runtimeMethods, "settle_customer_purchase"],
      },
    },
    {
      FunctionCall: {
        ...f.permission.FunctionCall,
        receiver_id: "wrong.testnet",
      },
    },
    { FunctionCall: { ...f.permission.FunctionCall, allowance: null } },
  ])
    assert.throws(() =>
      assertRuntimePermission(
        permission,
        identity.deployment.contract_id,
        "customer",
      ),
    );
  f.permission.FunctionCall.method_names.push("set_listing");
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /exactly|methods/,
  );
  assert.equal(f.counts.sign, 0);
  assert.equal(f.counts.send, 0);
});

test("restored bytes reject forged digest, receiver, nonce, method and args before submission", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  const result = await f.processor.executeCustomer(f.input()),
    text = f.store.get(result.actionId).signed_json;
  for (const mutate of [
    (p) => (p.transactionHash = "11111111111111111111111111111111"),
    (p) => (p.signerId = "wrong.testnet"),
    (p) => (p.nonce = "999"),
    (p) => (p.call.method = "register_player"),
    (p) => (p.call.args.max_total_price = "1"),
    (p) => (p.deployment.contract_id = "wrong.testnet"),
  ]) {
    const p = JSON.parse(text);
    mutate(p);
    assert.throws(() => readCustomerPrepared(JSON.stringify(p), identity));
  }
});

test("older cached command effects recover at a later checkpoint without inventing a transaction receipt", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  f.mode("timeout_after_execution");
  const result = await f.processor.executeCustomer(f.input());
  f.state.receipts = false;
  f.state.town.market_revision = f.state.town.event_sequence = "99";
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.get(result.actionId).status, "confirmed");
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});

test("conflicting command digests block recovery without a replacement signature", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  f.mode("timeout_after_execution");
  await f.processor.executeCustomer(f.input());
  f.state.receipts = false;
  f.state.effect.data.payload_sha256 = "0".repeat(64);
  await assert.rejects(f.processor.recover(), /checkpoint conflict/);
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /continuity|recovery/,
  );
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});

test("persistence faults before signed bytes, before send and after send never authorize a second signature", async (t) => {
  for (const point of ["saveSigned", "unknown", "submitted"]) {
    const f = await fixture(t);
    await f.processor.recover();
    const saveSigned = f.store.saveSigned.bind(f.store),
      broadcast = f.store.markBroadcast.bind(f.store);
    if (point === "saveSigned")
      f.store.saveSigned = () => {
        throw Error("injected signed persistence failure");
      };
    else
      f.store.markBroadcast = (id, state) => {
        if (state === point) throw Error("injected marker persistence failure");
        broadcast(id, state);
      };
    const actionId = f.demand.select(f.input()).customerId;
    await assert.rejects(f.processor.executeCustomer(f.input()), /injected/);
    assert.equal(f.counts.send, point === "submitted" ? 1 : 0);
    f.store.saveSigned = saveSigned;
    f.store.markBroadcast = broadcast;
    const report = await f.processor.recover();
    if (point === "unknown") {
      assert.equal(report.kind, "blocked");
      assert.equal(
        (await f.processor.resumeSigned(actionId)).kind,
        "submitted",
      );
      assert.equal((await f.processor.recover()).kind, "ready");
    } else assert.equal(report.kind, "ready");
    assert.equal(f.counts.sign, 1);
  }
});

test("repricing after signing prevents broadcast; only proven unsent expired work may be abandoned", async (t) => {
  const f = await fixture(t);
  await f.processor.recover();
  const save = f.store.saveSigned.bind(f.store);
  f.store.saveSigned = (id, p) => {
    save(id, p);
    f.state.listings.find(
      (l) => l.listing_id === p.call.args.listing_id,
    ).revision = "99";
  };
  const actionId = f.demand.select(f.input()).customerId;
  await assert.rejects(f.processor.executeCustomer(f.input()), /quote changed/);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 0);
  assert.equal((await f.processor.recover()).kind, "blocked");
  f.state.town.block_timestamp_ns = (
    BigInt(f.state.town.block_timestamp_ns) + 120_000_000_000n
  ).toString();
  f.state.town.data.epoch = f.state.town.data.customer_pool.epoch = (
    BigInt(f.state.town.data.epoch) + 2n
  ).toString();
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.get(actionId).status, "abandoned");
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 0);
});

for (const point of [
  "before_sign",
  "after_signed",
  "after_unknown",
  "after_network",
]) {
  test(`process death at ${point} keeps durable intent/bytes and requires correct recovery`, async (t) => {
    const dir = directory(t);
    const script = `import {executionFixture} from './apps/worker/test/fixtures/living-town-execution.mjs'; const f=await executionFixture(${JSON.stringify(dir)},{crashAt:${JSON.stringify(point)}}); await f.processor.recover(); await f.processor.executeCustomer(f.input()); process.exit(99);`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 30000 },
    );
    assert.notEqual(child.status, 99, child.stderr);
    assert.notEqual(child.status, 0, child.stderr);
    const f = await executionFixture(dir);
    t.after(() => f.close());
    const rows = f.store.unresolved();
    assert.equal(rows.length, 1, child.stderr);
    const row = rows[0],
      actionId = row.id;
    const recovered = await f.processor.recover();
    if (point === "before_sign") {
      assert.equal(recovered.kind, "ready");
      assert.equal(f.store.get(actionId).status, "abandoned");
      assert.equal(
        (await f.processor.executeCustomer(f.input())).kind,
        "duplicate",
      );
    } else if (point === "after_signed") {
      assert.equal(recovered.kind, "blocked");
      assert(row.signed_json);
      const result = await f.processor.resumeSigned(actionId);
      assert.equal(result.kind, "submitted");
      assert.equal((await f.processor.recover()).kind, "ready");
      assert.equal(f.counts.sign, 0);
      assert.equal(f.counts.send, 1);
    } else if (point === "after_unknown") {
      assert.equal(recovered.kind, "blocked");
      assert.equal(f.counts.send, 0);
      await assert.rejects(
        f.processor.executeCustomer(f.input()),
        /recovery|continuity/,
      );
    } else {
      assert.equal(recovered.kind, "ready");
      assert.equal(f.store.get(actionId).status, "confirmed");
      assert.equal(f.counts.send, 0);
    }
    assert.equal(f.counts.sign, 0);
  });
}
