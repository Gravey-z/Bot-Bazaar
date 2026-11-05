import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createLivingTownCompletionCall,
  createLivingTownCall,
  verifyLivingTownCompletionReceipt,
  verifyLivingTownCompletionEffect,
  livingTownProductionJob,
  LivingTownClient,
  FinalizedLivingTownReader,
  livingTownIndexedCompletion,
} from "../../packages/chain/dist/index.js";
const f = JSON.parse(
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
const proof = (s) => ({
  transactionHash: s.transaction_hash,
  signerId: s.signer_id,
  deployment: s.foundation.deployment,
  call: createLivingTownCompletionCall(s.args),
  referenceBlockHeight: s.reference_block_height,
});
const statuses = await Promise.all(
  f.steps.map((s) =>
    verifyLivingTownCompletionReceipt(s.receipt, proof(s), async (hash) => {
      assert.equal(hash, s.block.header.hash);
      return block(s);
    }),
  ),
);
const first = statuses.find(
  (s) => s.kind === "succeeded" && !s.result.data.replayed,
);
const clone = (v) => structuredClone(v);

test("completion calls are rewardless, exact and independent of command sequences", () => {
  const call = createLivingTownCompletionCall({ job_id: "1" });
  assert.equal(call.method, "complete_production");
  assert.equal(call.deposit, "0");
  assert(Object.isFrozen(call.args));
  assert.throws(() =>
    createLivingTownCall("complete_production", { job_id: "1" }),
  );
  for (const args of [
    { job_id: "0" },
    { job_id: 1 },
    { job_id: "1.5" },
    { job_id: "01" },
    { job_id: "18446744073709551616" },
    { job_id: "1", command: { sequence: "1" } },
    { job_id: "1", owner_account_id: "other.testnet" },
  ])
    assert.throws(() => createLivingTownCompletionCall(args));
});

test("actual early failure, two original completions and two harmless replays verify", () => {
  assert.equal(statuses.filter((s) => s.kind === "failed").length, 1);
  const successes = statuses.filter((s) => s.kind === "succeeded");
  assert.equal(successes.length, 4);
  assert.equal(successes.filter((s) => !s.result.data.replayed).length, 2);
  assert.equal(successes.filter((s) => s.result.data.replayed).length, 2);
  for (const s of successes) {
    const e = s.result.data;
    assert.equal(e.principal, null);
    assert.equal(e.command_sequence, null);
    assert.equal(e.payload_sha256, null);
    assert.equal(e.outcome.job.status, "completed");
    assert.equal(e.outcome.job.revision, "2");
    assert(
      BigInt(e.outcome.job.completed_at_ns) >=
        BigInt(e.outcome.job.ready_at_ns),
    );
  }
  assert.deepEqual(
    successes.at(-1).result.data.outcome,
    first.result.data.outcome,
  );
  assert.equal(
    f.completed.shops[0].ledger.data.inventory.held.health_potion,
    "1",
  );
  assert.equal(f.completed.shops[1].ledger.data.inventory.held.iron_tool, "1");
});

test("replaying an old completion cannot credit again or unlock a newer running job", () => {
  const rows = f.after.shops[0].jobs.data.items;
  assert.deepEqual(
    rows.map((j) => [j.job_id, j.status]),
    [
      ["1", "completed"],
      ["3", "running"],
    ],
  );
  assert.equal(f.after.shops[0].ledger.data.inventory.held.health_potion, "1");
  assert.equal(
    f.after.shops[0].ledger.data.inventory.production_output_reserved
      .health_potion,
    "1",
  );
  assert.equal(f.after.town.data.totals.completed_outputs.health_potion, "1");
  assert.equal(f.after.town.data.totals.completed_outputs.iron_tool, "1");
  for (const j of rows) assert.deepEqual(livingTownProductionJob(j), j);
});

test("forged completion timing, ownership, command fields, rewards or signed terms reject", async () => {
  const step = f.steps.find((s) => s.result?.data?.replayed === false),
    p = proof(step),
    result = first.result;
  for (const change of [
    (v) => (v.data.principal = "account:fake.testnet"),
    (v) => (v.data.command_sequence = "1"),
    (v) => (v.data.payload_sha256 = "a".repeat(64)),
    (v) => (v.data.outcome.job.completed_at_ns = "1"),
    (v) => (v.data.outcome.ledger.actor.account_id = "other.testnet"),
    (v) => (v.data.outcome.keeper_reward = "10"),
  ]) {
    const bad = clone(result);
    change(bad);
    await assert.rejects(
      verifyLivingTownCompletionEffect(bad, p.deployment, p.signerId, p.call),
    );
  }
  const wrong = clone(p);
  wrong.call = createLivingTownCompletionCall({ job_id: "2" });
  await assert.rejects(
    verifyLivingTownCompletionReceipt(step.receipt, wrong, async () =>
      block(step),
    ),
  );
  const r = clone(step.receipt);
  r.transaction.receiver_id = "other.testnet";
  await assert.rejects(
    verifyLivingTownCompletionReceipt(r, p, async () => block(step)),
  );
});

function rpcFixture(change = () => {}) {
  const head = f.after.block.header,
    calls = [];
  const rpc = async (method, p) => {
    calls.push({ method, p });
    let result;
    if (method === "status")
      result = { chain_id: "testnet", sync_info: { syncing: false } };
    else if (method === "EXPERIMENTAL_genesis_config")
      result = { chain_id: "testnet", genesis_height: 7 };
    else if (method === "block")
      result =
        p.block_id === 7
          ? {
              header: {
                height: 7,
                hash: f.steps[0].foundation.deployment.genesis_hash,
              },
            }
          : clone(
              p.block_id
                ? (f.steps.find((s) => s.block.header.hash === p.block_id)
                    ?.block ?? f.after.block)
                : f.after.block,
            );
    else if (method === "tx")
      result = clone(
        f.steps.find((s) => s.transaction_hash === p.tx_hash).receipt,
      );
    else if (method === "query") {
      const s =
        f.steps.find((s) => s.block.header.hash === p.block_id) ??
        f.steps.at(-1);
      const header = p.block_id === head.hash ? head : s.block.header;
      if (p.request_type === "view_account")
        result = {
          ...clone(s.account),
          block_hash: header.hash,
          block_height: header.height,
        };
      else if (p.method_name === "get_foundation")
        result = {
          block_hash: header.hash,
          block_height: header.height,
          result: [
            ...Buffer.from(
              JSON.stringify({
                ...s.foundation,
                block_height: String(header.height),
                block_timestamp_ns: header.timestamp_nanosec,
              }),
            ),
          ],
        };
      else if (p.method_name === "get_production_jobs") {
        const args = JSON.parse(
          Buffer.from(p.args_base64, "base64").toString(),
        );
        let body = clone(
          f.after.shops.find((r) => r.shop.data.shop_id === args.shop_id).jobs,
        );
        const eligible = body.data.items.filter(
            (j) =>
              (args.status === "all" || j.status === args.status) &&
              (args.after_id === null ||
                BigInt(j.job_id) > BigInt(args.after_id)),
          ),
          items = eligible.slice(0, Number(args.limit));
        body.data = {
          ...body.data,
          items,
          next_after_id: items.at(-1)?.job_id ?? args.after_id,
          has_more: eligible.length > items.length,
        };
        result = {
          block_hash: head.hash,
          block_height: head.height,
          result: [...Buffer.from(JSON.stringify(body))],
        };
      } else throw Error("unexpected query");
    } else throw Error("unexpected RPC");
    change(method, p, result);
    return result;
  };
  const s = f.steps[0],
    identity = {
      deployment: s.foundation.deployment,
      codeHash: s.account.code_hash,
      ownerId: s.foundation.data.owner_account_id,
      operatorId: s.foundation.data.operator_account_id,
      controllers: s.foundation.data.merchant_controllers,
    };
  return { rpc, identity, calls };
}

test("completion client verifies deployment, historical code and receipt finality", async () => {
  const { rpc, identity } = rpcFixture(),
    client = new LivingTownClient(identity, rpc);
  const step = f.steps.find((s) => s.result?.data?.replayed === false);
  assert.equal((await client.completionReceipt(proof(step))).kind, "succeeded");
  const bad = rpcFixture((m, p, r) => {
    if (m === "query" && p.request_type === "view_account")
      r.code_hash = "11111111111111111111111111111111";
  });
  await assert.rejects(
    new LivingTownClient(bad.identity, bad.rpc).completionReceipt(proof(step)),
  );
});

test("completion evidence exposes the exact already-verified response for event ingestion without another RPC", async () => {
  const { rpc, identity } = rpcFixture();
  let txReads = 0;
  const client = new LivingTownClient(identity, async (m, p) => {
    if (m === "tx") txReads++;
    return rpc(m, p);
  });
  const step = f.steps.find((s) => s.result?.data?.replayed === false),
    p = proof(step),
    evidence = await client.completionReceiptEvidence(p);
  assert.equal(txReads, 1);
  assert.equal(evidence.status.kind, "succeeded");
  const record = livingTownIndexedCompletion(p, evidence);
  assert.equal(record.event.event, "complete_production");
  assert.equal(txReads, 1);
});

test("job paging distinguishes running/completed states and preserves explicit history gaps", async () => {
  const { rpc, identity } = rpcFixture(),
    reader = new FinalizedLivingTownReader(rpc, identity, block(f.after));
  const args = {
    shop_id: "4",
    status: "all",
    after_id: null,
    limit: "1",
    expected_market_revision: f.after.town.market_revision,
  };
  const first = await reader.getProductionJobs(args);
  assert.equal(first.data.items[0].status, "completed");
  assert(first.data.has_more);
  const next = await reader.getProductionJobs({
    ...args,
    after_id: first.data.next_after_id,
  });
  assert.equal(next.data.items[0].status, "running");
  assert.equal(
    (await reader.getProductionJobs({ ...args, status: "completed" })).data
      .items[0].job_id,
    "1",
  );
  assert.equal(
    (await reader.getProductionJobs({ ...args, status: "running" })).data
      .items[0].job_id,
    "3",
  );
  const gap = rpcFixture((m, p, r) => {
    if (m === "query" && p.method_name === "get_production_jobs") {
      const b = JSON.parse(Buffer.from(r.result).toString());
      b.data.history_gap = true;
      b.data.pruned_through = "2";
      r.result = [...Buffer.from(JSON.stringify(b))];
    }
  });
  assert.equal(
    (
      await new FinalizedLivingTownReader(
        gap.rpc,
        gap.identity,
        block(f.after),
      ).getProductionJobs(args)
    ).data.history_gap,
    true,
  );
});
