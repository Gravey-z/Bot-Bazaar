import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MarketClient,
  createRpcTransport,
} from "../packages/chain/dist/index.js";
import { WorkerStore } from "../apps/worker/dist/private/storage/database.js";
import { DiscoveryObserver } from "../apps/worker/dist/private/discovery/observer.js";
import { Scheduler } from "../apps/worker/dist/private/scheduling/scheduler.js";

// Read-only audit: public views/receipt only, no provider, keys or broadcast.
const [output] = process.argv.slice(2);
assert.ok(
  output && process.argv.length === 3,
  "Usage: node scripts/verify-worker-scheduling.mjs <new-evidence.json>",
);
const fixture = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/chain/market.json", import.meta.url),
    "utf8",
  ),
);
const identity = {
  networkId: "testnet",
  contractId: fixture.contract_id,
  ownerId: fixture.contract_id,
  codeHash: fixture.code_hash,
  controllers: {
    rex: "rex-bazaar.testnet",
    luna: "luna-bazaar.testnet",
    bolt: "bolt-bazaar.testnet",
  },
};
const dataDir = await mkdtemp(join(tmpdir(), "bazaar-scheduling-audit-"));
let store;
try {
  const options = { dataDir, identity, policyVersion: "v1", create: true };
  store = new WorkerStore(options);
  const rpc = createRpcTransport("https://test.rpc.fastnear.com");
  const observer = new DiscoveryObserver(
    new MarketClient(identity.contractId, rpc),
    store,
  );
  let scheduler = new Scheduler(store);
  const observation = await observer.poll();
  scheduler.tick();
  const step = fixture.steps.find((row) => row.method === "buy_from_merchant");
  const proof = {
    transactionHash: step.transaction_hash,
    signerId: step.caller,
    publicKey: step.signer_public_key,
    contractId: identity.contractId,
    nonce: String(step.receipt.transaction.nonce),
    gas: "30000000000000",
    method: step.method,
    args: step.args,
  };
  const receipt = await rpc("tx", {
    tx_hash: proof.transactionHash,
    sender_account_id: proof.signerId,
    wait_until: "NONE",
  });
  const rootId = await scheduler.observePurchaseReceipt(receipt, proof);
  await observer.poll();
  scheduler.tick();
  const rootBefore = store.scheduler
    .roots()
    .find((row) => row.job_id === rootId);
  assert.ok(rootBefore);
  assert.equal(rootBefore.model_calls, 0);
  assert.equal(rootBefore.mutations, 0);
  await store.close();
  store = new WorkerStore({ ...options, create: false });
  scheduler = new Scheduler(store);
  assert.equal(await scheduler.observePurchaseReceipt(receipt, proof), rootId);
  scheduler.tick();
  assert.equal(
    store.scheduler
      .inputs()
      .filter(
        (row) => row.business_key === `purchase:${step.result.data.trade_id}`,
      ).length,
    1,
  );
  assert.equal(store.checkpoint().recovery_required, 1);
  await writeFile(
    output,
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        mode: "read-only",
        identity,
        observed_block: observation.block,
        market_revision: observation.market.market_revision,
        receipt_hash: proof.transactionHash,
        root_id: rootId,
        roots: store.scheduler.roots(),
        inputs: store.scheduler.inputs().map(({ payload_json, ...row }) => ({
          ...row,
          payload_retained: payload_json !== null,
        })),
        scheduler_state: store.scheduler.state(),
        recovery_required: true,
        model_calls: 0,
        submissions: 0,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    "Verified view/receipt/restart deduplication of the existing purchase; zero model calls or submissions.",
  );
} finally {
  await store?.close();
  await rm(dataDir, { recursive: true, force: true });
}
