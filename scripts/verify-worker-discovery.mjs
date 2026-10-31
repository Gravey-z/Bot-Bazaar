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

// Read-only Testnet verification; no credentials, provider, signer or broadcast.
const [output] = process.argv.slice(2);
assert.ok(
  output && process.argv.length === 3,
  "Usage: node scripts/verify-worker-discovery.mjs <new-evidence.json>",
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
const dataDir = await mkdtemp(join(tmpdir(), "bazaar-discovery-audit-"));
let store;
try {
  store = new WorkerStore({
    dataDir,
    identity,
    policyVersion: "v1",
    create: true,
  });
  const requests = [];
  const rpc = createRpcTransport("https://test.rpc.fastnear.com");
  const client = new MarketClient(
    identity.contractId,
    async (method, params) => {
      assert.ok(["status", "block", "query"].includes(method));
      requests.push(method);
      return rpc(method, params);
    },
  );
  const observer = new DiscoveryObserver(client, store);
  const first = await observer.poll();
  const firstKeys = store
    .discoverySignals()
    .map((row) => row.key)
    .sort();
  const second = await observer.poll();
  const secondKeys = store
    .discoverySignals()
    .map((row) => row.key)
    .sort();
  // The public market can legitimately change between passes; otherwise identity is stable.
  if (first.market.market_revision === second.market.market_revision)
    assert.deepEqual(secondKeys, firstKeys);
  assert.equal(store.checkpoint().recovery_required, 1);
  assert.equal(store.jobs().length, 0);
  await writeFile(
    output,
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        mode: "read-only",
        identity,
        first,
        second,
        signal_keys: secondKeys,
        signals: store.discoverySignals(),
        rpc_requests: requests.length,
        workflow_jobs: 0,
        recovery_required: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  console.log(
    `Verified two discovery passes at revisions ${first.market.market_revision}/${second.market.market_revision}; ${secondKeys.length} stable inbox signals, no jobs or submissions.`,
  );
} finally {
  await store?.close();
  await rm(dataDir, { recursive: true, force: true });
}
