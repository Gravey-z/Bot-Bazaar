import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { baseEncode } from "near-api-js";
import test from "node:test";
import { WorkerStore } from "../dist/private/storage/database.js";
import { DiscoveryObserver } from "../dist/private/discovery/observer.js";
import { Scheduler } from "../dist/private/scheduling/scheduler.js";
import { verifyBackup } from "../dist/private/storage/backup.js";
import { captured, fixture, proofFor } from "./chain-fixture.mjs";

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "bazaar-scheduler-")),
    chain = fixture();
  const options = {
    dataDir,
    identity: chain.identity,
    policyVersion: "v1",
    create: true,
  };
  let store = new WorkerStore(options),
    scheduler = new Scheduler(store);
  await new DiscoveryObserver(chain.client, store).poll();
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    chain,
    options,
    get store() {
      return store;
    },
    get scheduler() {
      return scheduler;
    },
    async reopen() {
      await store.close();
      store = new WorkerStore({ ...options, create: false });
      scheduler = new Scheduler(store);
    },
  };
}
function purchase(n = 1, now = Date.now()) {
  const trade = {
    ...structuredClone(captured.steps[1].result.data),
    trade_id: String(n),
    settled_at_ns: String(BigInt(now) * 1000000n),
  };
  return {
    key: `purchase:${n}`,
    kind: "player_purchase",
    merchantId: "rex",
    trade,
  };
}
function offer(n = 1) {
  return {
    key: `offer:${n}`,
    kind: "offer_pending",
    merchantId: "luna",
    offer: {
      ...structuredClone(captured.pending.offer.data.offer),
      offer_id: String(n),
      expires_at_ns: String(BigInt(Date.now() + 120000) * 1000000n),
    },
  };
}
function emit(f, signals, now = Date.now()) {
  const previous = f.store.discoveryState(),
    state = structuredClone(previous);
  state.observedAt = now;
  state.block.height = String(BigInt(state.block.height) + 1n);
  state.block.hash = baseEncode(
    createHash("sha256").update(state.block.height).digest(),
  );
  state.market.block_height = state.block.height;
  state.block.timestampNs = String(BigInt(now) * 1000000n);
  state.market.block_timestamp_ns = state.block.timestampNs;
  state.market.market_revision = String(
    BigInt(state.market.market_revision) + 1n,
  );
  for (const signal of signals)
    if (signal.kind === "offer_pending")
      state.offers = [
        ...state.offers.filter((row) => row.offer_id !== signal.offer.offer_id),
        signal.offer,
      ];
  f.store.commitDiscovery({
    previousHash: previous.block.hash,
    state,
    signals,
  });
}
function allowTurns(f) {
  // Simulates the future trusted P3.5 reconciliation barrier, never a runtime API.
  f.store.db.exec("UPDATE deployment SET recovery_required=0");
  for (const name of ["rex", "luna", "bolt"])
    f.store.recordMerchantCheckpoint(name, "0", null, true);
}
function ingest(f, signal = purchase()) {
  emit(f, [signal]);
  f.scheduler.tick();
  return f.store.scheduler.inputs().at(-1).job_id;
}
function firstTurn(f, job) {
  return f.store.scheduler.turns(job).find((row) => row.status === "queued");
}
const listing = (job, id = "intent", merchantId = "rex") => ({
  id,
  jobId: job,
  merchantId,
  method: "set_listing",
  args: {
    merchant_id: merchantId,
    resource: "crystal",
    unit_price: "4",
    quantity: "1",
    active: true,
    expected_version: "1",
    action_id: "1",
  },
});

test("receipt/view observations merge into one deployment-scoped business root in either order", async (t) => {
  for (const first of ["view", "receipt"]) {
    const f = await setup(t),
      step = captured.steps[1],
      signal = {
        key: "purchase:1",
        kind: "player_purchase",
        merchantId: "rex",
        trade: step.result.data,
      };
    if (first === "view") {
      emit(f, [signal]);
      f.scheduler.tick();
    }
    await f.scheduler.observePurchaseReceipt(step.receipt, proofFor(step));
    emit(f, [signal]);
    f.scheduler.tick();
    assert.equal(f.store.scheduler.roots().length, 1);
    assert.equal(f.store.scheduler.inputs().length, 1);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM scheduler_sources").get().n,
      2,
    );
    const job = f.store.scheduler.roots()[0].job_id;
    await f.reopen();
    await f.scheduler.observePurchaseReceipt(step.receipt, proofFor(step));
    assert.equal(f.store.scheduler.roots()[0].job_id, job);
    assert.equal(
      f.store.scheduler.roots()[0].status,
      "expired",
      "historical purchase must not get a fresh decision window",
    );
  }
});

test("failed receipt logs and wrong-deployment evidence cannot schedule a purchase", async (t) => {
  const f = await setup(t),
    step = captured.steps[1],
    failed = structuredClone(step.receipt);
  failed.status = { Failure: { ActionError: {} } };
  failed.receipts_outcome[0].outcome.status = failed.status;
  await assert.rejects(
    f.scheduler.observePurchaseReceipt(failed, proofFor(step)),
  );
  await assert.rejects(
    f.scheduler.observePurchaseReceipt(step.receipt, {
      ...proofFor(step),
      contractId: "other.testnet",
    }),
  );
  assert.deepEqual(f.store.scheduler.roots(), []);
});

test("gap interval/upper-bound keys and repeated polls retain exactly one catch-up identity", async (t) => {
  const f = await setup(t),
    gap = {
      key: "gap:trades:0:10",
      kind: "history_gap",
      merchantId: null,
      stream: "trades",
      after: null,
      prunedThrough: "10",
      upperBound: "20",
    };
  const job = ingest(f, gap);
  emit(f, [gap]);
  f.scheduler.tick();
  await f.reopen();
  emit(f, [gap]);
  f.scheduler.tick();
  assert.equal(f.store.scheduler.roots().length, 1);
  assert.equal(f.store.scheduler.roots()[0].job_id, job);
  assert.equal(
    f.store.scheduler.inputs()[0].business_key,
    "gap:trades:0:10:20",
  );
  assert.equal(f.store.scheduler.turns(job).length, 3);
});

test("idle/listing/cleanup revisions cannot generate roots and drained signals are not reinserted", async (t) => {
  const f = await setup(t);
  emit(f, []);
  f.scheduler.tick();
  assert.deepEqual(f.store.scheduler.roots(), []);
  const signal = purchase(),
    job = ingest(f, signal);
  emit(f, [signal]);
  assert.deepEqual(f.store.discoverySignals(), []);
  f.scheduler.tick();
  assert.equal(f.store.scheduler.roots()[0].job_id, job);
});

test("queue saturation coalesces only not-started triggers and leaves the active root intact", async (t) => {
  const f = await setup(t),
    now = Date.now(),
    active = ingest(f, purchase(1, now));
  allowTurns(f);
  f.store.scheduler.claimTurn(firstTurn(f, active).id);
  emit(
    f,
    Array.from({ length: 105 }, (_, i) => purchase(i + 2, now)),
  );
  f.scheduler.tick();
  assert.equal(
    f.store.jobs().filter((row) => row.status === "queued").length,
    100,
  );
  assert.equal(f.store.getJob(active).status, "active");
  assert.equal(
    f.store.scheduler.roots().find((row) => row.job_id === active).kind,
    "purchase",
  );
  const catchup = f.store.scheduler
    .roots()
    .find((row) => row.kind === "catchup");
  assert.ok(catchup);
  assert.ok(catchup.last_seq > catchup.first_seq);
  assert.equal(f.store.scheduler.inputs().length, 106);
  assert.equal(f.store.discoverySignals().length, 0);
});

test("all-or-nothing inbox handoff retains signals if no safe coalescing candidate exists", async (t) => {
  const f = await setup(t),
    now = Date.now();
  for (let i = 0; i < 100; i++)
    f.store.enqueue({
      id: `legacy${i}`,
      triggerKey: `legacy${i}`,
      triggerRef: "old",
      deadline: now + 120000,
    });
  emit(f, [purchase(1, now)]);
  assert.throws(() => f.scheduler.tick());
  assert.equal(f.store.discoverySignals().length, 1);
  assert.equal(f.store.scheduler.inputs().length, 0);
  assert.equal(f.store.jobs().length, 100);
});

test("offer wakes attach to their existing root; unknown offers are quarantined without new roots", async (t) => {
  const f = await setup(t),
    signal = offer();
  emit(f, [signal]);
  f.scheduler.tick();
  assert.equal(f.store.scheduler.roots().length, 0);
  assert.equal(f.store.scheduler.inputs()[0].disposition, "quarantined");
  const job = ingest(f, purchase(2));
  f.store.putOffer({
    id: "1",
    jobId: job,
    status: "pending",
    expiresAtNs: signal.offer.expires_at_ns,
    cleanupAck: false,
  });
  f.scheduler.tick();
  const turns = f.store.scheduler.turns(job);
  assert.equal(turns.filter((row) => row.merchant_id === "luna").length, 1);
  emit(f, [signal]);
  f.scheduler.tick();
  assert.equal(f.store.scheduler.roots().length, 1);
  assert.equal(f.store.scheduler.turns(job).length, 2);
});

test("recovery, pause, stale snapshots and a duplicate turn claim stop decision admission", async (t) => {
  const f = await setup(t),
    job = ingest(f),
    turn = firstTurn(f, job);
  assert.throws(() => f.store.scheduler.claimTurn(turn.id), /reconciliation/);
  allowTurns(f);
  const original = f.store.discoveryState();
  f.store.db.prepare("UPDATE discovery_state SET state_json=?").run(
    JSON.stringify({
      ...original,
      market: {
        ...original.market,
        data: { ...original.market.data, paused: true },
      },
    }),
  );
  assert.throws(() => f.store.scheduler.claimTurn(turn.id), /paused/);
  f.store.db
    .prepare("UPDATE discovery_state SET state_json=?")
    .run(JSON.stringify({ ...original, observedAt: Date.now() - 16000 }));
  assert.throws(() => f.store.scheduler.claimTurn(turn.id), /stale/);
  f.store.db
    .prepare("UPDATE discovery_state SET state_json=?")
    .run(JSON.stringify(original));
  f.store.scheduler.claimTurn(turn.id);
  assert.throws(() => f.store.scheduler.claimTurn(turn.id), /claimed/);
  assert.equal(f.store.scheduler.roots()[0].model_calls, 1);
  assert.throws(() => f.store.activateJob(job));
  assert.throws(() => f.store.completeJob(job, "completed"));
});

test("each scheduled mutation requires an immutable turn reservation and one controller slot", async (t) => {
  const f = await setup(t),
    job = ingest(f);
  allowTurns(f);
  const turn = firstTurn(f, job);
  f.store.scheduler.claimTurn(turn.id);
  const intent = listing(job);
  await assert.rejects(f.store.prepareIntent(intent), /reservation/);
  f.store.scheduler.reserveMutation(turn.id, intent);
  await assert.rejects(
    f.store.prepareIntent({
      ...intent,
      args: { ...intent.args, unit_price: "5" },
    }),
    /reservation/,
  );
  await f.store.prepareIntent(intent);
  assert.throws(() => f.store.scheduler.finishTurn(turn.id), /unresolved/);
  assert.throws(
    () => f.store.scheduler.reserveMutation(turn.id, { ...intent, id: "next" }),
    /unresolved/,
  );
  f.store.abandonUnsigned(intent.id);
  f.store.scheduler.finishTurn(turn.id);
  assert.equal(f.store.locks().length, 0);
});

test("root mutation limit and per-merchant listing/proposal limits survive restarts", async (t) => {
  const f = await setup(t),
    job = ingest(f);
  allowTurns(f);
  const turn = firstTurn(f, job);
  f.store.scheduler.claimTurn(turn.id);
  f.store.scheduler.reserveMutation(turn.id, listing(job));
  assert.throws(() =>
    f.store.scheduler.reserveMutation(turn.id, listing(job, "second")),
  );
  const proposal = {
    id: "proposal",
    jobId: job,
    merchantId: "rex",
    method: "propose_trade",
    args: captured.steps[2].args,
  };
  f.store.scheduler.reserveMutation(turn.id, proposal);
  assert.throws(() =>
    f.store.scheduler.reserveMutation(turn.id, {
      ...proposal,
      id: "another-proposal",
    }),
  );
  for (let i = 2; i < 8; i++)
    f.store.scheduler.reserveMutation(turn.id, {
      id: `cleanup${i}`,
      jobId: job,
      merchantId: "rex",
      method: "expire_offers",
      args: { offer_ids: ["1"] },
    });
  assert.throws(
    () =>
      f.store.scheduler.reserveMutation(turn.id, {
        id: "overflow",
        jobId: job,
        merchantId: "rex",
        method: "expire_offers",
        args: { offer_ids: ["1"] },
      }),
    /budget/,
  );
  await f.reopen();
  assert.equal(f.store.scheduler.roots()[0].mutations, 8);
  assert.equal(f.store.scheduler.turns(job)[0].status, "running");
});

test("settlement schedules one listing-only follow-up per participant and cannot create a new root", async (t) => {
  const f = await setup(t),
    job = ingest(f);
  allowTurns(f);
  const first = firstTurn(f, job);
  f.store.scheduler.claimTurn(first.id);
  f.store.scheduler.finishTurn(first.id);
  f.store.scheduler.settlement(job, "1", ["rex", "luna"]);
  f.store.scheduler.settlement(job, "1", ["rex", "luna"]);
  const turns = f.store.scheduler
    .turns(job)
    .filter((row) => row.phase === "followup");
  assert.equal(turns.length, 2);
  const turn = turns.find((row) => row.merchant_id === "rex");
  f.store.scheduler.claimTurn(turn.id);
  assert.throws(
    () =>
      f.store.scheduler.reserveMutation(turn.id, {
        id: "proposal",
        jobId: job,
        merchantId: "rex",
        method: "propose_trade",
        args: captured.steps[2].args,
      }),
    /listing only/,
  );
  f.store.scheduler.reserveMutation(turn.id, listing(job));
  assert.equal(f.store.scheduler.roots().length, 1);
});

test("later completed inputs cannot skip an earlier unresolved root; compaction keeps dedup tombstones", async (t) => {
  const f = await setup(t),
    one = ingest(f, purchase(1)),
    two = ingest(f, purchase(2));
  f.store.scheduler.finishRoot(two, Date.now() + 121000);
  assert.equal(f.store.scheduler.state().completed_seq, 0);
  f.store.scheduler.compact(Date.now() + 8 * 86400000);
  assert.ok(f.store.scheduler.inputs()[1].payload_json);
  f.store.scheduler.finishRoot(one, Date.now() + 121000);
  assert.equal(f.store.scheduler.state().completed_seq, 2);
  f.store.scheduler.compact(Date.now() + 8 * 86400000);
  assert.ok(
    f.store.scheduler.inputs().every((row) => row.payload_json === null),
  );
  assert.equal(f.store.scheduler.inputs().length, 2);
});

test("root expiry never releases a prepared or unknown mutation", async (t) => {
  const f = await setup(t),
    job = ingest(f);
  allowTurns(f);
  const turn = firstTurn(f, job);
  f.store.scheduler.claimTurn(turn.id);
  const intent = listing(job);
  f.store.scheduler.reserveMutation(turn.id, intent);
  await f.store.prepareIntent(intent);
  assert.throws(
    () => f.store.scheduler.finishRoot(job, Date.now() + 121000),
    /pending work/,
  );
  await f.reopen();
  assert.equal(f.store.unresolvedIntents().length, 1);
  assert.equal(f.store.locks().length, 1);
  assert.equal(f.store.checkpoint().recovery_required, 1);
});

test("v2 migration preserves discovery observations and produces a verifiable v2 snapshot", async (t) => {
  const f = await setup(t);
  emit(f, [purchase()]);
  const original = f.store.discoveryState();
  await f.store.close();
  const db = new DatabaseSync(join(f.dataDir, "worker.sqlite"));
  db.exec(
    "DROP TABLE provider_attempts;DROP TABLE retry_state;DROP TABLE scheduler_mutations;DROP TABLE scheduler_turns;DROP TABLE scheduler_sources;DROP TABLE scheduler_inputs;DROP TABLE scheduler_roots;DROP TABLE scheduler_state;PRAGMA user_version=2;",
  );
  db.close();
  await f.reopen();
  assert.deepEqual(f.store.discoveryState(), original);
  assert.equal(f.store.discoverySignals().length, 1);
  const root = join(f.dataDir, "backups"),
    names = await readdir(root);
  assert.equal((await verifyBackup(join(root, names[0]))).schema, 2);
  f.scheduler.tick();
  assert.equal(f.store.scheduler.roots().length, 1);
});

test("six decision slots bound a reaction chain and expired offer wakes cannot claim a slot", async (t) => {
  const f = await setup(t),
    gap = {
      key: "gap:offers:0:1",
      kind: "history_gap",
      merchantId: null,
      stream: "offers",
      after: null,
      prunedThrough: "1",
      upperBound: "2",
    };
  const job = ingest(f, gap);
  allowTurns(f);
  for (const turn of f.store.scheduler.turns(job)) {
    f.store.scheduler.claimTurn(turn.id);
    f.store.scheduler.finishTurn(turn.id);
  }
  f.store.scheduler.settlement(job, "1", ["rex", "luna"]);
  for (const turn of f.store.scheduler
    .turns(job)
    .filter((row) => row.phase === "followup")) {
    f.store.scheduler.claimTurn(turn.id);
    f.store.scheduler.finishTurn(turn.id);
  }
  const signal = offer(1);
  f.store.putOffer({
    id: "1",
    jobId: job,
    status: "pending",
    expiresAtNs: signal.offer.expires_at_ns,
    cleanupAck: false,
  });
  emit(f, [signal]);
  f.scheduler.tick();
  const sixth = firstTurn(f, job);
  f.store.scheduler.claimTurn(sixth.id);
  f.store.scheduler.finishTurn(sixth.id);
  const next = offer(2);
  f.store.putOffer({
    id: "2",
    jobId: job,
    status: "pending",
    expiresAtNs: next.offer.expires_at_ns,
    cleanupAck: false,
  });
  emit(f, [next]);
  f.scheduler.tick();
  assert.throws(
    () => f.store.scheduler.claimTurn(firstTurn(f, job).id),
    /budget/,
  );
  assert.equal(f.store.scheduler.roots()[0].model_calls, 6);
  const f2 = await setup(t),
    job2 = ingest(f2, purchase(3));
  allowTurns(f2);
  const expired = offer(4);
  expired.offer.expires_at_ns = "1";
  f2.store.putOffer({
    id: "4",
    jobId: job2,
    status: "pending",
    expiresAtNs: "1",
    cleanupAck: false,
  });
  emit(f2, [expired]);
  f2.scheduler.tick();
  const wake = f2.store.scheduler
    .turns(job2)
    .find((row) => row.source_key === "offer:4");
  assert.throws(() => f2.store.scheduler.claimTurn(wake.id), /no longer live/);
  assert.equal(f2.store.scheduler.roots()[0].model_calls, 0);
});

test("unexplained controller offers block new turns until linked to their reconciled root", async (t) => {
  const f = await setup(t),
    signal = offer(1);
  emit(f, [signal]);
  f.scheduler.tick();
  const job = ingest(f, purchase(2));
  allowTurns(f);
  const turn = f.store.scheduler
    .turns(job)
    .find((row) => row.merchant_id === "rex");
  assert.throws(() => f.store.scheduler.claimTurn(turn.id), /quarantined/);
  f.store.putOffer({
    id: "1",
    jobId: job,
    status: "pending",
    expiresAtNs: signal.offer.expires_at_ns,
    cleanupAck: false,
  });
  f.scheduler.tick();
  assert.equal(f.store.scheduler.claimTurn(turn.id).status, "running");
});

test("turn selection stays on the active root and serializes competing merchant claims", async (t) => {
  const f = await setup(t),
    one = ingest(f, purchase(1)),
    two = ingest(f, purchase(2));
  allowTurns(f);
  assert.equal(f.store.scheduler.nextTurn().job_id, one);
  const turn = firstTurn(f, one);
  f.store.scheduler.claimTurn(turn.id);
  assert.throws(() => f.store.scheduler.claimTurn(firstTurn(f, two).id));
  assert.equal(f.store.getJob(two).status, "queued");
  f.store.scheduler.finishTurn(turn.id);
  f.store.claimLocks(one, ["rex", "luna"], "commitment");
  const wake = offer(1);
  f.store.putOffer({
    id: "1",
    jobId: one,
    status: "pending",
    expiresAtNs: wake.offer.expires_at_ns,
    cleanupAck: false,
  });
  emit(f, [wake]);
  f.scheduler.tick();
  const candidate = f.store.scheduler.nextTurn();
  assert.equal(candidate.job_id, one);
  assert.equal(candidate.merchant_id, "luna");
  assert.equal(
    f.store.scheduler.claimTurn(candidate.id).status,
    "running",
    "same commitment must not deadlock its counterparty",
  );
});
