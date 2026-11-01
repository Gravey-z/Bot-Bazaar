import { buildMerchantPrompt } from "../dist/private/prompts/merchant-prompt.js";
import { captured } from "./chain-fixture.mjs";
export const dropActivity =
  "DROP TRIGGER activity_inference_insert;DROP TRIGGER activity_inference_update;DROP TRIGGER activity_decision;DROP TRIGGER activity_intent_insert;DROP TRIGGER activity_intent_update;DROP TRIGGER activity_attempt_insert;DROP TRIGGER activity_attempt_update;DROP TABLE activity_queue;DROP TABLE activity_projection;DROP TABLE activity_keys;DROP TABLE activity_events;DROP TABLE activity_state;";
export const dropInference = dropActivity + "DROP TABLE inference_records;";
export const dropPolicy =
  dropInference +
  "DROP TABLE policy_steps;DROP TABLE policy_plans;DROP TABLE policy_commitments;DROP TABLE policy_rejections;DROP TABLE inference_usage;DROP TABLE usage_state;DROP INDEX one_root_listing;ALTER TABLE scheduler_mutations DROP COLUMN purpose;CREATE UNIQUE INDEX one_root_listing ON scheduler_mutations(job_id,merchant_id) WHERE method='set_listing';";
export function inferenceFixture(store) {
  store.budget.configure({
    projectId: "fixture",
    laneId: "public",
    portions: [{ laneId: "public", dailyMicro: 500000, monthlyMicro: 5000000 }],
  });
  store.budget.reconcile({
    ...store.budget.context(),
    fencing: "verified",
    history: "accounted",
    evidenceRef: "unit:fixture-history",
  });
  return {
    prepare: (request) => ({
      payload: JSON.stringify({
        model: request.model,
        messages: fixtureMessages(store),
        max_output_tokens: 512,
      }),
      provider: request.provider,
      model: request.model,
      maxOutputTokens: 512,
      countTokens: () => 100,
      accountingEvidence: "unit:tokenizer",
      worstInputMicroPerMillion: 100000,
      outputMicroPerMillion: 500000,
      pricingEvidence: "unit:fixture-rates",
      verifiedUntil: Date.now() + 60000,
    }),
  };
}

function fixtureMessages(store) {
  const now = Date.now(),
    market = structuredClone(captured.seed.market),
    state = store.discoveryState() ?? {
      block: {
        hash: captured.seed.finalized_block.hash,
        height: market.block_height,
        timestampNs: market.block_timestamp_ns,
      },
      market,
      offers: [],
      trades: [],
      tradeCursor: "0",
      mode: "initial",
      observedAt: now,
    };
  const copy = structuredClone(state);
  copy.observedAt = now;
  return buildMerchantPrompt(
    copy,
    {
      merchantId: "rex",
      phase: "decision",
      rootDeadline: now + 120000,
      modelCallsRemaining: 6,
      mutationsRemaining: 8,
      rexShortageMode: true,
      commitments: [],
      rejectedOfferIds: [],
    },
    now,
  ).messages;
}
