import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import {
  MarketClient,
  createRpcTransport,
  verifyFinalReceipt,
} from "../packages/chain/dist/index.js";

// Public reads only: no credentials, signing or transaction submission.
const [outputPath] = process.argv.slice(2);
assert.ok(
  outputPath && process.argv.length === 3,
  "Usage: node scripts/verify-chain-adapter.mjs <new-evidence.json>",
);
const fixture = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/chain/market.json", import.meta.url),
    "utf8",
  ),
);
const rpcUrl = "https://test.rpc.fastnear.com";
const rpc = createRpcTransport(rpcUrl);
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
const { reader, market } = await new MarketClient(
  identity.contractId,
  rpc,
).verifyDeployment(identity);
const page = {
  after_id: null,
  limit: "50",
  expected_revision: market.market_revision,
};
const [player, merchant, offer, offers, trades] = await Promise.all([
  reader.getPlayer("player-bazaar.testnet"),
  reader.getMerchant("rex"),
  reader.getOffer("1"),
  reader.getOffersForMerchant("luna", "all", page),
  reader.getRecentTrades(page),
]);
const transactions = [];
for (const step of fixture.steps) {
  const proof = {
    transactionHash: step.transaction_hash,
    signerId: step.caller,
    publicKey: step.signer_public_key,
    contractId: identity.contractId,
    nonce: String(step.receipt.transaction.nonce),
    gas: "30000000000000",
    method: step.method,
    args: step.args,
    ...(step.method === "propose_trade"
      ? { merchantId: "rex" }
      : step.method === "accept_trade"
        ? { merchantId: "luna" }
        : {}),
  };
  const receipt = await rpc("tx", {
    tx_hash: proof.transactionHash,
    sender_account_id: proof.signerId,
    wait_until: "NONE",
  });
  const status = await verifyFinalReceipt(receipt, proof);
  assert.equal(
    status.kind,
    "succeeded",
    `Expected finalized success: ${step.method}`,
  );
  assert.deepEqual(status.result, step.result);
  transactions.push({ method: step.method, ...status });
}
const evidence = {
  captured_at: new Date().toISOString(),
  mode: "read-only",
  rpc_url: rpcUrl,
  identity,
  finalized_block: reader.block,
  views: { market, player, merchant, offer, offers, trades },
  transactions,
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  flag: "wx",
});
console.log(
  `Verified deployment, six typed views and ${transactions.length} finalized transactions at block ${reader.block.height}.`,
);
console.log(`Evidence: ${outputPath}`);
