import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import {
  livingTownJsonDigest,
  assistantManualReview,
  verifyAssistantReview,
  assistantCallMatches,
  assistantReviewReference,
} from "../../packages/chain/dist/index.js";
const built = await build({
  stdin: {
    contents:
      "export {LivingTownTransactions} from './apps/web/src/app/living-town-transactions.ts'; export {AssistantPanel} from './apps/web/src/app/assistant-panel.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const { LivingTownTransactions, AssistantPanel } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);
const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
const outcome = (i) =>
  JSON.parse(
    Buffer.from(capture.steps[i].receipt.status.SuccessValue, "base64"),
  );
const foundation = JSON.parse(
  Buffer.from(capture.steps[0].foundation.result).toString(),
);
const identity = {
  deployment: foundation.deployment,
  codeHash: capture.steps[0].account.code_hash,
  ownerId: capture.contract_id,
  operatorId: "operator.testnet",
  controllers: {
    rex: "rex.testnet",
    luna: "luna.testnet",
    bolt: "bolt.testnet",
  },
};
async function reviewFixture(kind = "suggest_price") {
  const shop = structuredClone(outcome(1).data.outcome.shop),
    ledger = structuredClone(outcome(3).data.outcome.buyer),
    now = BigInt(Date.now()) * 1000000n;
  const action =
    kind === "suggest_price"
      ? {
          type: kind,
          item_id: "health_potion",
          listing_id: "5",
          expected_listing_revision: "1",
          current_unit_price: "10",
          suggested_unit_price: "11",
        }
      : {
          type: kind,
          item_id: "crystal",
          listing_id: "1",
          expected_listing_revision: "2",
          seller_shop_id: "1",
          quantity: "2",
          unit_price: "4",
          total_price: "8",
        };
  const terms = {
    schema: "living-town-assistant-proposal-v1",
    shop_id: shop.shop_id,
    owner_account_id: capture.player_id,
    snapshot: {
      deployment: identity.deployment,
      block_hash: capture.steps[3].block.header.hash,
      block_height: "33",
      block_timestamp_ns: String(now),
      market_revision: "5",
      event_sequence: "5",
    },
    expected_shop_revision: shop.revision,
    expected_ledger_revision: ledger.revision,
    expected_policy_revision: shop.policy_revision,
    config_revision: "2",
    created_at_ns: String(now),
    expires_at_ns: String(now + 120000000000n),
    source: "rules_fallback",
    action,
    reason: "PRIVATE RECOMMENDATION REASON",
  };
  const proposal = { ...terms, proposal_id: await livingTownJsonDigest(terms) };
  const call =
    kind === "suggest_price"
      ? {
          method: "set_listing",
          args: {
            shop_id: shop.shop_id,
            item_id: "health_potion",
            quantity: "1",
            unit_price: "11",
            expected_listing_revision: "1",
          },
        }
      : {
          method: "buy_from_merchant",
          args: {
            merchant_id: "rex",
            item_id: "crystal",
            quantity: "2",
            expected_listing_revision: "2",
            max_total_price: "8",
          },
        };
  const body = { schema: "living-town-assistant-review-v1", proposal, call };
  return {
    review: assistantManualReview({
      ...body,
      review_id: await livingTownJsonDigest(body),
    }),
    shop,
    ledger,
    now,
  };
}
async function journalFixture(kind = "suggest_price", unknown = false) {
  const f = await reviewFixture(kind),
    memory = new Map(),
    storage = {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => memory.set(k, v),
      removeItem: (k) => memory.delete(k),
    };
  const listing = {
    listing_id: "5",
    shop_id: f.shop.shop_id,
    owner: f.shop.owner,
    item_id: "health_potion",
    remaining_quantity: "1",
    unit_price: "10",
    revision: "1",
    active: true,
  };
  f.ledger.inventory.held.health_potion = "1";
  f.ledger.inventory.listing_reserved.health_potion = "1";
  let time = f.now,
    allowed = true,
    sends = 0,
    guards = 0,
    tail = Promise.resolve();
  const lock = (_key, work) => {
    const p = tail.then(work);
    tail = p.catch(() => {});
    return p;
  };
  const reader = {
    get block() {
      return {
        hash: capture.steps[3].block.header.hash,
        height: "33",
        timestampNs: String(time),
      };
    },
    getCommand: async () => ({
      data: { kind: "not_applied", next_sequence: "1" },
    }),
    getTown: async () => ({ data: { paused: false } }),
    getPlayer: async () => ({ data: { shop_id: f.shop.shop_id } }),
    getShop: async () => ({ data: f.shop }),
    getListings: async () => ({ data: { items: [listing], has_more: false } }),
    getShopInventory: async () => ({ data: f.ledger }),
  };
  const client = {
    identity,
    finalized: async () => reader,
    receipt: async () => ({ kind: "unknown" }),
  };
  const send = async (_account, call) => {
    sends++;
    assert.equal(call.method, f.review.call.method);
    assert.ok(assistantCallMatches(f.review, call));
    if (unknown) throw Error("wallet outcome unknown");
    return { transaction: { hash: capture.steps[3].transaction_hash } };
  };
  const guard = async (link, account, call) => {
    guards++;
    assert.deepEqual(
      JSON.parse(JSON.stringify(link)),
      JSON.parse(JSON.stringify(assistantReviewReference(f.review))),
    );
    if (
      !allowed ||
      account !== capture.player_id ||
      !assistantCallMatches(f.review, call)
    )
      throw Error("Review expired, changed or unauthenticated");
  };
  const make = () =>
    new LivingTownTransactions(
      client,
      storage,
      send,
      lock,
      () => "11111111-1111-4111-8111-111111111111",
      guard,
    );
  const args = {
    ...f.review.call.args,
    command: {
      sequence: "1",
      config_version: identity.deployment.config_version,
      valid_until_ns: f.review.proposal.expires_at_ns,
    },
  };
  return {
    ...f,
    memory,
    make,
    args,
    deny: () => {
      allowed = false;
    },
    expire: () => {
      time = BigInt(f.review.proposal.expires_at_ns);
    },
    get sends() {
      return sends;
    },
    get guards() {
      return guards;
    },
  };
}
for (const kind of ["suggest_price", "suggest_restock"])
  test(`reviewed ${kind} uses ordinary owner wallet flow; reload cannot resend`, async () => {
    const f = await journalFixture(kind),
      journal = f.make();
    const attempt = await journal.prepare(
      capture.player_id,
      f.review.call.method,
      f.args,
      f.review,
    );
    assert.equal(f.sends, 0);
    assert.equal(attempt.phase, "prepared");
    assert.equal(attempt.assistant_review.review_id, f.review.review_id);
    assert.equal(
      [...f.memory.values()].join().includes("PRIVATE RECOMMENDATION REASON"),
      false,
    );
    const restored = f.make();
    await restored.restore();
    assert.equal(f.sends, 0);
    await restored.submit(attempt.id);
    assert.equal(f.sends, 1);
    assert.equal((await restored.read()).phase, "submitted");
    await assert.rejects(restored.submit(attempt.id));
    await restored.refresh();
    assert.equal(f.sends, 1);
  });
test("unsigned restored assistant attempt needs fresh authorized review and preserves prepared state on rejection", async () => {
  const f = await journalFixture(),
    a = await f
      .make()
      .prepare(capture.player_id, f.review.call.method, f.args, f.review);
  f.deny();
  const restored = f.make();
  await restored.restore();
  await assert.rejects(restored.submit(a.id));
  assert.equal(f.sends, 0);
  assert.equal((await restored.read()).phase, "prepared");
});
test("proposal expiry bounds the ordinary owner command and prevents wallet handoff", async () => {
  const f = await journalFixture(),
    a = await f
      .make()
      .prepare(capture.player_id, f.review.call.method, f.args, f.review);
  f.expire();
  await assert.rejects(f.make().submit(a.id));
  assert.equal(f.sends, 0);
});
test("unknown owner outcome remains one original attempt across reload and double clicks", async () => {
  const f = await journalFixture("suggest_restock", true),
    journal = f.make(),
    a = await journal.prepare(
      capture.player_id,
      f.review.call.method,
      f.args,
      f.review,
    );
  await Promise.allSettled([journal.submit(a.id), f.make().submit(a.id)]);
  assert.equal(f.sends, 1);
  const restored = f.make();
  await restored.restore();
  assert.equal((await restored.read()).phase, "unknown");
  await assert.rejects(
    restored.prepare(capture.player_id, f.review.call.method, f.args, f.review),
  );
  assert.equal(f.sends, 1);
});
test("tampered review, local linkage or quantity cannot bypass a fresh exact review", async () => {
  const f = await journalFixture();
  const forged = structuredClone(f.review);
  forged.call.args.quantity = "2";
  await assert.rejects(verifyAssistantReview(forged));
  const journal = f.make();
  await journal.prepare(
    capture.player_id,
    f.review.call.method,
    f.args,
    f.review,
  );
  const [key, json] = [...f.memory][0],
    e = JSON.parse(json);
  e.pending.assistant_review.review_id = "f".repeat(64);
  f.memory.set(key, JSON.stringify(e));
  await assert.rejects(f.make().restore());
  assert.equal(f.sends, 0);
});
test("review cancel, dismissal and opening the panel cannot sign or generate automatically", async () => {
  const f = await reviewFixture();
  let transactions = 0,
    generations = 0,
    dismissed = false;
  const history = () => ({
    stale: false,
    configuration: { mode: "recommendations" },
    history: [
      {
        status: "proposed",
        proposals: [f.review.proposal],
        decisions: dismissed
          ? [
              {
                proposal_id: f.review.proposal.proposal_id,
                status: "dismissed",
                attempt_id: null,
              },
            ]
          : [],
      },
    ],
  });
  const port = {
    logout: () => {},
    authenticate: async () => {},
    recommendations: async () => history(),
    generate: async () => {
      generations++;
      return history();
    },
    review: async () => f.review,
    dismiss: async () => {
      dismissed = true;
      return history();
    },
  };
  const panel = new AssistantPanel(
    () => port,
    async () => {
      transactions++;
    },
    () => {},
  );
  panel.setScope(capture.player_id, f.shop.shop_id);
  assert.equal(transactions, 0);
  await panel.signIn();
  assert.equal(generations, 0);
  await panel.review(f.review.proposal.proposal_id);
  panel.cancelReview();
  assert.equal(transactions, 0);
  await panel.dismiss(f.review.proposal.proposal_id);
  assert.equal(transactions, 0);
  assert.equal(panel.state.proposals.length, 0);
});
test("late private review cannot populate another account's panel", async () => {
  const f = await reviewFixture();
  let resolve;
  const wait = new Promise((r) => {
    resolve = r;
  });
  const port = {
    logout: () => {},
    authenticate: async () => {},
    recommendations: async () => ({
      stale: false,
      configuration: { mode: "recommendations" },
      history: [{ status: "proposed", proposals: [f.review.proposal] }],
    }),
    review: async () => wait,
  };
  let signed = 0;
  const panel = new AssistantPanel(
    () => port,
    async () => {
      signed++;
    },
    () => {},
  );
  panel.setScope(capture.player_id, f.shop.shop_id);
  await panel.signIn();
  const pending = panel.review(f.review.proposal.proposal_id);
  panel.setScope("other.testnet", "5");
  resolve(f.review);
  await pending;
  assert.equal(panel.state.review, null);
  assert.deepEqual(panel.state.proposals, []);
  assert.equal(signed, 0);
});
test("UI uses text rendering, explicit review/sign controls and no automatic restock toggle", () => {
  const html = readFileSync(
    "apps/web/src/app/living-town-assistant.component.html",
    "utf8",
  );
  assert.match(html, /Review exact terms/);
  assert.match(html, /Accept and sign in wallet/);
  assert.match(html, /Cancel review/);
  assert.match(html, /Dismiss suggestion/);
  assert.doesNotMatch(html, /\[innerHTML\]|bypassSecurity|auto_restock/);
});
