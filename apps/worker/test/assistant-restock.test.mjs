import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  assistantRestockLimits,
  defaultAssistantRestockLimits,
  createLivingTownCall,
} from "@bot-bazaar/chain";
import { AssistantStore } from "../dist/private/assistant/store.js";
import { AssistantPipeline } from "../dist/private/assistant/pipeline.js";
import {
  rulesCandidates,
  validateCandidate,
  restockAllowance,
} from "../dist/private/assistant/proposals.js";
import { confirmedRestockSpending } from "../dist/private/assistant/facts.js";
import { createAssistantServer } from "../dist/private/assistant/server.js";
import { AssistantAuthError } from "../dist/private/assistant/auth.js";
import { townCall } from "../dist/private/living-town/town-chain.js";
const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
const result = (i) =>
  JSON.parse(
    Buffer.from(capture.steps[i].receipt.status.SuccessValue, "base64"),
  );
function facts() {
  const r = result(3),
    ledger = structuredClone(r.data.outcome.buyer),
    shop = structuredClone(result(1).data.outcome.shop);
  ledger.gold.held = ledger.gold.available = "100";
  ledger.inventory.held.crystal = ledger.inventory.available.crystal = "0";
  return {
    snapshot: {
      deployment: r.deployment,
      market_revision: r.market_revision,
      event_sequence: r.event_sequence,
      block_height: r.block_height,
      block_timestamp_ns: r.block_timestamp_ns,
      block_hash: capture.steps[3].block.header.hash,
    },
    shop,
    ledger,
    listings: [structuredClone(r.data.outcome.listing)],
    fresh: true,
    historyComplete: true,
    paused: false,
    productionCost: { health_potion: null, iron_tool: null },
    demand: { health_potion: "0", iron_tool: "0" },
    restockLimits: defaultAssistantRestockLimits(),
    restockSpending: { tick: "0", day: "0" },
  };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-restock-")),
    f = facts(),
    owner = f.shop.owner.account_id;
  let store = new AssistantStore(dir, "p57-controlled", true);
  const pipeline = new AssistantPipeline(store, {
    load: async () => structuredClone(f),
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  pipeline.configure(owner, "4", "recommendations");
  return {
    f,
    owner,
    pipeline,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new AssistantStore(dir, "p57-controlled");
      return store;
    },
  };
}
for (const patch of [
  { recommendation_budget: "10001" },
  { recommendation_budget: "-1" },
  { min_cash_reserve: "1000001" },
  { per_tick_limit: "1.5" },
  { per_day_limit: 10 },
  { allowed_items: ["health_potion"] },
  { allowed_items: ["herb", "herb"] },
  { automatic: true },
  { recipient: "attacker.testnet" },
])
  test(`strict advisory settings reject ${JSON.stringify(patch)}`, () =>
    assert.throws(() =>
      assistantRestockLimits({ ...defaultAssistantRestockLimits(), ...patch }),
    ));
test("advisory rules honor recommendation, tick/day headroom and minimum reserve", () => {
  const f = facts();
  assert.equal(rulesCandidates(f)[0].action.quantity, "4");
  f.restockLimits.recommendation_budget = "8";
  assert.equal(rulesCandidates(f)[0].action.quantity, "2");
  f.restockLimits.recommendation_budget = "100";
  f.restockLimits.per_tick_limit = "10";
  f.restockSpending.tick = "6";
  assert.equal(rulesCandidates(f)[0].action.quantity, "1");
  f.restockLimits.per_day_limit = "8";
  f.restockSpending.day = "5";
  assert.deepEqual(rulesCandidates(f), []);
  f.restockSpending = { tick: "0", day: "0" };
  f.restockLimits = defaultAssistantRestockLimits();
  f.ledger.gold.available = "36";
  assert.equal(rulesCandidates(f)[0].action.quantity, "4");
  f.ledger.gold.available = "35";
  assert.equal(rulesCandidates(f)[0].action.quantity, "3");
});
test("model suggestions outside guidance reject without being clipped into a different purchase", () => {
  const f = facts(),
    candidate = rulesCandidates(f)[0];
  f.restockLimits.allowed_items = ["herb"];
  assert.throws(() => validateCandidate(candidate, f));
  f.restockLimits = defaultAssistantRestockLimits();
  f.restockLimits.per_day_limit = "16";
  f.restockSpending.day = "1";
  assert.throws(() => validateCandidate(candidate, f));
  assert.equal(candidate.action.quantity, "4");
});
test("zero budgets, exhausted day/tick or unknown spending stop restock guidance", () => {
  for (const field of [
    "recommendation_budget",
    "per_tick_limit",
    "per_day_limit",
  ]) {
    const f = facts();
    f.restockLimits[field] = "0";
    assert.deepEqual(rulesCandidates(f), []);
  }
  const f = facts();
  f.restockLimits.allowed_items = [];
  assert.deepEqual(rulesCandidates(f), []);
  f.restockLimits = defaultAssistantRestockLimits();
  delete f.restockSpending;
  assert.equal(restockAllowance(f), 0n);
  assert.deepEqual(rulesCandidates(f), []);
  delete f.restockLimits;
  assert.equal(restockAllowance(f), 0n);
});
test("confirmed spending uses town tick and UTC-day boundaries; ignores income and future entries", () => {
  const second = 1_000_000_000n,
    day = 86400n * second,
    genesis = 10n * second,
    now = day + 70n * second;
  const entry = (time, amount, kind = "material_purchase") => ({
    block_timestamp_ns: String(time),
    gold_amount: String(amount),
    kind,
  });
  const history = [
    entry(day - 1n, 50),
    entry(day, 7),
    entry(now - 1n, 3),
    entry(now, 5),
    entry(now + 1n, 100),
    entry(now, 100, "customer_sale"),
  ];
  assert.deepEqual(
    confirmedRestockSpending(history, String(now), String(genesis)),
    { tick: "5", day: "15" },
  );
  assert.deepEqual(
    confirmedRestockSpending(history, String(now - 1n), String(genesis)),
    { tick: "3", day: "10" },
  );
  assert.throws(() => confirmedRestockSpending([], "0", "1"));
});
test("settings persist, bind owner/revision and expire earlier advice without affecting economy", async (t) => {
  const h = fixture(t),
    before = structuredClone(h.f.ledger);
  await h.pipeline.generate(h.owner, "4", async () => true);
  const record = h.store
      .history(h.owner, "4")
      .find((r) => r.status === "proposed"),
    proposal = record.proposals[0];
  const old = h.store.settings(h.owner, "4"),
    limits = {
      ...old.restock,
      recommendation_budget: "4",
      allowed_items: ["crystal"],
    };
  const updated = h.pipeline.configureRestock(
    h.owner,
    "4",
    old.revision,
    limits,
  );
  assert.equal(updated.revision, "3");
  assert.equal(h.store.history(h.owner, "4")[0].status, "expired");
  await assert.rejects(h.pipeline.review(h.owner, "4", proposal.proposal_id));
  assert.throws(() =>
    h.pipeline.configureRestock(h.owner, "4", old.revision, limits),
  );
  assert.throws(() =>
    h.pipeline.configureRestock(
      "attacker.testnet",
      "4",
      updated.revision,
      limits,
    ),
  );
  assert.deepEqual(h.f.ledger, before);
  assert.deepEqual(h.reopen().settings(h.owner, "4"), updated);
});
test("advisory limits never create automatic buying authority or block ordinary owner call construction", () => {
  const f = facts(),
    l = f.listings[0],
    args = {
      merchant_id: "rex",
      item_id: "crystal",
      quantity: "1",
      expected_listing_revision: l.revision,
      max_total_price: l.unit_price,
      command: {
        sequence: "1",
        config_version: "1",
        valid_until_ns: f.snapshot.block_timestamp_ns,
      },
    };
  f.restockLimits.recommendation_budget = "0";
  assert.deepEqual(rulesCandidates(f), []);
  assert.equal(
    createLivingTownCall("buy_from_merchant", args).method,
    "buy_from_merchant",
  );
  assert.throws(() => townCall("buy_from_merchant", args, "operator"));
  assert.throws(() => createLivingTownCall("assistant_restock", args));
});
test("private restock route derives owner, rejects foreign scope/unknown fields and never generates", async (t) => {
  const h = fixture(t),
    auth = {
      origin: "https://bazaar.example",
      scope: async (token, shop) => {
        if (token !== "a".repeat(43) || shop !== "4")
          throw new AssistantAuthError(401);
        return {
          accountId: h.owner,
          shopId: shop,
          expiresAt: Date.now() + 10000,
        };
      },
    };
  const server = createAssistantServer(auth, h.pipeline);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const request = (shop, body, token = "a".repeat(43)) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/private/assistant/shops/${shop}/restock`,
      {
        method: "POST",
        headers: {
          Origin: auth.origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
  const payload = {
    expectedRevision: "2",
    limits: { ...defaultAssistantRestockLimits(), recommendation_budget: "4" },
  };
  assert.equal((await request("4", payload, "bad")).status, 401);
  assert.equal((await request("5", payload)).status, 401);
  assert.equal(
    (await request("4", { ...payload, accountId: "attacker.testnet" })).status,
    400,
  );
  assert.equal(
    (
      await request("4", {
        ...payload,
        limits: { ...payload.limits, automatic: true },
      })
    ).status,
    400,
  );
  assert.equal((await request("4", payload)).status, 200);
  assert.equal((await request("4", payload)).status, 400);
  assert.equal(
    h.store.settings(h.owner, "4").restock.recommendation_budget,
    "4",
  );
  assert.equal(h.store.history(h.owner, "4").length, 0);
});
