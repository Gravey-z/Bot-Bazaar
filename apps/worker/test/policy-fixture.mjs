export const dropPolicy =
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
        messages: [{ role: "user", content: "test fixture" }],
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
