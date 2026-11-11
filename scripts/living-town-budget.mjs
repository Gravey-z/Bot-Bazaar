import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { RuntimeBudget } from "../apps/worker/dist/private/living-town/runtime-budget.js";
const args = process.argv.slice(2);
assert(
  args.length === 3 &&
    args[0] === "--config" &&
    isAbsolute(args[1]) &&
    args[2] === "--use-hackathon-budget",
  "Use --config <absolute-ai-config> --use-hackathon-budget",
);
const config = JSON.parse(await readFile(args[1], "utf8"));
assert.equal(config.provider.kind, "near-ai");
assert.equal(
  JSON.parse(await readFile(config.control_file, "utf8")).mode,
  "paused",
  "Pause the signing runtime before revising its budget",
);
const authority = new RuntimeBudget(
  config.provider.budget_dir,
  config.provider.budget_witness_dir,
);
try {
  const before = authority.budget.history(),
    identity = authority.binding;
  authority.useHackathonBudget();
  const after = authority.budget.history();
  assert.deepEqual(before.entries, after.entries);
  assert.deepEqual(authority.binding, identity);
  const evidence = {
    captured_at: new Date().toISOString(),
    authorization:
      "Owner authorized full $10 hackathon credit with spending spread across days",
    ledger_id: identity.ledgerId,
    previous_allocation: before.config,
    new_allocation: after.config,
    total_hackathon_limit_micro: 10000000,
    rolling_24_hour_limit_micro: 2000000,
    usage_entries_preserved: after.entries.length,
    budget: authority.budget.status(),
    inference_calls: 0,
    control: "paused",
  };
  await writeFile(
    "data/hackathon-budget-change.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} finally {
  authority.close();
}
