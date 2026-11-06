import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  providerFixture,
  prepared,
  modelProposal,
} from "./fixtures/living-town-provider.mjs";
import { adapterFixture } from "./fixtures/living-town-adapter.mjs";
import { LivingTownProviderRunner } from "../dist/private/living-town/provider.js";
import { LivingTownExecutionStore } from "../dist/private/living-town/execution-store.js";
import { DefinitiveProviderFailure } from "../dist/private/retries/provider.js";
import { SafetyClock } from "../dist/private/retries/clock.js";
import { isTownProposalDelivery } from "../dist/private/living-town/proposals.js";
import { sha256 } from "../dist/private/storage/validation.js";
const identityReport = (c) =>
  c.reportIdentity({ provider: "fixture", model: "fixture-model" });
const settle = () => new Promise((r) => setImmediate(r));

test("validated provider output reserves shared usage before invoke, persists input identity and caches one decision", async (t) => {
  const f = await providerFixture(t),
    result = await f.runner.propose(f.context),
    id = f.runner.requestId(f.context);
  assert.equal(result.origin, "model_proposal");
  assert(isTownProposalDelivery(result));
  assert(!isTownProposalDelivery(JSON.parse(JSON.stringify(result))));
  const row = f.store.providerAttempts.get(id);
  assert.equal(row.status, "accepted");
  assert.equal(row.payload_hash, sha256(f.stats.payload));
  assert(row.dispatched_at);
  assert.equal(row.ledger_id, f.binding.ledgerId);
  assert.equal(f.stats.invoke, 1);
  assert.equal(f.budget.status().dailyMicro, 1000);
  assert.equal(f.budget.history().entries[0].status, "reserved");
  assert.deepEqual(
    (await f.runner.propose(f.context)).proposal,
    result.proposal,
  );
  assert.equal(f.stats.invoke, 1);
});

test("V1, rehearsals and a different V2 deployment consume the same approved ledger without a new allowance", async (t) => {
  let other;
  const f = await providerFixture(t, { extraCleanup: () => other?.close() });
  f.budget.reserve(
    "v1:existing",
    prepared(f.context, {
      countTokens: () => 1000,
      worstInputMicroPerMillion: 250000000,
      outputMicroPerMillion: 0,
    }),
    Date.now(),
  );
  f.budget.reserve(
    "rehearsal:existing",
    prepared(f.context, {
      countTokens: () => 1000,
      worstInputMicroPerMillion: 249000000,
      outputMicroPerMillion: 0,
    }),
    Date.now(),
  );
  assert.equal((await f.runner.propose(f.context)).origin, "model_proposal");
  assert.equal(f.budget.status().dailyMicro, 500000);
  const identity = structuredClone(f.store.identity);
  identity.deployment.contract_id = "another-living-town.testnet";
  const dir = join(f.dir, "other-deployment");
  mkdirSync(dir);
  other = new LivingTownExecutionStore(dir, identity, "42", true);
  other.recovered(
    Object.fromEntries(
      ["rex", "luna", "bolt", "operator"].map((l) => [
        l,
        { sequence: "0", digest: null },
      ]),
    ),
  );
  const facts = structuredClone(f.context.facts);
  facts.town.deployment = structuredClone(identity.deployment);
  for (const r of facts.merchants)
    r.shop.deployment = structuredClone(identity.deployment);
  const reader = await f.adapters.operator.client.finalized(),
    slot = (
      (BigInt(facts.town.block_timestamp_ns) -
        BigInt(facts.town.data.genesis_time_ns)) /
      30000000000n
    ).toString();
  const tick = other.ticks.prepare(
    { town: facts.town, block: reader.block, codeHash: identity.codeHash },
    30000,
    [{ id: "b".repeat(64), arrival: `merchant:rex:${slot}` }],
  );
  const context = { ...f.context, tickId: tick.id, facts },
    runner = new LivingTownProviderRunner(
      other,
      f.policy,
      f.budget,
      f.binding,
      f.configuration,
      async () => true,
    );
  const result = await runner.propose(context);
  assert.equal(result.origin, "rules");
  assert.equal(
    other.providerAttempts.get(result.inferenceRef).code,
    "budget_admission_rejected",
  );
  assert.equal(f.stats.invoke, 1);
  assert.equal(f.budget.history().entries.length, 3);
  assert.equal(f.budget.context().ledgerId, f.binding.ledgerId);
});

test("existing rolling request limits block V2 after 60 combined calls even with money remaining", async (t) => {
  const f = await providerFixture(t);
  for (let i = 0; i < 60; i++)
    f.budget.reserve(`v1-or-rehearsal:${i}`, prepared(f.context), Date.now());
  const result = await f.runner.propose(f.context);
  assert.equal(result.origin, "rules");
  assert.equal(f.stats.invoke, 0);
  assert.equal(
    f.store.providerAttempts.get(result.inferenceRef).code,
    "budget_admission_rejected",
  );
  assert.equal(f.budget.history().entries.length, 60);
});

test("timeouts retain the full reservation and late replies/identity reports cannot replace the rules fallback", async (t) => {
  let release, lateReport;
  const f = await providerFixture(t, {
    timeoutMs: 100,
    invoke: (c, input) => {
      identityReport(c);
      lateReport = c.reportIdentity;
      return new Promise((resolve) => {
        release = () => resolve(modelProposal(input));
      });
    },
  });
  const result = await f.runner.propose(f.context),
    row = f.store.providerAttempts.get(result.inferenceRef);
  assert.equal(result.origin, "rules");
  assert.equal(row.code, "request_timeout");
  assert.equal(row.status, "fallback");
  assert.equal(f.budget.status().dailyMicro, 1000);
  assert.equal(f.budget.history().entries[0].status, "reserved");
  assert.equal(f.stats.invoke, 1);
  const fallback = row.fallback_json;
  release();
  await settle();
  await settle();
  assert.equal(
    f.store.providerAttempts.get(result.inferenceRef).fallback_json,
    fallback,
  );
  assert.equal(
    f.store.providerAttempts.get(result.inferenceRef).late_ignored,
    1,
  );
  assert.doesNotThrow(() =>
    lateReport({ provider: "different", model: "different" }),
  );
  assert(f.budget.status().blocked);
  assert.equal((await f.runner.propose(f.context)).origin, "rules");
  assert.equal(f.stats.invoke, 1);
});

test("malformed, rejected and unavailable model attempts record bounded failures and select deterministic rules", async (t) => {
  const cases = [
    [
      "schema_invalid",
      async (c, input) => {
        identityReport(c);
        return { ...modelProposal(input), usage: { chargedMicro: 0 } };
      },
    ],
    [
      "policy_rejected",
      async (c, input) => {
        identityReport(c);
        return {
          ...modelProposal(input),
          action: { type: "adjust_price", item_id: "crystal", unit_price: "1" },
        };
      },
    ],
    [
      "definitive_provider_failure",
      async () => {
        throw new DefinitiveProviderFailure("controlled definitive failure");
      },
    ],
    [
      "provider_or_admission_unavailable",
      async () => {
        throw Error("controlled provider outage");
      },
    ],
  ];
  for (const [code, invoke] of cases) {
    const f = await providerFixture(t, { invoke }),
      result = await f.runner.propose(f.context),
      row = f.store.providerAttempts.get(result.inferenceRef);
    assert.equal(result.origin, "rules");
    assert.equal(row.code, code);
    assert.equal(row.proposal_json, null);
    assert(row.fallback_json);
    assert.equal(f.budget.status().dailyMicro, 1000);
  }
});

test("mismatched or unreported model identity invalidates shared usage continuity without refunding reservations", async (t) => {
  for (const wrong of [true, false]) {
    const f = await providerFixture(t, {
      invoke: async (c, input) => {
        if (wrong)
          c.reportIdentity({ provider: "fixture", model: "wrong-model" });
        return modelProposal(input);
      },
    });
    const result = await f.runner.propose(f.context);
    assert.equal(result.origin, "rules");
    assert(f.budget.status().blocked);
    assert.equal(
      f.store.providerAttempts.get(result.inferenceRef).code,
      wrong ? "model_identity_mismatch" : "model_identity_unverified",
    );
    assert.equal(f.budget.status().dailyMicro, 1000);
  }
});

test("missing configuration, wrong budget binding and unverified history never dispatch a provider", async (t) => {
  for (const [options, code] of [
    [{ noProvider: true }, "provider_not_configured"],
    [{ binding: { ledgerId: "unapproved-ledger" } }, "budget_binding_mismatch"],
    [{ unverified: true }, "budget_history_unverified"],
  ]) {
    const f = await providerFixture(t, options),
      result = await f.runner.propose(f.context);
    assert.equal(result.origin, "rules");
    assert.equal(f.stats.invoke, 0);
    assert.equal(f.store.providerAttempts.get(result.inferenceRef).code, code);
    assert.equal(f.budget.history().entries.length, 0);
  }
});

test("full-payload token/output/pricing bounds apply before dispatch and remain owner-verified configuration", async (t) => {
  for (const changes of [
    { countTokens: () => 4097 },
    { maxOutputTokens: 1024 },
    { payload: "x".repeat(65537) },
    { worstInputMicroPerMillion: 1000000001 },
    { verifiedUntil: 1 },
    { model: "unexpected" },
  ]) {
    const f = await providerFixture(t, { prepared: changes }),
      result = await f.runner.propose(f.context);
    assert.equal(result.origin, "rules");
    assert.equal(f.stats.invoke, 0);
    assert.equal(f.budget.history().entries.length, 0);
  }
});

test("concurrent and restarted service instances reuse the cached request; changed contexts wait instead of recalling the model", async (t) => {
  let release;
  const f = await providerFixture(t, {
    invoke: (c, input) => {
      identityReport(c);
      return new Promise((resolve) => {
        release = () => resolve(modelProposal(input));
      });
    },
  });
  const a = f.runner.propose(f.context),
    b = f.runner.propose(f.context);
  assert.equal(a, b);
  await settle();
  release();
  assert.equal((await a).origin, "model_proposal");
  await b;
  assert.equal(f.stats.invoke, 1);
  const again = new LivingTownProviderRunner(
    f.store,
    f.policy,
    f.budget,
    f.binding,
    f.configuration,
    async () => true,
  );
  assert.equal((await again.propose(f.context)).origin, "model_proposal");
  assert.equal(f.stats.invoke, 1);
  f.state.town.market_revision = f.state.town.event_sequence = (
    BigInt(f.state.town.market_revision) + 1n
  ).toString();
  const context = { ...f.context, facts: await f.collect() },
    changed = await again.propose(context);
  assert.equal(changed.origin, "rules");
  assert.equal(changed.proposal.action.type, "wait");
  assert.equal(f.stats.invoke, 1);
  assert.equal(f.budget.history().entries.length, 1);
});

test("restart of a dispatched provider attempt preserves its charge and never retries uncertain inference", async (t) => {
  let reopened, release;
  const f = await providerFixture(t, {
    extraCleanup: () => reopened?.close(),
    invoke: (c, input) => {
      identityReport(c);
      return new Promise((resolve) => {
        release = () => resolve(modelProposal(input));
      });
    },
  });
  const old = f.runner.propose(f.context).catch((error) => error);
  await settle();
  const id = f.runner.requestId(f.context);
  assert.equal(f.store.providerAttempts.get(id).status, "dispatched");
  f.save();
  f.close();
  reopened = await adapterFixture(f.dir);
  await reopened.simulation.runtime.recover();
  const context = { ...f.context, facts: await reopened.collect() },
    runner = new LivingTownProviderRunner(
      reopened.store,
      reopened.policy,
      f.budget,
      f.binding,
      f.configuration,
      async () => true,
    );
  const result = await runner.propose(context);
  assert.equal(result.origin, "rules");
  assert.equal(
    reopened.store.providerAttempts.get(id).code,
    "recovered_unknown_attempt",
  );
  assert.equal(f.stats.invoke, 1);
  assert.equal(f.budget.status().dailyMicro, 1000);
  release();
  await old;
  assert.equal(reopened.store.providerAttempts.get(id).status, "fallback");
});

test("a fault after budget reservation cannot grant a free retry; only authoritative billing can reduce the charge", async (t) => {
  const f = await providerFixture(t),
    original = f.store.providerAttempts.transition.bind(
      f.store.providerAttempts,
    );
  f.store.providerAttempts.transition = (id, status, ...args) => {
    if (status === "reserved") throw Error("controlled audit write failure");
    return original(id, status, ...args);
  };
  const result = await f.runner.propose(f.context);
  assert.equal(result.origin, "rules");
  assert.equal(f.stats.invoke, 0);
  assert.equal(f.budget.status().dailyMicro, 1000);
  f.store.providerAttempts.transition = original;
  await f.runner.propose(f.context);
  assert.equal(f.stats.invoke, 0);
  assert.equal(f.budget.history().entries.length, 1);
  f.budget.account(
    result.inferenceRef,
    "fixture",
    "fixture-model",
    250,
    "fixture:authoritative-billing",
  );
  assert.equal(f.budget.status().dailyMicro, 250);
});

test("fallback provenance and failed-attempt correlation survive into actual shared execution decisions", async (t) => {
  const f = await providerFixture(t, {
    invoke: async () => {
      throw new DefinitiveProviderFailure("controlled failure");
    },
  });
  assert.equal((await f.simulation.poll()).kind, "advanced");
  const row = f.store.unresolved()[0],
    decision = JSON.parse(f.store.get(row.id).decision_json);
  assert.equal(decision.origin, "rules");
  assert.equal(decision.inferenceRef, f.runner.requestId(f.context));
  assert.equal(
    f.store.providerAttempts.get(decision.inferenceRef).code,
    "definitive_provider_failure",
  );
  assert.equal(f.runtimeStats.sign, 1);
  assert.equal(f.runtimeStats.send, 1);
});

test("cancelled, stale and hanging preflight checks wait without invoking or charging a provider", async (t) => {
  const f = await providerFixture(t),
    abort = new AbortController();
  abort.abort();
  const cancelled = await f.runner.propose(f.context, { signal: abort.signal });
  assert.equal(cancelled.proposal.action.type, "wait");
  assert.equal(f.stats.invoke, 0);
  assert.equal(f.budget.history().entries.length, 0);
  for (const isCurrent of [async () => false, () => new Promise(() => {})]) {
    const g = await providerFixture(t, { isCurrent, timeoutMs: 50 }),
      r = await g.runner.propose(g.context);
    assert.equal(r.origin, "rules");
    assert.equal(g.stats.invoke, 0);
    assert.equal(g.budget.history().entries.length, 0);
  }
});

test("clock drift blocks shared accounting and cannot be self-reconciled to create another allowance", async (t) => {
  let wall = Date.now(),
    clock;
  const f = await providerFixture(t, {
    makeClock: (budget) =>
      (clock = new SafetyClock(
        () => budget.invalidate("fixture:clock-drift"),
        () => wall,
        () => 0,
      )),
  });
  wall -= 10000;
  const result = await f.runner.propose(f.context);
  assert.equal(result.origin, "rules");
  assert.equal(result.proposal.action.type, "wait");
  assert.equal(
    f.store.providerAttempts.get(result.inferenceRef).code,
    "clock_unavailable",
  );
  assert(f.budget.status().blocked);
  assert.throws(() => f.runner.resumeClock(), /recovery/);
  assert.equal(f.stats.invoke, 0);
  wall = Date.now();
  f.budget.reconcile({
    ...f.budget.context(),
    fencing: "verified",
    history: "accounted",
    evidenceRef: "fixture:clock-restored",
  });
  f.runner.resumeClock();
  assert.equal(clock.now(), wall);
  assert.equal(f.budget.history().entries.length, 0);
});
