import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AssistantStore } from "../dist/private/assistant/store.js";
import {
  AssistantPipeline,
  assistantPrompt,
} from "../dist/private/assistant/pipeline.js";
import {
  assistantSchema,
  parseAssistantCandidates,
  rulesCandidates,
} from "../dist/private/assistant/proposals.js";
import { SafetyClock } from "../dist/private/retries/clock.js";
import { BudgetRepository } from "../dist/private/policy/budget.js";
import { configureJournal } from "../dist/private/storage/journal.js";
import { policySchema } from "../dist/private/storage/schema.js";
import {
  assistantReviewReference,
  verifyAssistantReview,
  createLivingTownCall,
} from "../../../packages/chain/dist/index.js";
const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
const result = (i) =>
  JSON.parse(
    Buffer.from(capture.steps[i].receipt.status.SuccessValue, "base64"),
  );
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "bazaar-assistant-")),
    dir = join(root, "private");
  mkdirSync(dir);
  let store = new AssistantStore(dir, "controlled-deployment", true),
    time = Date.now(),
    closed = false;
  const outcome = result(3).data.outcome,
    shop = structuredClone(result(1).data.outcome.shop),
    ledger = structuredClone(outcome.buyer);
  shop.owner = { kind: "player", account_id: "alice.testnet" };
  ledger.actor = structuredClone(shop.owner);
  ledger.inventory.held.health_potion = "1";
  ledger.inventory.listing_reserved.health_potion = "1";
  const f = {
    snapshot: {
      deployment: result(3).deployment,
      block_hash: capture.steps[3].block.header.hash,
      block_height: "33",
      block_timestamp_ns: String(BigInt(time) * 1000000n),
      market_revision: "5",
      event_sequence: "5",
    },
    shop,
    ledger,
    listings: [
      structuredClone(outcome.listing),
      {
        listing_id: "5",
        shop_id: shop.shop_id,
        owner: structuredClone(shop.owner),
        item_id: "health_potion",
        remaining_quantity: "1",
        unit_price: "10",
        revision: "1",
        active: true,
      },
    ],
    fresh: true,
    historyComplete: true,
    restockSpending: { tick: "0", day: "0" },
    paused: false,
    productionCost: { health_potion: "6", iron_tool: null },
    demand: { health_potion: "2", iron_tool: "0" },
  };
  const db = new DatabaseSync(join(root, "shared-budget.sqlite"));
  configureJournal(db, true);
  db.exec(
    policySchema.slice(0, policySchema.indexOf("CREATE TABLE policy_plans")),
  );
  const budget = new BudgetRepository(
    db,
    (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const v = fn();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    () => "existing-owner",
    "project-authority",
  );
  budget.configure(
    {
      projectId: "bot-bazaar",
      laneId: "shared",
      portions: [
        { laneId: "shared", dailyMicro: 500000, monthlyMicro: 5000000 },
      ],
    },
    time,
  );
  if (!options.unverified)
    budget.reconcile(
      {
        ...budget.context(),
        fencing: "verified",
        history: "accounted",
        evidenceRef: "fixture",
      },
      time,
    );
  const binding = {
    repository: budget,
    projectId: "bot-bazaar",
    laneId: "shared",
    ledgerId: budget.context().ledgerId,
  };
  let calls = 0,
    loads = 0;
  const clock = () =>
    new SafetyClock(
      () => budget.invalidate("fixture:clock"),
      () => time,
      () => time,
    );
  const prepared = () => ({
    provider: "fixture",
    model: "fixture-model",
    payload: assistantPrompt(f),
    maxOutputTokens: 512,
    countTokens: () => 100,
    accountingEvidence: "fixture:tokens",
    pricingEvidence: "fixture:price",
    worstInputMicroPerMillion: 100000,
    outputMicroPerMillion: 100000,
    verifiedUntil: time + 60000,
  });
  const provider = {
    provider: "fixture",
    model: "fixture-model",
    promptVersion: "assistant-v1",
    prepare: prepared,
    invoke: async (c) => {
      calls++;
      if (options.invoke) return options.invoke(c, f);
      c.reportIdentity({ provider: "fixture", model: "fixture-model" });
      return {
        schema: assistantSchema,
        proposals: rulesCandidates(f).map((p) => ({
          ...p,
          reason: "Controlled model suggestion.",
        })),
      };
    },
  };
  const source = {
    load: async () => {
      loads++;
      if (options.load) return options.load(f, loads);
      return structuredClone(f);
    },
  };
  let runner = new AssistantPipeline(
    store,
    source,
    options.rules ? null : binding,
    options.rules ? null : provider,
    options.timeout ?? 5000,
    clock(),
  );
  t.after(() => {
    if (!closed) store.close();
    db.close();
    assert.ok(root.startsWith(join(tmpdir(), "bazaar-assistant-")));
    rmSync(root, { recursive: true, force: true });
  });
  const enable = () =>
    runner.configure("alice.testnet", shop.shop_id, "recommendations");
  const generate = () =>
    runner.generate("alice.testnet", shop.shop_id, async () => true);
  return {
    f,
    dir,
    budget,
    binding,
    provider,
    prepared,
    enable,
    generate,
    get runner() {
      return runner;
    },
    get store() {
      return store;
    },
    get calls() {
      return calls;
    },
    advance(ms) {
      time += ms;
      f.snapshot.block_timestamp_ns = String(BigInt(time) * 1000000n);
      f.snapshot.block_height = String(BigInt(f.snapshot.block_height) + 1n);
    },
    restart() {
      store.close();
      store = new AssistantStore(dir, "controlled-deployment");
      runner = new AssistantPipeline(
        store,
        source,
        options.rules ? null : binding,
        options.rules ? null : provider,
        5000,
        clock(),
      );
    },
    close() {
      store.close();
      closed = true;
    },
  };
}
test("explicit activation; validated model proposes both actions, reserves existing budget and caches exact snapshot", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.generate());
  f.enable();
  const initial = structuredClone(f.f),
    first = await f.generate();
  assert.equal(first.history[0].status, "proposed");
  assert.equal(first.history[0].model_status, "proposed");
  assert.deepEqual(
    first.history[0].proposals.map((p) => p.action.type),
    ["suggest_price", "suggest_restock"],
  );
  for (const p of first.history[0].proposals) {
    assert.equal(p.source, "model");
    assert.match(p.proposal_id, /^[a-f0-9]{64}$/);
    assert.equal(p.expected_policy_revision, f.f.shop.policy_revision);
  }
  assert.equal(f.calls, 1);
  assert.equal(f.budget.history().entries.length, 1);
  assert.equal(f.budget.history().entries[0].status, "reserved");
  assert.equal(f.budget.status().dailyMicro, 1000);
  await f.generate();
  assert.equal(f.calls, 1);
  assert.deepEqual(f.f, initial);
});
test("reading and polling history never invokes inference; provider-disabled fallback is truthfully labelled", async (t) => {
  const f = fixture(t, { rules: true });
  f.enable();
  for (let i = 0; i < 3; i++)
    await f.runner.read("alice.testnet", f.f.shop.shop_id);
  assert.equal(f.calls, 0);
  assert.equal(f.store.history("alice.testnet", f.f.shop.shop_id).length, 0);
  const r = await f.generate();
  assert.equal(r.history[0].code, "provider_not_configured");
  assert.ok(r.history[0].proposals.every((p) => p.source === "rules_fallback"));
  assert.equal(f.budget.history().entries.length, 0);
});
test("strict schemas reject arbitrary execution, extra authority, bad reasons, totals and duplicated actions", () => {
  const action = {
    type: "suggest_restock",
    item_id: "wood",
    listing_id: "1",
    expected_listing_revision: "1",
    seller_shop_id: "1",
    quantity: "2",
    unit_price: "3",
    total_price: "6",
  };
  const body = {
    schema: assistantSchema,
    proposals: [{ action, reason: "Review supplies." }],
  };
  for (const mutate of [
    (b) => (b.operator = "owner"),
    (b) => (b.proposals[0].action.type = "buy"),
    (b) => (b.proposals[0].action.quantity = 2),
    (b) => (b.proposals[0].action.total_price = "7"),
    (b) => (b.proposals[0].reason = "<script>bad</script>"),
    (b) => b.proposals.push(b.proposals[0]),
  ]) {
    const b = structuredClone(body);
    mutate(b);
    assert.throws(() => parseAssistantCandidates(b));
  }
});

test("provider prompt contains a valid numeric JSON Schema without relaxing economic string encoding", (t) => {
  const f = fixture(t);
  const prompt = JSON.parse(assistantPrompt(f.f));
  assert.equal(prompt.response_schema.properties.proposals.maxItems, 2);
  assert.equal(prompt.policy.price_max, "100");
  assert.equal(
    prompt.response_schema.properties.proposals.items.properties.action.oneOf
      .length,
    2,
  );
});
test("pause aborts an in-flight provider and ignores its late successful response without refunding reserved usage", async (t) => {
  let release, notify, signal;
  const ready = new Promise((resolve) => {
    notify = resolve;
  });
  const f = fixture(t, {
    invoke: async (c, facts) => {
      signal = c.signal;
      c.reportIdentity({ provider: "fixture", model: "fixture-model" });
      notify();
      return new Promise((resolve) => {
        release = () =>
          resolve({
            schema: assistantSchema,
            proposals: rulesCandidates(facts),
          });
      });
    },
  });
  f.enable();
  const pending = f.generate();
  await ready;
  const charged = f.budget.status().dailyMicro;
  assert(charged > 0);
  await f.runner.pause("alice.testnet", "4");
  assert.equal(signal.aborted, true);
  const outcome = await pending;
  assert.equal(outcome.configuration.paused, true);
  assert(outcome.history.every((r) => r.status !== "proposed"));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.budget.status().dailyMicro, charged);
  assert.equal(f.budget.history().entries[0].status, "reserved");
  assert(
    f.store.history("alice.testnet", "4").every((r) => r.status !== "proposed"),
  );
  assert.equal(f.calls, 1);
  assert.equal(f.runner.dispatchAllowed("4"), false);
  f.restart();
  assert.equal(f.runner.dispatchAllowed("4"), false);
  await assert.rejects(f.generate());
});
for (const kind of ["schema", "policy", "identity", "unavailable"])
  test(`model ${kind} rejection persists audit and bounded rules fallback`, async (t) => {
    const f = fixture(t, {
      invoke: async (c, facts) => {
        if (kind === "unavailable") throw Error("sensitive provider failure");
        c.reportIdentity({
          provider: "fixture",
          model: kind === "identity" ? "wrong" : "fixture-model",
        });
        if (kind === "schema")
          return { action: { type: "buy" }, reason: "bad" };
        const p = rulesCandidates(facts);
        p[0].action.listing_id = "999";
        return { schema: assistantSchema, proposals: p };
      },
    });
    f.enable();
    const r = await f.generate();
    assert.equal(r.history[0].model_status, "rejected");
    assert.ok(
      r.history[0].proposals.every((p) => p.source === "rules_fallback"),
    );
    assert.equal(f.calls, 1);
    assert.equal(
      JSON.stringify(r).includes("sensitive provider failure"),
      false,
    );
    await f.generate();
    assert.equal(f.calls, 1);
  });
test("single-flight overlapping generation cannot duplicate a provider call", async (t) => {
  let resume;
  const wait = new Promise((r) => {
    resume = r;
  });
  const f = fixture(t, {
    invoke: async (c, facts) => {
      await wait;
      c.reportIdentity({ provider: "fixture", model: "fixture-model" });
      return { schema: assistantSchema, proposals: rulesCandidates(facts) };
    },
  });
  f.enable();
  const a = f.generate(),
    b = f.generate();
  resume();
  await Promise.all([a, b]);
  assert.equal(f.calls, 1);
});
test("persisted cooldown and hourly caps survive snapshot/config changes and restart", async (t) => {
  const f = fixture(t, { rules: true });
  f.enable();
  await f.generate();
  f.advance(1000);
  await f.generate();
  assert.equal(f.store.history("alice.testnet", f.f.shop.shop_id).length, 1);
  for (let i = 0; i < 5; i++) {
    f.advance(61000);
    await f.generate();
  }
  assert.equal(f.store.history("alice.testnet", f.f.shop.shop_id).length, 4);
  f.restart();
  f.runner.configure("alice.testnet", f.f.shop.shop_id, "off");
  f.enable();
  f.advance(61000);
  const r = await f.generate();
  assert.ok(r.history.every((h) => h.revision !== r.configuration.revision));
  assert.equal(f.calls, 0);
});
test("unverified or exhausted shared budget admits no model and creates no new allowance", async (t) => {
  const f = fixture(t, { unverified: true });
  f.enable();
  await f.generate();
  assert.equal(f.calls, 0);
  assert.equal(f.budget.history().entries.length, 0);
});
test("shared project V1/rehearsal spend blocks assistant without refund or separate allocation", async (t) => {
  const f = fixture(t);
  f.budget.reserve(
    "existing-v1-rehearsal",
    {
      ...f.prepared(),
      countTokens: () => 1000,
      worstInputMicroPerMillion: 500000000,
      outputMicroPerMillion: 0,
    },
    Date.now(),
  );
  f.enable();
  const r = await f.generate();
  assert.equal(f.calls, 0);
  assert.equal(r.history[0].model_status, "rejected");
  assert.equal(f.budget.history().entries.length, 1);
});
test("stale/incomplete/paused facts produce wait, not invented costs or inference", async (t) => {
  const f = fixture(t);
  f.enable();
  f.f.historyComplete = false;
  const r = await f.generate();
  assert.equal(f.calls, 0);
  assert.equal(r.history[0].status, "wait");
  assert.deepEqual(r.history[0].proposals, []);
});
test("provider timeout retains charged reservation; late output is ignored and restart never repeats it", async (t) => {
  let release;
  const f = fixture(t, {
    timeout: 5,
    invoke: async (c, facts) => {
      await new Promise((r) => {
        release = r;
      });
      c.reportIdentity({ provider: "fixture", model: "fixture-model" });
      return { schema: assistantSchema, proposals: rulesCandidates(facts) };
    },
  });
  f.enable();
  const r = await f.generate();
  assert.equal(r.history[0].code, "provider_timeout");
  release();
  await new Promise((r) => setImmediate(r));
  f.restart();
  await f.generate();
  assert.equal(f.calls, 1);
  assert.equal(f.budget.history().entries[0].status, "reserved");
});
test("state changes during inference expire output; configuration off cannot be re-enabled by response", async (t) => {
  let release;
  const wait = new Promise((r) => {
    release = r;
  });
  const f = fixture(t, {
    invoke: async (c, facts) => {
      await wait;
      c.reportIdentity({ provider: "fixture", model: "fixture-model" });
      return { schema: assistantSchema, proposals: rulesCandidates(facts) };
    },
  });
  f.enable();
  const run = f.generate();
  await new Promise((r) => setImmediate(r));
  f.runner.configure("alice.testnet", f.f.shop.shop_id, "off");
  release();
  const r = await run;
  assert.equal(r.configuration.mode, "off");
  assert.equal(r.history[0].status, "expired");
});
test("price has no fabricated cost basis; restock respects funds and no unsafe stock suggestion appears", async (t) => {
  const f = fixture(t, { rules: true });
  f.enable();
  f.f.productionCost.health_potion = null;
  f.f.ledger.gold.available = "20";
  f.f.ledger.gold.held = "20";
  const r = await f.generate();
  assert.equal(r.history[0].status, "wait");
  assert.equal(r.history[0].proposals.length, 0);
});
test("read expires old suggestions against fresh chain time and hides cross-owner history", async (t) => {
  const f = fixture(t, { rules: true });
  f.enable();
  await f.generate();
  f.advance(121000);
  const r = await f.runner.read("alice.testnet", f.f.shop.shop_id);
  assert.equal(r.history[0].status, "expired");
  await assert.rejects(f.runner.read("bob.testnet", f.f.shop.shop_id));
});
test("private journal refuses another writer and deployment replacement", (t) => {
  const f = fixture(t);
  assert.throws(() => new AssistantStore(f.dir, "controlled-deployment"));
  f.close();
  assert.throws(() => new AssistantStore(f.dir, "different-deployment"));
});

test("provider cannot hide a mismatched identity by catching callback errors", async (t) => {
  const f = fixture(t, {
    invoke: async (c, facts) => {
      try {
        c.reportIdentity({ provider: "wrong", model: "wrong" });
      } catch {
        /* hostile provider swallows rejection */
      }
      c.reportIdentity({ provider: "fixture", model: "fixture-model" });
      return { schema: assistantSchema, proposals: rulesCandidates(facts) };
    },
  });
  f.enable();
  const r = await f.generate();
  assert.equal(r.history[0].model_status, "rejected");
  assert.equal(r.history[0].code, "model_identity_mismatch");
  assert.equal(f.budget.status().blocked, true);
});

test("interrupted durable generation stays expired after reopen and cannot be retried as a new inference", async (t) => {
  const f = fixture(t);
  f.enable();
  f.store.begin({
    id: "b".repeat(64),
    account: "alice.testnet",
    shop: f.f.shop.shop_id,
    context: "test",
    revision: "2",
    status: "pending",
    code: "admitted",
    proposals: [],
    started: Date.now(),
    updated: Date.now(),
  });
  f.restart();
  const r = f.store.get("b".repeat(64));
  assert.equal(r.status, "expired");
  assert.equal(r.code, "restart_unknown");
});

test("daily recommendation cap cannot be reset by mode changes", async (t) => {
  const f = fixture(t, { rules: true });
  f.enable();
  for (let i = 0; i < 20; i++) {
    await f.generate();
    f.advance(3600001);
  }
  const before = f.store.history("alice.testnet", f.f.shop.shop_id)[0].id;
  f.runner.configure("alice.testnet", f.f.shop.shop_id, "off");
  f.enable();
  await f.generate();
  assert.equal(
    f.store.history("alice.testnet", f.f.shop.shop_id)[0].id,
    before,
  );
});

test("logout during fact collection prevents shared-budget reservation and model dispatch", async (t) => {
  let resume,
    allowed = true;
  const wait = new Promise((r) => {
    resume = r;
  });
  const f = fixture(t, {
    load: async (facts) => {
      await wait;
      return structuredClone(facts);
    },
  });
  f.enable();
  const pending = f.runner.generate(
    "alice.testnet",
    f.f.shop.shop_id,
    async () => {
      if (!allowed) throw Error("revoked");
    },
  );
  await new Promise((r) => setImmediate(r));
  allowed = false;
  resume();
  const result = await pending;
  assert.equal(f.calls, 0);
  assert.equal(f.budget.history().entries.length, 0);
  assert.equal(result.history[0].status, "rejected");
});

const ownerCall = (review) =>
  createLivingTownCall(review.call.method, {
    ...review.call.args,
    command: {
      sequence: "1",
      config_version: review.proposal.snapshot.deployment.config_version,
      valid_until_ns: review.proposal.expires_at_ns,
    },
  });
for (const kind of ["suggest_price", "suggest_restock"])
  test(`manual ${kind}: exact review, one accepted attempt, unchanged economic state`, async (t) => {
    const f = fixture(t, { rules: true });
    f.enable();
    const response = await f.generate(),
      p = response.history[0].proposals.find((p) => p.action.type === kind);
    const before = structuredClone(f.f),
      review = await verifyAssistantReview(
        await f.runner.review("alice.testnet", f.f.shop.shop_id, p.proposal_id),
      );
    if (kind === "suggest_price") {
      assert.equal(review.call.method, "set_listing");
      assert.equal(review.call.args.quantity, "1");
      assert.equal(review.call.args.unit_price, p.action.suggested_unit_price);
    } else {
      assert.equal(review.call.method, "buy_from_merchant");
      assert.equal(review.call.args.max_total_price, p.action.total_price);
    }
    const id = "11111111-1111-4111-8111-111111111111",
      call = ownerCall(review),
      link = assistantReviewReference(review);
    assert.equal(
      (await f.runner.accept("alice.testnet", f.f.shop.shop_id, link, id, call))
        .accepted,
      true,
    );
    assert.equal(
      (await f.runner.accept("alice.testnet", f.f.shop.shop_id, link, id, call))
        .accepted,
      true,
    );
    await assert.rejects(
      f.runner.accept(
        "alice.testnet",
        f.f.shop.shop_id,
        link,
        "22222222-2222-4222-8222-222222222222",
        call,
      ),
    );
    const changed = createLivingTownCall(call.method, {
      ...call.args,
      command: { ...call.args.command, sequence: "2" },
    });
    await assert.rejects(
      f.runner.accept("alice.testnet", f.f.shop.shop_id, link, id, changed),
    );
    assert.deepEqual(f.f, before);
    assert.equal(f.calls, 0);
    assert.equal(
      f.store
        .history("alice.testnet", f.f.shop.shop_id)[0]
        .decisions.find((d) => d.proposal_id === p.proposal_id).status,
      "accepted",
    );
  });
test("dismissal/ignoring do not execute, spend or admit inference and dismissed advice cannot be accepted", async (t) => {
  const f = fixture(t, { rules: true });
  f.enable();
  const response = await f.generate(),
    p = response.history[0].proposals[0],
    before = structuredClone(f.f);
  const dismissed = f.runner.dismiss(
    "alice.testnet",
    f.f.shop.shop_id,
    p.proposal_id,
  );
  assert.equal(dismissed.history[0].decisions[0].status, "dismissed");
  await assert.rejects(
    f.runner.review("alice.testnet", f.f.shop.shop_id, p.proposal_id),
  );
  assert.deepEqual(f.f, before);
  assert.equal(f.calls, 0);
  assert.equal(f.budget.history().entries.length, 0);
});
for (const change of [
  "owner",
  "market",
  "listing",
  "shop",
  "ledger",
  "policy",
  "expired",
  "stock",
  "price",
  "config",
])
  test(`manual acceptance rejects changed ${change}`, async (t) => {
    const f = fixture(t, { rules: true });
    f.enable();
    const response = await f.generate(),
      p = response.history[0].proposals[0];
    const review = await f.runner.review(
      "alice.testnet",
      f.f.shop.shop_id,
      p.proposal_id,
    );
    if (change === "owner") f.f.shop.owner.account_id = "bob.testnet";
    if (change === "market") f.f.snapshot.market_revision = "6";
    if (change === "listing")
      f.f.listings.find((l) => l.listing_id === p.action.listing_id).revision =
        "2";
    if (change === "shop")
      f.f.shop.revision = String(BigInt(f.f.shop.revision) + 1n);
    if (change === "ledger")
      f.f.ledger.revision = String(BigInt(f.f.ledger.revision) + 1n);
    if (change === "policy") f.f.shop.policy_revision = "2";
    if (change === "expired") f.advance(121000);
    if (change === "stock")
      f.f.listings.find(
        (l) => l.listing_id === p.action.listing_id,
      ).remaining_quantity = "2";
    if (change === "price")
      f.f.listings.find(
        (l) => l.listing_id === p.action.listing_id,
      ).unit_price = "12";
    if (change === "config")
      f.runner.configure("alice.testnet", f.f.shop.shop_id, "off");
    await assert.rejects(
      f.runner.accept(
        "alice.testnet",
        f.f.shop.shop_id,
        assistantReviewReference(review),
        "11111111-1111-4111-8111-111111111111",
        ownerCall(review),
      ),
    );
  });
test("manual call tampering, cross-shop/account access and price-only quantity changes fail", async (t) => {
  const f = fixture(t, { rules: true });
  f.enable();
  const r = await f.generate(),
    p = r.history[0].proposals[0],
    review = await f.runner.review(
      "alice.testnet",
      f.f.shop.shop_id,
      p.proposal_id,
    );
  await assert.rejects(
    f.runner.review("bob.testnet", f.f.shop.shop_id, p.proposal_id),
  );
  await assert.rejects(f.runner.review("alice.testnet", "999", p.proposal_id));
  const bad = createLivingTownCall("set_listing", {
    ...review.call.args,
    quantity: "2",
    command: ownerCall(review).args.command,
  });
  await assert.rejects(
    f.runner.accept(
      "alice.testnet",
      f.f.shop.shop_id,
      assistantReviewReference(review),
      "11111111-1111-4111-8111-111111111111",
      bad,
    ),
  );
  assert.equal(f.calls, 0);
});
