import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeBudget } from "../dist/private/living-town/runtime-budget.js";
import { RuntimeOwner } from "../dist/private/living-town/runtime-owner.js";
import { RuntimeFacts } from "../dist/private/living-town/runtime-facts.js";
import { LivingTownProviderRunner } from "../dist/private/living-town/provider.js";
import {
  merchantCharacter,
  merchantCharacterVersion,
} from "../dist/private/living-town/merchant-characters.js";
import {
  nearAiProvider,
  nearAiPreflight,
  nearAiInputBound,
  nearAiModel,
  nearAiAccountCost,
} from "../dist/private/living-town/near-ai-cloud.js";
import {
  providerFixture,
  modelProposal,
} from "./fixtures/living-town-provider.mjs";
import { adapterFixture, identity } from "./fixtures/living-town-adapter.mjs";

const quote = {
  model: nearAiModel,
  inputRate: 170000,
  outputRate: 1100000,
  evidence: "fixture:catalog",
  verifiedUntil: Date.now() + 3600000,
};
test("hackathon budget revision preserves usage and identity, spreads daily spend and never renews the total after 30 days", async (t) => {
  const p = root(),
    dir = join(p, "budget"),
    wit = join(p, "witness");
  let authority = new RuntimeBudget(dir, wit, true);
  t.after(() => {
    authority?.close();
    rmSync(p, { recursive: true, force: true });
  });
  const prepared = {
    payload: "{}",
    provider: "near-ai",
    model: nearAiModel,
    maxOutputTokens: 512,
    countTokens: () => 4096,
    accountingEvidence: "fixture:tokens",
    worstInputMicroPerMillion: 450000000,
    outputMicroPerMillion: 0,
    pricingEvidence: "fixture:price",
    verifiedUntil: Date.now() + 365 * 86400000,
  };
  const beginning = Date.now(),
    binding = authority.binding;
  authority.budget.reserve("fixture:first", prepared, beginning);
  const old = authority.budget.history().entries;
  authority.useHackathonBudget();
  assert.deepEqual(authority.budget.history().entries, old);
  assert.deepEqual(authority.binding, binding);
  assert.equal(authority.budget.status().dailyLimit, 2000000);
  assert.equal(authority.budget.status().totalLimit, 10000000);
  authority.close();
  authority = new RuntimeBudget(dir, wit);
  assert.deepEqual(authority.binding, binding);
  assert.deepEqual(authority.budget.history().entries, old);
  assert.throws(
    () =>
      authority.budget.reserve("fixture:too-soon", prepared, Date.now() + 1000),
    /rolling model spend cap/,
  );
  for (let n = 1; n < 5; n++)
    authority.budget.reserve(
      `fixture:day-${n}`,
      prepared,
      beginning + n * 86400000 + 1000,
    );
  assert.throws(
    () =>
      authority.budget.reserve(
        "fixture:renewal",
        prepared,
        beginning + 31 * 86400000,
      ),
    /total hackathon model spend cap/,
  );
  assert.equal(authority.budget.history().entries.length, 5);
  // The simulated future clock remains monotonic when reopening this fixture.
  authority.close();
  assert.throws(
    () => new RuntimeBudget(dir, wit),
    /usage continuity not verified/,
  );
  authority = null;
});
function root() {
  const p = mkdtempSync(join(tmpdir(), "bazaar-near-ai-"));
  return p;
}
const reply = (body, headers = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });

test("live-shaped preflight rejects changed pricing and transport uses only the fixed official origin", async () => {
  let price = 0.3;
  const api = async (url, options) => {
    assert.ok(url.startsWith("https://cloud-api.near.ai/"));
    assert.equal(options.redirect, "error");
    return url.endsWith("check_api_key")
      ? reply({ valid: true })
      : reply({
          data: [
            {
              id: nearAiModel,
              is_ready: true,
              pricing: { input: price, output: 1.2, request: "0" },
              supported_features: ["json_mode"],
            },
          ],
        });
  };
  const result = await nearAiPreflight(() => "fixture-secret", api);
  assert.equal(result.inputRate, 300000);
  price = 0.31;
  await assert.rejects(
    nearAiPreflight(() => "fixture-secret", api),
    /pricing increase/,
  );
});

test("HTTP provider failures retain a safe status without leaking remote bodies or credentials", async (t) => {
  const f = await providerFixture(t);
  const provider = nearAiProvider(
    f.policy,
    {},
    quote,
    () => "fixture-secret",
    async () =>
      new Response(
        JSON.stringify({ error: "PRIVATE_REMOTE_BODY_CANARY fixture-secret" }),
        { status: 502 },
      ),
  );
  const runner = new LivingTownProviderRunner(
    f.store,
    f.policy,
    f.budget,
    f.binding,
    provider,
    async () => true,
  );
  const result = await runner.propose(f.context);
  assert.equal(result.origin, "rules");
  const audit = f.store.providerAttempts.get(runner.requestId(f.context));
  assert.equal(audit.code, "near_ai_http_502");
  assert(!JSON.stringify(audit).includes("PRIVATE_REMOTE_BODY_CANARY"));
  assert(!JSON.stringify(audit).includes("fixture-secret"));
});

test("every merchant request contains only its supported character goals with fresh facts inside the original input cap", async (t) => {
  const f = await providerFixture(t);
  const provider = nearAiProvider(
    f.policy,
    {},
    quote,
    () => {
      throw Error("preparation must not load a key");
    },
    () => {
      throw Error("preparation must not call inference");
    },
  );
  for (const merchant of ["rex", "luna", "bolt"]) {
    const profile = merchantCharacter(merchant),
      context = { ...f.context, merchant };
    const first = provider.prepare(context),
      payload = JSON.parse(first.payload);
    assert.equal(first.maxOutputTokens, 512);
    assert.ok(
      nearAiInputBound(first.payload) <= 4096,
      `${merchant}: ${nearAiInputBound(first.payload)} bound`,
    );
    assert.ok(payload.messages[0].content.includes(JSON.stringify(profile)));
    assert.equal(
      payload.messages[0].content.includes(
        `"id":"${merchant === "rex" ? "luna" : "rex"}"`,
      ),
      false,
    );
    assert.equal(
      /loan|barter|academy|research|relationship|blueprint|upgrade|counteroffer|experiment|new recipe/i.test(
        JSON.stringify(profile),
      ),
      false,
    );
    const facts = JSON.parse(payload.messages[1].content);
    assert.equal(facts.merchant_id, merchant);
    assert.equal(typeof facts.available_gold, "string");
    assert.equal(facts.character_profile_sha256.length, 64);
    assert.equal(profile.version, merchantCharacterVersion);
    const freshFacts = structuredClone(context.facts);
    const self = freshFacts.town.data.npc_ledgers.find(
      (l) => l.actor.merchant_id === merchant,
    );
    self.gold.held = (BigInt(self.gold.held) + 1n).toString();
    self.gold.available = (BigInt(self.gold.available) + 1n).toString();
    const second = JSON.parse(
      provider.prepare({
        ...context,
        tickId: "f".repeat(64),
        facts: freshFacts,
      }).payload,
    );
    assert.ok(second.messages[0].content.includes(JSON.stringify(profile)));
    assert.equal(
      JSON.parse(second.messages[1].content).tick_id,
      "f".repeat(64),
    );
    assert.equal(
      JSON.parse(second.messages[1].content).available_gold,
      self.gold.available,
    );
    assert.notEqual(
      JSON.parse(second.messages[1].content).available_gold,
      facts.available_gold,
    );
    profile.goals.length = 0;
    assert.ok(
      merchantCharacter(merchant).goals.length > 0,
      "returned profiles are detached",
    );
    t.diagnostic(
      `${merchant}: ${nearAiInputBound(first.payload)} conservative input-token bound`,
    );
  }
  assert.equal(merchantCharacter("rex").motivations.wealth, 95);
  assert.equal(merchantCharacter("luna").motivations.community, 95);
  assert.equal(merchantCharacter("bolt").motivations.crafting, 100);
});

test("AI runtime defers a short epoch window before allocating ticks, paying or signing", async (t) => {
  const p = root();
  mkdirSync(join(p, "exec"));
  const f = await adapterFixture(join(p, "exec"), {
    simulationOptions: { minimumTickWindowMs: 45000 },
    propose: () => {
      throw Error("must not invoke");
    },
  });
  f.state.town.block_timestamp_ns = (
    BigInt(f.state.town.data.genesis_time_ns) +
    BigInt(f.state.town.data.epoch) * 60000000000n +
    55000000000n
  ).toString();
  assert.equal((await f.simulation.poll()).kind, "deferred");
  assert.equal(f.store.ticks.active(), undefined);
  assert.equal(f.stats.model, 0);
  assert.equal(f.stats.sign, 0);
  assert.equal(f.stats.send, 0);
  f.close();
  t.after(() => rmSync(p, { recursive: true, force: true }));
});

test("merchant invokes once with a bounded exact payload and accounts authoritative inference-ID billing", async (t) => {
  const f = await providerFixture(t),
    p = root(),
    authority = new RuntimeBudget(join(p, "budget"), join(p, "witness"), true);
  t.after(() => {
    authority?.close();
    rmSync(p, { recursive: true, force: true });
  });
  let paid = 0,
    billing = 0;
  const api = async (url, options) => {
    if (url.endsWith("/billing/costs")) {
      billing++;
      assert.deepEqual(JSON.parse(options.body), {
        requestIds: ["12345678-1234-1234-1234-123456789012"],
      });
      return reply({
        requests: [
          {
            requestId: "12345678-1234-1234-1234-123456789012",
            costNanoUsd: 100000,
          },
        ],
      });
    }
    paid++;
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.chat_template_kwargs, undefined);
    assert.equal(body.messages.length, 2);
    assert.equal(
      body.messages.some((m) => m.content.includes("fixture-secret")),
      false,
    );
    return reply(
      {
        id: "chat-fixture",
        model: nearAiModel,
        usage: { prompt_tokens: 500, completion_tokens: 80 },
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(modelProposal(f.context)) },
          },
        ],
      },
      { "inference-id": "12345678-1234-1234-1234-123456789012" },
    );
  };
  const provider = nearAiProvider(
    f.policy,
    authority,
    quote,
    () => "fixture-secret",
    api,
  );
  const prepared = provider.prepare(f.context);
  assert.ok(nearAiInputBound(prepared.payload) <= 4096);
  const runner = new LivingTownProviderRunner(
    f.store,
    f.policy,
    authority.budget,
    authority.binding,
    provider,
    async () => true,
  );
  const result = await runner.propose(f.context);
  assert.equal(result.origin, "model_proposal");
  assert.equal(authority.budget.status().dailyMicro, 100);
  assert.equal(authority.receipt(result.inferenceRef).usage.prompt_tokens, 500);
  await runner.propose(f.context);
  assert.equal(paid, 1);
  assert.equal(billing, 1);
});

test("invalid JSON and uncertain billing keep paid audit; billing warnings cannot erase a reservation", async (t) => {
  const f = await providerFixture(t),
    p = root(),
    authority = new RuntimeBudget(join(p, "budget"), join(p, "witness"), true);
  t.after(() => {
    authority?.close();
    rmSync(p, { recursive: true, force: true });
  });
  const api = async (url) =>
    url.endsWith("/billing/costs")
      ? reply({
          warning: "not yet indexed",
          requests: [
            {
              requestId: "12345678-1234-1234-1234-123456789012",
              costNanoUsd: 0,
            },
          ],
        })
      : reply(
          {
            id: "chat-invalid",
            model: nearAiModel,
            usage: { prompt_tokens: 500, completion_tokens: 12 },
            choices: [
              { finish_reason: "stop", message: { content: "not JSON" } },
            ],
          },
          { "inference-id": "12345678-1234-1234-1234-123456789012" },
        );
  const runner = new LivingTownProviderRunner(
    f.store,
    f.policy,
    authority.budget,
    authority.binding,
    nearAiProvider(f.policy, authority, quote, () => "fixture-secret", api),
    async () => true,
  );
  const result = await runner.propose(f.context);
  assert.equal(result.origin, "rules");
  const entry = authority.budget.history().entries[0];
  assert.equal(entry.status, "reserved");
  assert.ok(entry.charged_micro >= 1000);
  assert.equal(
    await nearAiAccountCost(
      authority,
      entry.request_id,
      "12345678-1234-1234-1234-123456789012",
      () => "fixture-secret",
      undefined,
      api,
    ),
    null,
  );
  assert.equal(
    authority.budget.history().entries[0].charged_micro,
    entry.charged_micro,
  );
});

test("timeout aborts a single paid request, retains the bound across restart and cannot retry the original opportunity", async (t) => {
  const f = await providerFixture(t),
    p = root(),
    dir = join(p, "budget"),
    wit = join(p, "witness");
  let authority = new RuntimeBudget(dir, wit, true),
    paid = 0;
  t.after(() => {
    authority?.close();
    rmSync(p, { recursive: true, force: true });
  });
  const api = async (_url, options) => {
    paid++;
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(Error("aborted")), {
        once: true,
      }),
    );
  };
  const runner = new LivingTownProviderRunner(
    f.store,
    f.policy,
    authority.budget,
    authority.binding,
    nearAiProvider(f.policy, authority, quote, () => "fixture-secret", api),
    async () => true,
    1000,
  );
  assert.equal((await runner.propose(f.context)).origin, "rules");
  assert.equal(paid, 1);
  const before = authority.budget.history().entries[0],
    binding = authority.binding;
  authority.close();
  authority = new RuntimeBudget(dir, wit);
  assert.deepEqual(authority.binding, binding);
  assert.deepEqual(authority.budget.history().entries[0], before);
  const restarted = new LivingTownProviderRunner(
    f.store,
    f.policy,
    authority.budget,
    authority.binding,
    nearAiProvider(f.policy, authority, quote, () => "fixture-secret", api),
    async () => true,
  );
  await restarted.propose(f.context);
  assert.equal(paid, 1);
});

test("shared authority detects rollback rather than creating a fresh allowance", async (t) => {
  const p = root(),
    dir = join(p, "budget"),
    wit = join(p, "witness");
  let authority = new RuntimeBudget(dir, wit, true);
  authority.close();
  copyFileSync(join(dir, "shared-inference.sqlite"), join(p, "before.sqlite"));
  authority = new RuntimeBudget(dir, wit);
  authority.budget.reserve(
    "fixture:request",
    {
      payload: "{}",
      provider: "near-ai",
      model: nearAiModel,
      maxOutputTokens: 512,
      countTokens: () => 100,
      accountingEvidence: "fixture:tokens",
      worstInputMicroPerMillion: 170000,
      outputMicroPerMillion: 1100000,
      pricingEvidence: "fixture:rates",
      verifiedUntil: Date.now() + 10000,
    },
    Date.now(),
  );
  authority.close();
  copyFileSync(join(p, "before.sqlite"), join(dir, "shared-inference.sqlite"));
  assert.throws(() => new RuntimeBudget(dir, wit), /journal\/witness mismatch/);
  assert.throws(() => new RuntimeBudget(dir, wit, true), /existing shared/);
  t.after(() => rmSync(p, { recursive: true, force: true }));
});

test("one-way provider enrollment preserves the original economic witness and requires its shared ledger after model history", async (t) => {
  const p = root(),
    execution = join(p, "exec"),
    wit = join(p, "witness");
  mkdirSync(execution);
  mkdirSync(wit);
  const authority = new RuntimeBudget(
    join(p, "budget"),
    join(p, "budget-witness"),
    true,
  );
  const f = await adapterFixture(execution),
    facts = new RuntimeFacts(execution, identity, true),
    owner = new RuntimeOwner(
      f.store,
      facts,
      wit,
      { keys: "fixture" },
      true,
      authority,
    );
  owner.enableProvider();
  f.store.providerAttempts.begin({
    id: "fixture:model",
    tickId: "a".repeat(64),
    merchant: "rex",
    provider: "near-ai",
    model: nearAiModel,
    promptVersion: "fixture",
    ledgerId: authority.binding.ledgerId,
    context: {},
    now: Date.now(),
    deadline: Date.now() + 10000,
  });
  owner.verify();
  assert.throws(() => owner.enableProvider(), /enrollment/);
  owner.close();
  facts.close();
  f.close();
  authority.close();
  t.after(() => rmSync(p, { recursive: true, force: true }));
});
