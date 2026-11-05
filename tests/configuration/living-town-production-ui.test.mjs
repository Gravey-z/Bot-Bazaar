import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { verifyLivingTownReceipt } from "../../packages/chain/dist/index.js";

const p = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-production-sandbox.json",
    "utf8",
  ),
);
const recipeCapture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-recipes-sandbox.json", "utf8"),
);
const recipes = JSON.parse(
  Buffer.from(recipeCapture.recipes.result).toString(),
).data.items.map((r) => r.recipe);
const bundled = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/app/living-town-production-ui.ts'; export * from './apps/web/src/app/living-town-controller.ts'; export * from './apps/web/src/app/living-town-transactions.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const {
  productionQuote,
  productionReviewMatches,
  productionCountdown,
  itemSymbol,
  LivingTownTransactions,
  LivingTownController,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const copy = structuredClone;
const step = p.steps[0],
  foundation = step.foundation;
const identity = {
  deployment: foundation.deployment,
  codeHash: step.account.code_hash,
  ownerId: foundation.data.owner_account_id,
  operatorId: foundation.data.operator_account_id,
  controllers: foundation.data.merchant_controllers,
};
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
function observation(snapshot = p.before, index = 0) {
  const row = copy(snapshot.shops[index]);
  return {
    accountId: row.shop.data.owner.account_id,
    town: copy(snapshot.town.data),
    player: null,
    shop: row.shop.data,
    ledger: row.ledger.data,
    listings: [],
    receivedAt: Date.now(),
    stale: false,
    ownershipKnown: true,
    source: "chain",
    ownershipUrl: null,
    production: {
      items: row.jobs.data.items,
      historyGap: row.jobs.data.history_gap,
    },
    chainTimestampNs: snapshot.town.block_timestamp_ns,
    recipes: copy(recipes),
  };
}
function journalHarness() {
  const values = new Map();
  let source = copy(p.before),
    sends = 0,
    offline = false;
  const client = {
    identity,
    finalized: async () => ({
      block: block(source.block),
      getTown: async () => source.town,
      getShop: async () => source.shops[0].shop,
      getShopInventory: async () => source.shops[0].ledger,
      getRecipes: async () => ({
        data: { items: recipes.map((recipe) => ({ recipe })) },
      }),
      getProductionJobs: async () => ({
        ...source.shops[0].jobs,
        data: {
          ...source.shops[0].jobs.data,
          items: source.shops[0].jobs.data.items.filter(
            (j) => j.status === "running",
          ),
        },
      }),
      getCommand: async () => ({
        data: {
          kind: "not_applied",
          next_sequence: step.args.command.sequence,
        },
      }),
    }),
    receipt: async (proof) => {
      if (offline) throw Error("offline");
      return verifyLivingTownReceipt(step.receipt, proof, async () =>
        block(step.block),
      );
    },
  };
  const storage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  const journal = () =>
    new LivingTownTransactions(
      client,
      storage,
      async (account, call) => {
        assert.equal(account, step.signer_id);
        assert.deepEqual(JSON.parse(JSON.stringify(call.args)), step.args);
        sends++;
        return { transaction: { hash: step.transaction_hash } };
      },
      async (_name, work) => work(),
      () => "00000000-0000-4000-8000-000000000001",
    );
  return {
    journal,
    get sends() {
      return sends;
    },
    source: (s) => {
      source = copy(s);
    },
    offline: (v) => {
      offline = v;
    },
  };
}

test("recipe reviews use actual captured available inputs, exact batch duration/output and six item text symbols", () => {
  for (const [index, recipeId, seconds] of [
    [0, "health_potion", "360"],
    [1, "iron_tool", "540"],
  ]) {
    const o = observation(p.before, index),
      recipe = recipes.find((r) => r.recipe_id === recipeId);
    const quote = productionQuote(o, recipe, index === 0 ? "3" : "2");
    assert.equal(quote.reason, "");
    assert.equal(quote.review.output, index === 0 ? "3" : "2");
    assert.equal(quote.review.durationSeconds, index === 0 ? seconds : "360");
    assert.equal(quote.review.inputs.length, 2);
    for (const input of quote.review.inputs)
      assert.equal(BigInt(input.required) <= BigInt(input.available), true);
    assert.equal(productionReviewMatches(quote.review, o), true);
  }
  const ids = ["crystal", "wood", "herb", "iron", "health_potion", "iron_tool"];
  assert.equal(new Set(ids.map(itemSymbol)).size, 6);
  assert(itemSymbol("unknown"));
});

test("production cards reject invalid batches, reserved/insufficient inputs, full slots and whole-batch capacity", () => {
  const o = observation(),
    recipe = recipes[0];
  for (const q of [
    "0",
    "11",
    "1.5",
    "01",
    "-1",
    "1e0",
    "",
    "18446744073709551616",
  ])
    assert.equal(productionQuote(o, recipe, q).review, null);
  for (const [mutate, reason] of [
    [(v) => (v.stale = true), /Refresh/],
    [(v) => (v.town.paused = true), /paused/],
    [
      (v) => (v.production.items = [copy(p.after.shops[0].jobs.data.items[0])]),
      /slot/,
    ],
    [
      (v) => {
        v.ledger.inventory.available.herb = "0";
        v.ledger.inventory.listing_reserved.herb = "6";
      },
      /available inputs/,
    ],
    [(v) => (v.ledger.inventory.held.health_potion = "998"), /capacity/],
    [
      (v) => (v.ledger.inventory.trade_inbound_reserved.health_potion = "998"),
      /capacity/,
    ],
    [(v) => (v.shop.owner.account_id = "other.testnet"), /confirmed shop/],
    [(v) => delete v.production, /confirmed shop/],
    [(v) => (v.chainTimestampNs = "18446744073709551615"), /timing/],
  ]) {
    const changed = copy(o);
    mutate(changed);
    assert.match(productionQuote(changed, recipe, "3").reason, reason);
  }
  const exact = copy(o);
  exact.ledger.inventory.held.health_potion = "997";
  assert.equal(productionQuote(exact, recipe, "3").reason, "");
});

test("review invalidation binds account, inventory/shop revisions, recipe terms and current slot availability", () => {
  const o = observation(),
    review = productionQuote(o, recipes[0], "3").review;
  for (const mutate of [
    (v) => (v.accountId = "other.testnet"),
    (v) => (v.shop.revision = "999"),
    (v) => (v.ledger.revision = "999"),
    (v) => (v.recipes[0].version = "2"),
    (v) => (v.recipes[0].duration_seconds = "1"),
    (v) => (v.ledger.inventory.available.herb = "5"),
    (v) => (v.production.items = [copy(p.after.shops[0].jobs.data.items[0])]),
    (v) => (v.town.paused = true),
    (v) => (v.stale = true),
  ]) {
    const changed = copy(o);
    mutate(changed);
    assert.equal(productionReviewMatches(review, changed), false);
  }
  const fresh = copy(o);
  fresh.chainTimestampNs = (
    BigInt(o.chainTimestampNs) + 1000000000n
  ).toString();
  fresh.receivedAt += 1000;
  assert.equal(productionReviewMatches(review, fresh), true);
  assert.equal(o.ledger.inventory.held.health_potion, "0");
  assert.equal(o.production.items.length, 0);
});

test("monotonic countdown is a capped estimate; changed browser clocks and elapsed time never complete jobs", () => {
  const job = copy(p.after.shops[0].jobs.data.items[0]);
  const near = (BigInt(job.ready_at_ns) - 10000000000n).toString();
  assert.match(productionCountdown(job, near, 0).text, /0m 10s/);
  assert.equal(productionCountdown(job, near, 10000).state, "ready");
  assert.match(
    productionCountdown(job, near, 10000).text,
    /refresh to confirm/,
  );
  assert.match(
    productionCountdown(job, job.ready_at_ns, 0).text,
    /awaiting settlement/,
  );
  const far = (BigInt(job.ready_at_ns) - 60000000000n).toString();
  assert.equal(productionCountdown(job, far, 86400000).state, "running");
  assert.equal(productionCountdown(job, far, -500).state, "running");
  const original = Date.now;
  try {
    Date.now = () => original() + 86400000;
    assert.equal(productionCountdown(job, far, 0).state, "running");
    Date.now = () => 0;
    assert.equal(productionCountdown(job, near, 10000).state, "ready");
  } finally {
    Date.now = original;
  }
  assert.equal(job.status, "running");
  assert.equal(job.completed_at_ns, null);
  const completed = {
    ...job,
    status: "completed",
    completed_at_ns: job.ready_at_ns,
    revision: "2",
  };
  assert.equal(productionCountdown(completed, far, 0).state, "completed");
});

test("Start revalidates before wallet handoff; a new slot, revision or unavailable input preserves the unsigned request", async () => {
  for (const mutate of [
    (v) => (v.shops[0].shop.data.revision = "999"),
    (v) =>
      (v.shops[0].jobs.data.items = [
        copy(p.after.shops[0].jobs.data.items[0]),
      ]),
    (v) => (v.shops[0].ledger.data.inventory.available.herb = "0"),
    (v) => (v.town.data.paused = true),
    (v) =>
      (v.shops[0].ledger.data.inventory.trade_inbound_reserved.health_potion =
        "1000"),
  ]) {
    const h = journalHarness(),
      j = h.journal();
    const prepared = await j.prepare(
      step.signer_id,
      "start_production",
      step.args,
    );
    const changed = copy(p.before);
    mutate(changed);
    h.source(changed);
    await assert.rejects(j.submit(prepared.id));
    assert.equal(h.sends, 0);
    assert.equal((await j.read()).phase, "prepared");
    await j.discardPrepared(prepared.id);
    assert.equal(await j.read(), null);
  }
});

test("Start submission/reload/outage uses the original actual receipt exactly once and does not invent inventory", async () => {
  const h = journalHarness();
  let j = h.journal();
  const prepared = await j.prepare(
    step.signer_id,
    "start_production",
    step.args,
  );
  await j.submit(prepared.id);
  assert.equal(h.sends, 1);
  j = h.journal();
  assert.equal((await j.restore()).transactionHash, step.transaction_hash);
  h.offline(true);
  await assert.rejects(j.refresh(), /offline/);
  assert.equal((await j.read()).phase, "submitted");
  await assert.rejects(
    j.prepare(step.signer_id, "start_production", step.args),
  );
  h.offline(false);
  const result = await j.refresh();
  assert.equal(result.kind, "succeeded");
  assert.equal(result.result.data.outcome.job.status, "running");
  assert.equal(
    result.result.data.outcome.ledger.inventory.held.health_potion,
    "0",
  );
  assert.equal(
    result.result.data.outcome.ledger.inventory.production_output_reserved
      .health_potion,
    "3",
  );
  assert.equal(await j.read(), null);
  assert.equal((await j.last()).phase, "confirmed");
  assert.equal(h.sends, 1);
});

test("controller guards reviewed Start terms and refreshes finalized running jobs without optimistic outputs", async () => {
  const h = journalHarness(),
    j = h.journal();
  let snapshot = p.before;
  const port = {
    accounts: async () => [{ accountId: step.signer_id }],
    subscribe: () => () => {},
    restore: () => j.restore(),
    pending: () => j.read(),
    last: () => j.last(),
    read: async () => observation(snapshot),
    prepare: (account, method, args) =>
      j.prepare(account, method, { ...args, command: step.args.command }),
    submit: (id) => j.submit(id),
    discardPrepared: (id) => j.discardPrepared(id),
    reconcile: async () => {
      const result = await j.refresh();
      if (result?.kind === "succeeded") snapshot = p.after;
      return result;
    },
  };
  const c = new LivingTownController(port, () => {});
  await c.start();
  const args = { ...step.args };
  delete args.command;
  await c.act("start_production", { ...args, expected_shop_revision: "999" });
  assert.equal(h.sends, 0);
  await c.act("start_production", { ...args, quantity: "10" });
  assert.equal(h.sends, 0);
  const before = c.state.observation.ledger.gold.held;
  await c.act("start_production", args);
  assert.equal(h.sends, 1);
  assert.equal(c.state.pending, null);
  assert.equal(c.state.lastAttempt.phase, "confirmed");
  assert.equal(c.state.observation.production.items[0].status, "running");
  assert.equal(c.state.observation.ledger.inventory.held.health_potion, "0");
  assert.equal(c.state.observation.ledger.gold.held, before);
  await c.act("start_production", args);
  assert.equal(h.sends, 1);
  c.stop();
});

test("verified-client failure is shown as a terminal request and survives reload without a phantom job", async () => {
  // Controlled trusted-port failure, not an actual failed sandbox Start capture.
  let pending = null,
    last = null,
    opens = 0;
  const port = {
    accounts: async () => [{ accountId: step.signer_id }],
    subscribe: () => () => {},
    restore: async () => pending,
    pending: async () => pending,
    last: async () => last,
    read: async () => observation(),
    prepare: async (account, method, args) => {
      pending = {
        id: "failed-start",
        accountId: account,
        call: { method, args },
        phase: "prepared",
        transactionHash: null,
      };
      return pending;
    },
    submit: async () => {
      opens++;
      pending = {
        ...pending,
        phase: "submitted",
        transactionHash: identity.deployment.genesis_hash,
      };
    },
    reconcile: async () => {
      if (!pending) return null;
      last = { ...pending, phase: "failed" };
      pending = null;
      return { kind: "failed", code: "EXECUTION_FAILED" };
    },
  };
  let c = new LivingTownController(port, () => {});
  await c.start();
  const args = { ...step.args };
  delete args.command;
  await c.act("start_production", args);
  assert.equal(c.state.lastAttempt.phase, "failed");
  assert.equal(c.state.pending, null);
  assert.equal(c.state.observation.production.items.length, 0);
  assert.equal(c.state.observation.ledger.inventory.held.health_potion, "0");
  c.stop();
  c = new LivingTownController(port, () => {});
  await c.start();
  assert.equal(c.state.lastAttempt.phase, "failed");
  assert.equal(opens, 1);
  assert.equal(c.state.observation.production.items.length, 0);
  c.stop();
});
