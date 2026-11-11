import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createLivingTownCall,
  livingTownIndexedReceipt,
  livingTownRawTrade,
  verifyLivingTownReceipt,
} from "../../packages/chain/dist/index.js";

const capture = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-merchant-trading-sandbox.json",
    "utf8",
  ),
);
const indexed = await Promise.all(
  capture.steps.map(async (step) => {
    const proof = {
      transactionHash: step.transaction_hash,
      signerId: step.signer_id,
      deployment: step.foundation.deployment,
      call: createLivingTownCall(step.method, step.args),
      referenceBlockHeight: step.reference_block_height,
    };
    const status = await verifyLivingTownReceipt(
      step.receipt,
      proof,
      async (hash) => {
        assert.equal(hash, step.block.header.hash);
        return {
          hash,
          height: String(step.block.header.height),
          timestampNs: step.block.header.timestamp_nanosec,
        };
      },
    );
    assert.equal(status.kind, "succeeded", step.method);
    return livingTownIndexedReceipt(proof, { status, response: step.receipt });
  }),
);

test("actual WASM peer purchase receipts bind controller, quote, conserved balances and replay", () => {
  const first = indexed[0].status.result.data;
  const last = indexed[5].status.result.data;
  assert.equal(first.principal, "merchant:luna");
  assert.equal(first.outcome.trade.buyer.kind, "merchant");
  assert.equal(first.outcome.trade.seller.merchant_id, "rex");
  assert.equal(first.outcome.buyer.inventory.held.crystal, "2");
  assert.equal(first.outcome.seller.inventory.held.crystal, "8");
  assert.equal(
    BigInt(first.outcome.buyer.gold.held) +
      BigInt(first.outcome.seller.gold.held),
    400n,
  );
  assert.equal(indexed[1].status.result.data.replayed, true);
  assert.equal(indexed[1].event, null);
  assert.equal(last.principal, "merchant:rex");
  assert.equal(last.outcome.trade.seller.merchant_id, "luna");
  assert.equal(last.outcome.buyer.inventory.held.crystal, "4");
  assert.equal(last.outcome.seller.inventory.held.crystal, "0");
  assert.equal(last.outcome.seller.gold.held, "202");
  assert.equal(capture.after.data.totals.supplied_items.crystal, "0");
  for (const step of capture.steps.filter(
    (s) => s.method === "merchant_purchase",
  )) {
    const burnt =
      BigInt(step.receipt.transaction_outcome.outcome.gas_burnt) +
      step.receipt.receipts_outcome.reduce(
        (sum, r) => sum + BigInt(r.outcome.gas_burnt),
        0n,
      );
    assert(
      burnt < 30_000_000_000_000n,
      "peer purchase fits the runtime's gas allocation",
    );
  }
});

test("merchant trade decoding rejects self-dealing, oversized backups and mismatched principals", () => {
  const trade = structuredClone(indexed[0].status.result.data.outcome.trade);
  assert.throws(() => livingTownRawTrade({ ...trade, buyer: trade.seller }));
  assert.throws(() =>
    livingTownRawTrade({
      ...trade,
      command_principal: "account:spoof.testnet",
    }),
  );
  assert.throws(() =>
    livingTownRawTrade({
      ...trade,
      quantity: "3",
      total_price: String(BigInt(trade.unit_price) * 3n),
    }),
  );
});
