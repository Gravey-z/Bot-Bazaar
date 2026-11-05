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
  canonicalLivingTownJson,
} from "../../packages/chain/dist/index.js";
const starts = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-production-sandbox.json",
    "utf8",
  ),
);
const completions = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-completion-sandbox.json",
    "utf8",
  ),
);
const block = (s) => ({
  hash: s.block.header.hash,
  height: String(s.block.header.height),
  timestampNs: s.block.header.timestamp_nanosec,
});
const proof = (s, completion) => ({
  transactionHash: s.transaction_hash,
  signerId: s.signer_id,
  deployment: s.foundation.deployment,
  call: completion
    ? createLivingTownCompletionCall(s.args)
    : createLivingTownCall(s.method, s.args),
  referenceBlockHeight: s.reference_block_height,
});
const startEvidence = await Promise.all(
  starts.steps.map(async (s) => ({
    status: await verifyLivingTownReceipt(
      s.receipt,
      proof(s, false),
      async () => block(s),
    ),
    response: s.receipt,
  })),
);
const completionEvidence = await Promise.all(
  completions.steps.map(async (s) => ({
    status: await verifyLivingTownCompletionReceipt(
      s.receipt,
      proof(s, true),
      async () => block(s),
    ),
    response: s.receipt,
  })),
);
const firstIndex = completionEvidence.findIndex(
  (e) => e.status.kind === "succeeded" && !e.status.result.data.replayed,
);
const clone = (v) => structuredClone(v);
function changeLog(e, change) {
  const row = e.response.receipts_outcome.find(
    (r) => r.id === e.status.executionReceiptId,
  );
  const i = row.outcome.logs.findIndex((l) => l.startsWith("EVENT_JSON:"));
  const event = JSON.parse(row.outcome.logs[i].slice(11));
  change(event.data[0], event);
  row.outcome.logs[i] = "EVENT_JSON:" + JSON.stringify(event);
}

test("actual lifecycle logs bind recipe/version, quantities, timing and command correlation", () => {
  let startEvents = 0,
    completionEvents = 0;
  starts.steps.forEach((s, i) => {
    const record = livingTownIndexedReceipt(proof(s, false), startEvidence[i]);
    if (!record.event) return;
    startEvents++;
    const d = record.event.data[0],
      j = d.outcome.job;
    assert.equal(record.event.event, "start_production");
    assert.equal(d.command_sequence, s.args.command.sequence);
    assert.equal(d.principal, `account:${s.signer_id}`);
    assert.equal(j.recipe_version, s.args.recipe_version);
    assert.equal(j.quantity, s.args.quantity);
    assert.equal(j.start_at_ns, d.block_timestamp_ns);
    assert.equal(
      BigInt(j.ready_at_ns) - BigInt(j.start_at_ns),
      BigInt(j.quantity) *
        (j.recipe_id === "health_potion" ? 120n : 180n) *
        1_000_000_000n,
    );
  });
  completions.steps.forEach((s, i) => {
    const record = livingTownIndexedCompletion(
      proof(s, true),
      completionEvidence[i],
    );
    if (!record.event) return;
    completionEvents++;
    const d = record.event.data[0],
      j = d.outcome.job;
    assert.equal(record.event.event, "complete_production");
    assert.equal(d.command_sequence, null);
    assert.equal(d.payload_sha256, null);
    assert.equal(d.principal, null);
    assert.equal(j.completed_at_ns, d.block_timestamp_ns);
    const original = completions.before.shops
      .flatMap((r) => r.jobs.data.items)
      .find((old) => old.job_id === j.job_id);
    for (const key of [
      "owner",
      "recipe_id",
      "recipe_version",
      "config_version",
      "quantity",
      "inputs_consumed",
      "output_item",
      "output_quantity",
      "start_at_ns",
      "ready_at_ns",
      "start_command_sequence",
    ])
      assert.equal(
        canonicalLivingTownJson(j[key]),
        canonicalLivingTownJson(original[key]),
      );
  });
  assert.equal(startEvents, 2);
  assert.equal(completionEvents, 2);
});

test("completion event extraction rejects forged recipe/amount/time and correlation fields", () => {
  const p = proof(completions.steps[firstIndex], true);
  for (const mutate of [
    (d) => (d.outcome.job.recipe_version = "2"),
    (d) => (d.outcome.job.quantity = "10"),
    (d) => (d.outcome.job.completed_at_ns = "1"),
    (d) => (d.outcome.job.start_command_sequence = "999"),
    (d) => (d.command_sequence = "5"),
    (d) => (d.payload_sha256 = "a".repeat(64)),
    (d) => (d.principal = "account:fake.testnet"),
    (d) => (d.predecessor_account_id = "fake.testnet"),
    (d) => (d.event_sequence = "999"),
  ]) {
    const e = clone(completionEvidence[firstIndex]);
    changeLog(e, mutate);
    assert.throws(() => livingTownIndexedCompletion(p, e));
  }
});

test("duplicate/missing completion events reject while replay, failure and unresolved outcomes never invent events", () => {
  const p = proof(completions.steps[firstIndex], true);
  for (const duplicate of [true, false]) {
    const e = clone(completionEvidence[firstIndex]),
      row = e.response.receipts_outcome.find(
        (r) => r.id === e.status.executionReceiptId,
      );
    row.outcome.logs = duplicate
      ? [...row.outcome.logs, ...row.outcome.logs]
      : [];
    assert.throws(() => livingTownIndexedCompletion(p, e));
  }
  const replayIndex = completionEvidence.findIndex(
    (e) => e.status.kind === "succeeded" && e.status.result.data.replayed,
  );
  const replay = clone(completionEvidence[replayIndex]);
  const row = replay.response.receipts_outcome.find(
    (r) => r.id === replay.status.executionReceiptId,
  );
  row.outcome.logs = ["EVENT_JSON:{}"];
  assert.throws(() =>
    livingTownIndexedCompletion(
      proof(completions.steps[replayIndex], true),
      replay,
    ),
  );
  assert.equal(
    livingTownIndexedCompletion(
      proof(completions.steps[0], true),
      completionEvidence[0],
    ).event,
    null,
  );
  assert.equal(
    livingTownIndexedCompletion(p, {
      status: { kind: "unknown", transactionHash: p.transactionHash },
      response: null,
    }),
    null,
  );
});
