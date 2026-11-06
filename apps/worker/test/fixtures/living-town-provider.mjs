import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  adapterFixture,
  closeAdapterFixturesAt,
} from "./living-town-adapter.mjs";
import { configureJournal } from "../../dist/private/storage/journal.js";
import { policySchema } from "../../dist/private/storage/schema.js";
import { BudgetRepository } from "../../dist/private/policy/budget.js";
import { LivingTownProviderRunner } from "../../dist/private/living-town/provider.js";
import { townProposalSchema } from "../../dist/private/living-town/proposals.js";

export function prepared(context, extra = {}) {
  return {
    provider: "fixture",
    model: "fixture-model",
    payload: JSON.stringify({
      model: "fixture-model",
      messages: [
        {
          role: "system",
          content:
            "Controlled provider fixture. Proposals never grant transaction authority.",
        },
        {
          role: "user",
          content: JSON.stringify({
            tickId: context.tickId,
            merchant: context.merchant,
            revision: context.facts.town.market_revision,
          }),
        },
      ],
      response_format: { type: "json_schema", schema: townProposalSchema },
      max_output_tokens: 512,
    }),
    maxOutputTokens: 512,
    countTokens: () => 100,
    accountingEvidence: "fixture:count",
    worstInputMicroPerMillion: 100000,
    outputMicroPerMillion: 100000,
    pricingEvidence: "fixture:pricing",
    verifiedUntil: Date.now() + 60000,
    ...extra,
  };
}
export const modelProposal = (c) => ({
  schema: "living-town-proposal-v1",
  tick_id: c.tickId,
  market_revision: c.facts.town.market_revision,
  merchant_id: c.merchant,
  reason: "controlled model proposal",
  action: { type: "wait" },
});

// One real shared BudgetRepository; V1/rehearsal reservations use this same object and SQL ledger.
export async function providerFixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-town-provider-"));
  let db, f;
  t.after(() => {
    closeAdapterFixturesAt(dir);
    db?.close();
    if (options.extraCleanup) options.extraCleanup();
    assertDirectory();
    rmSync(dir, { recursive: true, force: true });
  });
  function assertDirectory() {
    if (!dir.startsWith(join(tmpdir(), "bazaar-town-provider-")))
      throw Error("unsafe fixture cleanup");
  }
  let runner;
  f = await adapterFixture(dir, {
    propose: (context) => runner.propose(context),
  });
  const e = f.state.town.data.epoch;
  for (const k of Object.keys(f.state.markers.raw_epochs))
    f.state.markers.raw_epochs[k] = e;
  for (const k of Object.keys(f.state.markers.treasury_epochs))
    f.state.markers.treasury_epochs[k] = e;
  db = new DatabaseSync(join(dir, "shared-budget.sqlite"));
  configureJournal(db, true);
  db.exec(
    policySchema.slice(0, policySchema.indexOf("CREATE TABLE policy_plans")),
  );
  const write = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const budget = new BudgetRepository(
    db,
    write,
    () => "shared-owner-session",
    "original-project-authority",
  );
  budget.configure({
    projectId: "bot-bazaar",
    laneId: "shared",
    portions: [{ laneId: "shared", dailyMicro: 500000, monthlyMicro: 5000000 }],
  });
  if (!options.unverified)
    budget.reconcile({
      ...budget.context(),
      fencing: "verified",
      history: "accounted",
      evidenceRef: "controlled-fixture",
    });
  const binding = {
    projectId: "bot-bazaar",
    laneId: "shared",
    ledgerId: budget.context().ledgerId,
  };
  const stats = { invoke: 0, payload: null },
    configuration = {
      provider: "fixture",
      model: "fixture-model",
      promptVersion: "town-provider-v1",
      prepare: (context) => {
        stats.context = structuredClone(context);
        return prepared(context, options.prepared ?? {});
      },
      invoke: async (context) => {
        stats.invoke++;
        stats.payload = context.payload;
        return options.invoke
          ? options.invoke(context, stats.context)
          : (context.reportIdentity({
              provider: "fixture",
              model: "fixture-model",
            }),
            modelProposal(stats.context));
      },
    };
  const current = async (c) =>
    f.store.ticks.active()?.id === c.tickId &&
    f.state.town.market_revision === c.facts.town.market_revision;
  runner = new LivingTownProviderRunner(
    f.store,
    f.policy,
    options.noProvider ? null : budget,
    options.noProvider ? null : { ...binding, ...options.binding },
    options.noProvider ? null : configuration,
    options.isCurrent ?? current,
    options.timeoutMs ?? 1000,
    options.fallbackMode ?? "policy",
    options.makeClock ? options.makeClock(budget) : options.clock,
  );
  await f.simulation.runtime.recover();
  const reader = await f.adapters.operator.client.finalized(),
    slot = (
      (BigInt(f.state.town.block_timestamp_ns) -
        BigInt(f.state.town.data.genesis_time_ns)) /
      30000000000n
    ).toString();
  const tick = await f.scheduler.prepare(reader, [
    { id: "c".repeat(64), arrival: `merchant:rex:${slot}` },
    { id: "d".repeat(64), arrival: `merchant:luna:${slot}` },
    { id: "e".repeat(64), arrival: `merchant:bolt:${slot}` },
  ]);
  const context = {
    tickId: tick.id,
    merchant: "rex",
    facts: await f.collect(),
    schemaVersion: "living-town-proposal-v1",
  };
  return {
    ...f,
    dir,
    budget,
    binding,
    configuration,
    runner,
    stats,
    runtimeStats: f.stats,
    context,
  };
}
