import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { evaluateDecision } from "../dist/private/policy/evaluate.js";
import { WorkerStore } from "../dist/private/storage/database.js";
import { DiscoveryObserver } from "../dist/private/discovery/observer.js";
import { Scheduler } from "../dist/private/scheduling/scheduler.js";
import { ProviderRunner } from "../dist/private/retries/provider.js";
import { fixture, captured } from "./chain-fixture.mjs";
import { dropPolicy, inferenceFixture } from "./policy-fixture.mjs";
import { verifyBackup } from "../dist/private/storage/backup.js";
import { CrashSafeProcessor } from "../dist/private/recovery/processor.js";
const now = Date.now(),
  day = 86400000;
function context(name = "rex") {
  const market = structuredClone(captured.seed.market),
    block = {
      hash: captured.seed.finalized_block.hash,
      height: market.block_height,
      timestampNs: String(BigInt(now) * 1000000n),
    };
  market.block_timestamp_ns = block.timestampNs;
  market.data.merchants[0].inventory.crystal = "3";
  market.data.merchants[0].gold = "228";
  market.data.merchants[0].listings[0].quantity = "3";
  return {
    merchantId: name,
    phase: "decision",
    rootDeadline: now + 120000,
    rexShortageMode: true,
    mutationsRemaining: 8,
    commitments: [],
    rejectedOfferIds: [],
    changedResources: ["crystal", "wood", "herb", "iron"],
    state: {
      market,
      block,
      observedAt: now,
      offers: [],
      trades: [],
      mode: "initial",
      tradeCursor: "0",
    },
  };
}
const buy = (c, quantity = "4", total = "24") => ({
  method: "propose_trade",
  args: {
    proposer: c.merchantId,
    buyer: "rex",
    seller: "luna",
    resource: "crystal",
    quantity,
    total_price: total,
    expires_at_ns: String(BigInt(now + 120000) * 1000000n),
    action_id: "1",
  },
});
function incoming(c, terms = {}) {
  const offer = {
    ...structuredClone(captured.pending.offer.data.offer),
    offer_id: "1",
    created_at_ns: c.state.block.timestampNs,
    expires_at_ns: String(BigInt(now + 120000) * 1000000n),
    status: "pending",
    ...terms,
  };
  c.state.offers = [offer];
  return { method: "accept_trade", args: { offer_id: "1", action_id: "1" } };
}
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "bazaar-policy-")),
    chain = fixture();
  const config = {
    dataDir,
    identity: options.identity ?? chain.identity,
    policyVersion: "v1",
    create: true,
  };
  let store = new WorkerStore(config);
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    config,
    chain,
    get store() {
      return store;
    },
    reopen: async () => {
      await store.close();
      store = new WorkerStore({ ...config, create: false });
    },
  };
}
function grant(
  store,
  config = {
    projectId: "test",
    laneId: "public",
    portions: [{ laneId: "public", dailyMicro: 500000, monthlyMicro: 5000000 }],
  },
  time = now,
) {
  store.budget.configure(config, time);
  store.budget.reconcile(
    {
      ...store.budget.context(),
      fencing: "verified",
      history: "accounted",
      evidenceRef: "unit:verified",
    },
    time,
  );
}
const prepared = (extra = {}) => ({
  provider: "near-ai",
  model: "fixture-model",
  payload: '{"messages":[],"max_output_tokens":512}',
  maxOutputTokens: 512,
  countTokens: () => 4096,
  accountingEvidence: "unit:tokenizer",
  worstInputMicroPerMillion: 100000,
  outputMicroPerMillion: 500000,
  pricingEvidence: "unit:rates",
  verifiedUntil: now + 40 * day,
  ...extra,
});

test("Rex may choose a bounded restock; deactivation and counterparty capacity are separate prerequisites", () => {
  const c = context(),
    result = evaluateDecision(buy(c), c, now);
  assert.equal(result.trade.quantity, "4");
  assert.equal(result.requiredSlots, 4);
  assert.equal(result.preparations.length, 1);
  assert.equal(result.preparations[0].args.active, false);
  assert.equal(result.preparations[0].args.quantity, "0");
  assert.equal(result.action.args.total_price, "24");
  for (const stock of ["5", "7"]) {
    c.state.market.data.merchants[0].inventory.crystal = stock;
    assert.throws(() => evaluateDecision(buy(c), c, now), /purchase_trigger/);
  }
});
test("affordability, quantity, both stock floors, and both price bands are independent hard gates", () => {
  const c = context();
  c.state.market.data.merchants[0].gold = "85";
  assert.throws(
    () => evaluateDecision(buy(c, "1", "6"), c, now),
    /gold_reserve/,
  );
  c.state.market.data.merchants[0].gold = "86";
  assert.equal(evaluateDecision(buy(c, "1", "6"), c, now).trade.quantity, "1");
  assert.throws(
    () => evaluateDecision(buy(c, "2", "12"), c, now),
    /gold_reserve/,
  );
  c.state.market.data.merchants[0].gold = "228";
  assert.throws(() => evaluateDecision(buy(c, "5", "30"), c, now), /quantity/);
  assert.throws(() => evaluateDecision(buy(c, "1", "7"), c, now), /price/);
  assert.throws(
    () => evaluateDecision(buy(c, "1", "5"), c, now),
    /quote|price/,
  );
  c.state.market.data.merchants[1].inventory.crystal = "7";
  assert.throws(() => evaluateDecision(buy(c), c, now), /stock_reserve/);
});
test("Luna's acceptance references stored terms and needs confirmed listing reduction", () => {
  const c = context("luna");
  c.state.market.data.merchants[1].inventory.crystal = "8";
  const action = incoming(c),
    result = evaluateDecision(action, c, now);
  assert.equal(result.preparations[0].args.quantity, "0");
  assert.equal(result.requiredSlots, 2);
  c.state.market.data.merchants[1].inventory.crystal = "7";
  assert.throws(() => evaluateDecision(action, c, now), /stock_reserve/);
});
test("Luna only buys low herbs; Bolt buys target-limited discounted wood or iron", () => {
  for (const [name, resource, count, total, seller] of [
    ["luna", "herb", "2", "4", "bolt"],
    ["bolt", "wood", "1", "1", "rex"],
    ["bolt", "iron", "2", "6", "rex"],
  ]) {
    const c = context(name),
      own = c.state.market.data.merchants.find((m) => m.merchant_id === name);
    own.inventory[resource] =
      resource === "herb" ? "10" : resource === "wood" ? "17" : "10";
    const action = incoming(c, {
      buyer: name,
      seller,
      proposer: seller,
      counterparty: name,
      resource,
      quantity: count,
      total_price: total,
      unit_price: String(BigInt(total) / BigInt(count)),
    });
    assert.equal(evaluateDecision(action, c, now).trade.quantity, count);
    c.state.offers[0].total_price = String(BigInt(count) * 4n);
    c.state.offers[0].unit_price = "4";
    assert.throws(() => evaluateDecision(action, c, now), /price/);
  }
  const c = context("bolt");
  const a = incoming(c, {
    buyer: "bolt",
    seller: "luna",
    proposer: "luna",
    counterparty: "bolt",
  });
  assert.throws(() => evaluateDecision(a, c, now), /trigger/);
});
test("caller, pause, freshness, followup, lifetime, rejection and ordered offer gates cannot be bypassed", () => {
  const c = context(),
    a = buy(c);
  assert.throws(
    () =>
      evaluateDecision({ ...a, args: { ...a.args, proposer: "luna" } }, c, now),
    /caller/,
  );
  c.phase = "followup";
  assert.throws(() => evaluateDecision(a, c, now), /followup/);
  c.phase = "decision";
  c.mutationsRemaining = 3;
  assert.throws(() => evaluateDecision(a, c, now), /capacity/);
  c.mutationsRemaining = 8;
  c.state.market.data.paused = true;
  assert.throws(() => evaluateDecision({ method: "hold" }, c, now), /paused/);
  c.state.market.data.paused = false;
  assert.throws(() => evaluateDecision(a, c, now + 15001), /stale/);
  const l = context("luna"),
    accept = incoming(l);
  l.state.offers[0].expires_at_ns = String(BigInt(now + 29999) * 1000000n);
  assert.throws(() => evaluateDecision(accept, l, now), /too_late/);
  l.state.offers[0].expires_at_ns = String(BigInt(now + 120000) * 1000000n);
  l.rejectedOfferIds = ["1"];
  assert.throws(() => evaluateDecision(accept, l, now), /unavailable/);
  l.rejectedOfferIds = [];
  l.state.offers.push({
    ...l.state.offers[0],
    offer_id: "2",
    created_at_ns: String(BigInt(now) * 1000000n - 1n),
  });
  assert.throws(() => evaluateDecision(accept, l, now), /priority/);
});
test("shortage prices, no-op/idle listing updates and committed stock remain protected", () => {
  const c = context();
  const listing = {
    method: "set_listing",
    args: {
      merchant_id: "rex",
      resource: "crystal",
      unit_price: "6",
      quantity: "1",
      active: true,
      expected_version: "1",
      action_id: "1",
    },
  };
  assert.throws(() => evaluateDecision(listing, c, now), /price/);
  listing.args.unit_price = "7";
  assert.equal(evaluateDecision(listing, c, now).preparations.length, 0);
  c.changedResources = [];
  assert.throws(() => evaluateDecision(listing, c, now), /idle/);
  c.changedResources = ["crystal"];
  c.commitments = [
    {
      buyer: "luna",
      seller: "rex",
      resource: "crystal",
      quantity: "3",
      total_price: "21",
      offerId: "1",
    },
  ];
  assert.throws(() => evaluateDecision(listing, c, now), /stock/);
});
test("competing local and observed offers prohibit new trades even when balances look affordable", () => {
  const c = context();
  c.commitments = [
    {
      buyer: "luna",
      seller: "bolt",
      resource: "herb",
      quantity: "1",
      total_price: "2",
      offerId: "2",
    },
  ];
  assert.throws(() => evaluateDecision(buy(c), c, now), /competing/);
  c.commitments = [];
  incoming(c, {
    buyer: "bolt",
    seller: "luna",
    counterparty: "bolt",
    resource: "iron",
  });
  assert.throws(() => evaluateDecision(buy(c), c, now), /competing_offer/);
});
test("project lanes are disjoint immutable portions and cannot multiply the shared allowance", async (t) => {
  const f = await setup(t),
    config = {
      projectId: "test",
      laneId: "public",
      portions: [
        { laneId: "public", dailyMicro: 250000, monthlyMicro: 2500000 },
        { laneId: "rehearsal", dailyMicro: 250000, monthlyMicro: 2500000 },
      ],
    };
  grant(f.store, config);
  assert.throws(
    () =>
      f.store.budget.configure({
        ...config,
        portions: [
          { laneId: "public", dailyMicro: 500000, monthlyMicro: 5000000 },
          { laneId: "rehearsal", dailyMicro: 1000, monthlyMicro: 1000 },
        ],
      }),
    /allocation/,
  );
  assert.throws(
    () => f.store.budget.configure({ ...config, laneId: "rehearsal" }),
    /immutable/,
  );
});
test("spend is durably reserved at integer worst-case rates; unknown billing never receives a refund", async (t) => {
  const f = await setup(t);
  grant(f.store, {
    projectId: "test",
    laneId: "public",
    portions: [{ laneId: "public", dailyMicro: 2000, monthlyMicro: 3000 }],
  });
  f.store.budget.reserve("one", prepared(), now);
  f.store.budget.reserve("two", prepared(), now);
  assert.equal(f.store.budget.history().entries[0].charged_micro, 1000);
  assert.throws(
    () => f.store.budget.reserve("three", prepared(), now),
    /spend/,
  );
  f.store.budget.account("one", "near-ai", "fixture-model", 100, "unit:usage");
  assert.equal(f.store.budget.history().entries[0].charged_micro, 100);
  assert.throws(
    () =>
      f.store.budget.account(
        "one",
        "near-ai",
        "fixture-model",
        0,
        "unit:again",
      ),
    /mismatch/,
  );
});
test("full prepared context, output, pricing, provider identity and missing history fail closed before dispatch", async (t) => {
  const f = await setup(t);
  grant(f.store);
  for (const extra of [
    { countTokens: () => 4097 },
    { maxOutputTokens: 513 },
    { accountingEvidence: "" },
    { pricingEvidence: "" },
    { verifiedUntil: now - 1 },
    { worstInputMicroPerMillion: NaN },
    { payload: "x".repeat(65537) },
  ])
    assert.throws(() => f.store.budget.reserve("bad", prepared(extra), now));
  let calls = 0;
  await assert.rejects(
    new ProviderRunner(f.store).run(
      {
        id: "no-gate",
        turnId: "none",
        provider: "near-ai",
        model: "fixture-model",
        promptVersion: "v1",
      },
      async () => {
        calls++;
        return { action: { method: "hold" }, reason: "wait" };
      },
    ),
  );
  assert.equal(calls, 0);
  assert.equal(f.store.budget.history().entries.length, 0);
});
test("fresh contracts inherit lane usage, immutable deployment labels and rolling caps (D06)", async (t) => {
  const a = await setup(t),
    b = await setup(t, {
      identity: {
        ...fixture().identity,
        contractId: "fresh-bazaar.testnet",
        ownerId: "fresh-bazaar.testnet",
      },
    }),
    config = {
      projectId: "test",
      laneId: "rehearsal",
      portions: [
        { laneId: "public", dailyMicro: 499000, monthlyMicro: 4999000 },
        { laneId: "rehearsal", dailyMicro: 1000, monthlyMicro: 1000 },
      ],
    };
  grant(a.store, config);
  a.store.budget.reserve("old-request", prepared(), now);
  const history = a.store.budget.history();
  b.store.budget.configure(config, now);
  b.store.budget.adopt(history, now);
  b.store.budget.reconcile(
    {
      ...b.store.budget.context(),
      fencing: "verified",
      history: "accounted",
      evidenceRef: "unit:old-worker-fenced",
    },
    now,
  );
  assert.equal(
    b.store.budget.history().entries[0].deployment,
    history.entries[0].deployment,
  );
  assert.throws(
    () => b.store.budget.reserve("new-request", prepared(), now),
    /spend/,
  );
  assert.throws(
    () =>
      b.store.budget.reconcile(
        {
          ...a.store.budget.context(),
          fencing: "verified",
          history: "accounted",
          evidenceRef: "unit:replayed",
        },
        now,
      ),
    /continuity/,
  );
});
test("restart, rollback and missing restored usage block inference until verified history or 30 trusted days", async (t) => {
  const f = await setup(t);
  grant(f.store);
  f.store.budget.reserve("one", prepared(), now);
  await f.reopen();
  assert.throws(
    () => f.store.budget.reserve("two", prepared(), now),
    /reconciliation/,
  );
  f.store.budget.missingHistory(now, "unit:fenced");
  assert.throws(
    () =>
      f.store.budget.reconcile(
        {
          ...f.store.budget.context(),
          fencing: "verified",
          history: "aged_out",
          evidenceRef: "unit:age",
        },
        now + 30 * day - 1,
      ),
    /protected/,
  );
  f.store.budget.reconcile(
    {
      ...f.store.budget.context(),
      fencing: "verified",
      history: "aged_out",
      evidenceRef: "unit:age",
    },
    now + 30 * day,
  );
  f.store.budget.reserve("aged", prepared(), now + 30 * day);
  assert.throws(
    () => f.store.budget.reserve("rollback", prepared(), now),
    /reconciliation/,
  );
});
test("v4 migration backs up old journals and leaves new financial gates unconfigured", async (t) => {
  const f = await setup(t);
  await f.store.close();
  const db = new DatabaseSync(join(f.dataDir, "worker.sqlite"));
  db.exec(dropPolicy + "PRAGMA user_version=4;");
  db.close();
  await f.reopen();
  assert.equal(f.store.budget.state(), undefined);
  const folders = await readdir(join(f.dataDir, "backups"));
  assert.equal(
    (await verifyBackup(join(f.dataDir, "backups", folders[0]))).schema,
    4,
  );
});
test("a policy plan binds original terms, reserves future capacity and refuses premature final execution", async (t) => {
  const f = await setup(t);
  await new DiscoveryObserver(f.chain.client, f.store).poll();
  const state = f.store.discoveryState(),
    c = context();
  Object.assign(state, c.state);
  const trade = {
    ...structuredClone(captured.steps[1].result.data),
    settled_at_ns: state.block.timestampNs,
  };
  f.store.commitDiscovery({
    previousHash: f.store.discoveryState().block.hash,
    state,
    signals: [
      { key: "purchase:1", kind: "player_purchase", merchantId: "rex", trade },
    ],
  });
  new Scheduler(f.store).tick(now);
  f.store.db.exec("UPDATE deployment SET recovery_required=0");
  f.store.recordMerchantCheckpoint("rex", "0", null, true);
  const turn = f.store.scheduler.nextTurn();
  f.store.scheduler.claimTurn(turn.id, now);
  f.store.saveDecision(
    {
      id: "choice",
      jobId: turn.job_id,
      merchantId: "rex",
      provider: "near-ai",
      model: "fixture",
      promptVersion: "v1",
      action: buy(c),
      reason: "restock",
    },
    now,
  );
  assert.equal(f.store.policy.authorize("choice", now).kind, "planned");
  const step = f.store.policy.next("choice", now);
  assert.equal(step.method, "set_listing");
  assert.equal(step.args.active, false);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM policy_commitments").get().n,
    2,
  );
  assert.equal(
    f.store.db.prepare("SELECT slots_remaining AS n FROM policy_plans").get().n,
    3,
  );
  const steps = JSON.parse(
    f.store.db.prepare("SELECT steps_json FROM policy_plans").get().steps_json,
  );
  assert.throws(
    () => f.store.policy.assertIntent(steps[1].intent, state, now),
    /prerequisite/,
  );
  assert.throws(
    () =>
      f.store.policy.assertIntent(
        { ...step, args: { ...step.args, unit_price: "7" } },
        state,
        now,
      ),
    /identity/,
  );
  const before = f.store.db
    .prepare("SELECT mutations FROM scheduler_roots")
    .get().mutations;
  assert.throws(() => f.store.policy.authorize("choice", now), /already/);
  assert.equal(
    f.store.db.prepare("SELECT mutations FROM scheduler_roots").get().mutations,
    before,
  );
});

async function modelRoot(t, name = "rex", beforeClaim = async () => {}) {
  const f = await setup(t);
  await new DiscoveryObserver(f.chain.client, f.store).poll();
  const c = context(name);
  f.store.commitDiscovery({
    previousHash: f.store.discoveryState().block.hash,
    state: c.state,
    signals: [
      {
        key: "gap:offers:0:5:10",
        kind: "history_gap",
        merchantId: null,
        stream: "offers",
        after: "0",
        prunedThrough: "5",
        upperBound: "10",
      },
    ],
  });
  new Scheduler(f.store).tick(now);
  f.store.db.exec("UPDATE deployment SET recovery_required=0");
  const job = f.store.scheduler.roots()[0].job_id,
    turn = f.store.scheduler.turns(job).find((row) => row.merchant_id === name);
  f.store.recordMerchantCheckpoint(name, "0", null, true);
  await beforeClaim(f, c);
  f.store.scheduler.claimTurn(turn.id, now);
  const save = (id, action, merchant = name) =>
    f.store.saveDecision(
      {
        id,
        jobId: job,
        merchantId: merchant,
        provider: "near-ai",
        model: "fixture",
        promptVersion: "v1",
        action,
        reason: "controlled test choice",
      },
      now,
    );
  const publish = () =>
    f.store.commitDiscovery({
      previousHash: f.store.discoveryState().block.hash,
      state: c.state,
      signals: [],
    });
  return { ...f, c, job, turn, save, publish };
}
// Controlled journal facts for policy sequencing only. Receipt/crypto proof paths
// are independently covered by crash-safety.test.mjs, never replaced in production.
async function confirmedFixture(f, step) {
  await f.store.prepareIntent(step, now);
  f.store.db
    .prepare("UPDATE intents SET status='confirmed' WHERE id=?")
    .run(step.id);
  const actor = f.c.state.market.data.merchants.find(
    (row) => row.merchant_id === step.merchantId,
  );
  actor.last_action_id = step.args.action_id;
  f.store.db
    .prepare(
      "UPDATE merchants SET last_action_id=?,last_action_digest=? WHERE merchant_id=?",
    )
    .run(step.args.action_id, "a".repeat(64), step.merchantId);
  if (step.method === "set_listing") {
    const listing = actor.listings.find(
      (row) => row.resource === step.args.resource,
    );
    Object.assign(listing, step.args, {
      version: String(BigInt(listing.version) + 1n),
    });
    delete listing.action_id;
    delete listing.expected_version;
  }
  f.publish();
}
test("Rex preparation, proposal and Luna preparation/acceptance share reserved capacity without rewriting economic terms", async (t) => {
  const f = await modelRoot(t);
  f.save("rex-choice", buy(f.c));
  f.store.policy.authorize("rex-choice", now);
  const shrink = f.store.policy.next("rex-choice", now);
  await confirmedFixture(f, shrink);
  const proposal = f.store.policy.next("rex-choice", now);
  assert.equal(proposal.args.action_id, "2");
  await confirmedFixture(f, proposal);
  const offer = {
    ...structuredClone(captured.pending.offer.data.offer),
    quantity: "4",
    total_price: "24",
    unit_price: "6",
    expires_at_ns: buy(f.c).args.expires_at_ns,
    created_at_ns: f.c.state.block.timestampNs,
    proposal_action: { merchant_id: "rex", action_id: "2" },
  };
  f.c.state.offers = [offer];
  f.publish();
  f.store.db
    .prepare("UPDATE intents SET offer_id='1' WHERE id=?")
    .run(proposal.id);
  f.store.putOffer(
    {
      id: "1",
      jobId: f.job,
      status: "pending",
      expiresAtNs: offer.expires_at_ns,
      cleanupAck: false,
    },
    now,
  );
  f.store.scheduler.finishTurn(f.turn.id);
  const luna = f.store.scheduler
    .turns(f.job)
    .find((row) => row.merchant_id === "luna");
  f.store.recordMerchantCheckpoint("luna", "0", null, true);
  f.store.scheduler.claimTurn(luna.id, now);
  f.save(
    "luna-choice",
    { method: "accept_trade", args: { offer_id: "1", action_id: "1" } },
    "luna",
  );
  f.store.policy.authorize("luna-choice", now);
  const reduction = f.store.policy.next("luna-choice", now);
  assert.equal(reduction.args.quantity, "4");
  await confirmedFixture(f, reduction);
  const acceptance = f.store.policy.next("luna-choice", now);
  assert.equal(acceptance.args.action_id, "2");
  assert.deepEqual(Object.keys(acceptance.args).sort(), [
    "action_id",
    "offer_id",
  ]);
  f.store.policy.assertIntent(acceptance, f.c.state, now);
  const expiry = f.c.state.offers[0].expires_at_ns;
  f.c.state.offers[0].expires_at_ns = String(BigInt(expiry) + 1000000000n);
  assert.throws(
    () => f.store.policy.assertIntent(acceptance, f.c.state, now),
    /terms changed/,
  );
  f.c.state.offers[0].expires_at_ns = expiry;
  f.c.state.offers[0].quantity = "3";
  f.c.state.offers[0].total_price = "18";
  assert.throws(
    () => f.store.policy.assertIntent(acceptance, f.c.state, now),
    /terms changed/,
  );
  assert.equal(
    f.store.db.prepare("SELECT mutations FROM scheduler_roots").get().mutations,
    4,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT sum(slots_remaining) AS n FROM policy_plans")
      .get().n,
    0,
  );
});
test("local rejection persists offchain and cannot produce an intent or be reconsidered", async (t) => {
  const f = await modelRoot(t, "luna");
  incoming(f.c);
  f.publish();
  f.save("decline", { method: "reject_trade", offer_id: "1" });
  assert.equal(f.store.policy.authorize("decline", now).kind, "offchain");
  assert.equal(f.store.policy.next("decline", now), undefined);
  f.save("again", {
    method: "accept_trade",
    args: { offer_id: "1", action_id: "1" },
  });
  assert.throws(() => f.store.policy.authorize("again", now), /unavailable/);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM intents").get().n,
    0,
  );
});
test("unapproved, mismatched and stale policy choices stop before any credential is loaded", async (t) => {
  const f = await modelRoot(t);
  f.save("choice", buy(f.c));
  const raw = {
    id: "unapproved",
    jobId: f.job,
    decisionId: "choice",
    merchantId: "rex",
    method: "propose_trade",
    args: buy(f.c).args,
  };
  await assert.rejects(f.store.prepareIntent(raw, now), /reservation|approval/);
  assert.equal(f.chain.loads.length, 0);
  f.store.policy.authorize("choice", now);
  const step = f.store.policy.next("choice", now);
  f.c.state.market.data.merchants[0].gold = "80";
  assert.throws(
    () => f.store.policy.assertIntent(step, f.c.state, now),
    /gold_reserve/,
  );
  assert.equal(f.chain.loads.length, 0);
});
test("financial warning threshold, monthly continuity and overspend billing all fail safely", async (t) => {
  const f = await setup(t);
  grant(f.store, {
    projectId: "test",
    laneId: "public",
    portions: [{ laneId: "public", dailyMicro: 5000, monthlyMicro: 5000 }],
  });
  for (let i = 0; i < 4; i++)
    f.store.budget.reserve(`call:${i}`, prepared(), now);
  assert.equal(f.store.budget.status(now).warning, true);
  assert.throws(
    () =>
      f.store.budget.account(
        "call:0",
        "near-ai",
        "fixture-model",
        1200,
        "unit:overrun",
      ),
    /exceeded/,
  );
  assert.equal(f.store.budget.status(now).blocked, true);
  assert.equal(f.store.budget.history().entries[0].charged_micro, 1200);
  const g = await setup(t);
  grant(g.store, {
    projectId: "test",
    laneId: "public",
    portions: [{ laneId: "public", dailyMicro: 1000, monthlyMicro: 2000 }],
  });
  g.store.budget.reserve("day1", prepared(), now);
  g.store.budget.reserve("day2", prepared(), now + day + 1);
  assert.throws(
    () => g.store.budget.reserve("day3", prepared(), now + 2 * day + 2),
    /spend/,
  );
});
test("request count ceilings survive a handoff even when reliable billing reports zero spend", async (t) => {
  const f = await setup(t);
  grant(f.store);
  const config = f.store.budget.history().config;
  await f.reopen();
  const entries = Array.from({ length: 600 }, (_, i) => ({
    request_id: `past:${i}`,
    deployment: "old deployment",
    provider: "near-ai",
    model: "fixture-model",
    started_at: now - 2 * 3600000,
    reserved_micro: 1000,
    charged_micro: 0,
    input_bound: 100,
    status: "accounted",
    evidence_ref: "unit:usage",
  }));
  f.store.budget.adopt({ config, entries }, now);
  f.store.budget.reconcile(
    {
      ...f.store.budget.context(),
      fencing: "verified",
      history: "accounted",
      evidenceRef: "unit:fence",
    },
    now,
  );
  assert.throws(
    () => f.store.budget.reserve("new", prepared(), now),
    /request cap/,
  );
});
test("inference billing commit failure prevents dispatch and preserves the previous ledger", async (t) => {
  const f = await setup(t),
    accounting = inferenceFixture(f.store),
    runner = new ProviderRunner(f.store, undefined, accounting);
  let calls = 0;
  const original = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    if (sql.startsWith("INSERT INTO inference_usage"))
      throw new Error("private-token-canary");
    return original(sql);
  };
  await assert.rejects(
    runner.run(
      {
        id: "fee-fail",
        turnId: "missing",
        provider: "near-ai",
        model: "fixture-model",
        promptVersion: "v1",
      },
      async () => {
        calls++;
        return { action: { method: "hold" }, reason: "wait" };
      },
    ),
    (error) => !error.message.includes("private-token-canary"),
  );
  assert.equal(calls, 0);
  assert.equal(f.store.budget.history().entries.length, 0);
});

test("a gold reserve change during credential loading prevents a real signature and every broadcast", async (t) => {
  let processor;
  const f = await modelRoot(t, "rex", async (f, c) => {
    f.chain.state.market = structuredClone(c.state.market);
    f.chain.state.finalized_block.timestamp_ns = c.state.block.timestampNs;
    processor = new CrashSafeProcessor(
      f.store,
      f.chain.client,
      f.chain.adapter,
      async (context) => ({
        ...context,
        journal: "current",
        fencing: "verified",
        providerHistory: "accounted",
        evidenceRef: "unit:continuity",
        baselines: {
          rex: { actionId: "0", digest: null },
          luna: { actionId: "0", digest: null },
          bolt: { actionId: "0", digest: null },
        },
      }),
    );
    assert.equal((await processor.recover()).kind, "ready");
  });
  f.save("choice", buy(f.c));
  f.store.policy.authorize("choice", now);
  const step = f.store.policy.next("choice", now);
  const prepare = f.chain.adapter.prepare.bind(f.chain.adapter);
  f.chain.adapter.prepare = (...args) =>
    prepare(args[0], args[1], args[2], async (key) => {
      f.chain.state.market.data.merchants[0].gold = "80";
      await args[3](key);
    });
  await assert.rejects(processor.execute(step));
  assert.equal(f.store.attempt(step.id), undefined);
  assert.equal(f.chain.loads.length, 1);
  assert.equal(
    f.chain.calls.some((row) => row.method === "send_tx"),
    false,
  );
});

test("short decision retention cannot erase unresolved policy plans or commitments", async (t) => {
  const f = await modelRoot(t);
  f.save("choice", buy(f.c));
  f.store.policy.authorize("choice", now);
  f.store.prune(now + 31 * day);
  assert.equal(f.store.policy.commitments().length, 1);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM policy_steps").get().n,
    2,
  );
  assert.equal(f.store.getDecision("choice").id, "choice");
});
test("unknown billing is protected for the full 30-day window and ages out only on verified admission", async (t) => {
  const f = await setup(t);
  grant(f.store);
  f.store.budget.reserve("protected", prepared(), now);
  f.store.prune(now + 7 * day);
  assert.equal(f.store.budget.history().entries.length, 1);
  f.store.budget.reserve("day29", prepared(), now + 29 * day);
  assert.equal(
    f.store.budget
      .history()
      .entries.some((row) => row.request_id === "protected"),
    true,
  );
  f.store.budget.reserve("day30", prepared(), now + 30 * day);
  assert.equal(
    f.store.budget
      .history()
      .entries.some((row) => row.request_id === "protected"),
    false,
  );
});
