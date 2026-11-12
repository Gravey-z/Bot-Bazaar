import assert from "node:assert/strict";
import { mkdirSync, existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { parseTownRuntimeConfig } from "../apps/worker/dist/private/living-town/runtime-config.js";
import { LivingTownExecutionStore } from "../apps/worker/dist/private/living-town/execution-store.js";
import { RuntimeFacts } from "../apps/worker/dist/private/living-town/runtime-facts.js";
import { RuntimeOwner } from "../apps/worker/dist/private/living-town/runtime-owner.js";
import { RuntimeBudget } from "../apps/worker/dist/private/living-town/runtime-budget.js";

const root = resolve(import.meta.dirname, "..");
const config = parseTownRuntimeConfig(JSON.parse(readFileSync(resolve(process.argv[2] ?? "data/living-town-runtime.dev-ai.local.json"), "utf8")));
const directory = resolve(process.argv[3] ?? "data/upgrades/2026-11-12-independent-workers");
assert(directory.startsWith(join(root, "data") + sep), "Migration evidence must stay inside workspace data");
assert(!existsSync(directory), "Use a new migration backup directory");
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const [name, source] of [
  ["worker.sqlite", join(config.executionDir, "worker.sqlite")],
  ["facts.sqlite", join(config.executionDir, "facts.sqlite")],
  ["continuity.sqlite", join(config.witnessDir, "continuity.sqlite")],
]) {
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    await backup(db, join(directory, name));
    chmodSync(join(directory, name), 0o600);
  } finally { db.close(); }
}
const store = new LivingTownExecutionStore(config.executionDir, config.identity, config.seed, false, true);
const facts = new RuntimeFacts(config.executionDir, config.identity, false);
const budget = config.provider.kind === "near-ai" ? new RuntimeBudget(config.provider.budgetDir, config.provider.budgetWitnessDir) : undefined;
const owner = new RuntimeOwner(store, facts, config.witnessDir,
  Object.fromEntries(Object.entries(config.keys).map(([lane, key]) => [lane, key.publicKey])), false, budget);
try {
  owner.verify();
  assert.equal(store.unresolved().length, 0, "Recover original transactions before enabling independent workers");
  store.enableIndependentWorkers();
  owner.verify();
  writeFileSync(join(directory, "migration.json"), JSON.stringify({
    schema: "living-town-independent-workers-migration-v1", captured_at: Date.now(),
    contract: config.identity.deployment.contract_id, preservedTransactions: true,
    queue: store.maintenance.counts(), verifiedWitness: true,
  }, null, 2) + "\n", { mode: 0o600 });
  console.log("Independent worker queues enabled; original journals and continuity witness verified.");
} finally { owner.close(); budget?.close(); facts.close(); store.close(); }
