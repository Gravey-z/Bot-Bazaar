import {
  LivingTownClient,
  createRpcTransport,
} from "../packages/chain/dist/index.js";
import { readBoundedFile } from "../apps/worker/dist/private/living-town/config.js";
import { parseTownRuntimeConfig } from "../apps/worker/dist/private/living-town/runtime-config.js";
import { LivingTownExecutionStore } from "../apps/worker/dist/private/living-town/execution-store.js";
import { RuntimeFacts } from "../apps/worker/dist/private/living-town/runtime-facts.js";
import { RuntimeOwner } from "../apps/worker/dist/private/living-town/runtime-owner.js";
import { readTownPrepared } from "../apps/worker/dist/private/living-town/town-chain.js";
import { verifyExpiredAllowanceRejection } from "../apps/worker/dist/private/living-town/admission-rejection.js";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--evidence")
  throw Error(
    "Usage: reconcile-admission --config <absolute-config> --evidence <absolute-original-rejection>",
  );
const config = parseTownRuntimeConfig(readBoundedFile(args[1], 32768));
const evidence = readBoundedFile(args[3], 8192);
const store = new LivingTownExecutionStore(
  config.executionDir,
  config.identity,
  config.seed,
);
const facts = new RuntimeFacts(config.executionDir, config.identity, false);
const owner = new RuntimeOwner(
  store,
  facts,
  config.witnessDir,
  Object.fromEntries(
    Object.entries(config.keys).map(([lane, key]) => [lane, key.publicKey]),
  ),
  false,
);
try {
  owner.verify();
  const rows = store.unresolved();
  if (
    rows.length !== 1 ||
    rows[0].method === "settle_customer_purchase" ||
    rows[0].method === "fund_customer_budget"
  )
    throw Error("Exactly one town admission failure required");
  const row = rows[0];
  const original = readTownPrepared(
    String(row.signed_json),
    config.identity,
    String(row.merchant_id),
  );
  const reader = await new LivingTownClient(
    config.identity,
    createRpcTransport(config.public.rpcUrl),
  ).finalized();
  const proof = await verifyExpiredAllowanceRejection(
    original,
    evidence,
    reader,
    String(row.merchant_id),
  );
  store.resolveRejectedAdmission(String(row.id), proof);
  console.log(
    JSON.stringify({
      transactionHash: original.transactionHash,
      kind: proof.kind,
      receiptConfirmed: false,
      signing: false,
      checkpoint: proof.checkpoint,
    }),
  );
} finally {
  owner.close();
  facts.close();
  store.close();
}
