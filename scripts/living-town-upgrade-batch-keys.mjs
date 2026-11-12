import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { load, save, near, demoRpc, result, sendDemoTransaction } from "./living-town-demo-deployment.mjs";
import { LivingTownClient, createRpcTransport, canonicalLivingTownJson } from "../packages/chain/dist/index.js";
import { parseTownRuntimeConfig } from "../apps/worker/dist/private/living-town/runtime-config.js";
import { LivingTownExecutionStore } from "../apps/worker/dist/private/living-town/execution-store.js";
import { RuntimeFacts } from "../apps/worker/dist/private/living-town/runtime-facts.js";
import { RuntimeBudget } from "../apps/worker/dist/private/living-town/runtime-budget.js";
import { RuntimeOwner } from "../apps/worker/dist/private/living-town/runtime-owner.js";
import { assertRuntimePermission, townBatchNegotiatingMerchantMethods } from "../apps/worker/dist/private/near-signer.js";

// Run offline with the original execution lock and witness held throughout.
const root = resolve(import.meta.dirname, "..");
const config = parseTownRuntimeConfig(await load(join(root, "data/living-town-runtime.dev-ai.local.json")));
const directory = join(root, "data/upgrades/2026-11-11-batch-listings");
const plan = { rpc_url: config.public.rpcUrl, private_dir: join(directory, "private"), public_dir: join(directory, "public") };
const store = new LivingTownExecutionStore(config.executionDir, config.identity, config.seed, false, true);
const facts = new RuntimeFacts(config.executionDir, config.identity, false);
const budget = new RuntimeBudget(config.provider.budgetDir, config.provider.budgetWitnessDir);
const owner = new RuntimeOwner(store, facts, config.witnessDir,
  Object.fromEntries(Object.entries(config.keys).map(([lane, key]) => [lane, key.publicKey])), false, budget);
try {
  owner.verify();
  assert.equal(store.unresolved().length, 0, "Recover original transactions before changing key permissions");
  const client = new LivingTownClient(config.identity, createRpcTransport(config.public.rpcUrl));
  assert((await (await client.finalized()).getFoundation()).data.supported_methods.includes("batch_set_listings"));
  const rpc = demoRpc(plan);
  for (const lane of ["rex", "luna", "bolt"]) {
    const credential = await load(join(root, `data/phase7-demo/private/${lane}.json`));
    assert.equal(credential.account_id, config.identity.controllers[lane]);
    const publicKey = config.keys[lane].publicKey;
    const lookup = () => result(rpc, "query", { request_type: "view_access_key", account_id: credential.account_id,
      public_key: publicKey, finality: "final" });
    const before = await lookup();
    const batched = before.permission?.FunctionCall?.method_names.includes("batch_set_listings");
    assertRuntimePermission(before.permission, config.public.contractId,
      batched ? "town_batch_negotiating_merchant" : "town_negotiating_merchant");
    if (!batched) {
      await save(join(directory, `public/${lane}-key-before.json`), { publicKey, ...before });
      await sendDemoTransaction(plan, `batch-${lane}-key`, credential, credential.account_id, [
        near.actions.deleteKey(near.PublicKey.from(publicKey)),
        near.actions.addFunctionCallAccessKey(near.PublicKey.from(publicKey), config.public.contractId,
          [...townBatchNegotiatingMerchantMethods], BigInt(before.permission.FunctionCall.allowance)),
      ], `Enable atomic listing batches for ${lane}; preserve public key, receiver and remaining allowance`);
    }
    const after = await lookup();
    assertRuntimePermission(after.permission, config.public.contractId, "town_batch_negotiating_merchant");
    await save(join(directory, `public/${lane}-key-after.json`), { publicKey, ...after });
    console.log(JSON.stringify({ merchant: lane, batching: true }));
  }
  store.enableBatchListings();
  owner.verify();
  const manifestFile = join(root, "config/living-town-runtime-public.json");
  const manifest = await load(manifestFile);
  assert.equal(canonicalLivingTownJson(manifest.identity), canonicalLivingTownJson(config.identity));
  for (const lane of ["rex", "luna", "bolt"]) {
    assert.equal(manifest.keys[lane].public_key, config.keys[lane].publicKey);
    manifest.keys[lane].method_names = [...townBatchNegotiatingMerchantMethods];
  }
  await save(manifestFile, manifest);
  console.log("Batch permissions and witnessed execution schema are ready.");
} finally { owner.close(); budget.close(); facts.close(); store.close(); }
