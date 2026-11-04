import { readFile } from "node:fs/promises";
import { sanitizeReplayReceipt } from "../../scripts/replay-data.mjs";

// Controlled replay validation input, assembled from the P2.21 contract test
// receipts. The invented decisions below are NEVER genuine AI provenance.
export async function controlledReplay() {
  const fixture = JSON.parse(
    await readFile(new URL("./chain/market.json", import.meta.url), "utf8"),
  );
  const steps = fixture.steps;
  const point = (result, state, wallet, hash) => ({
    capturedAt: new Date(
      Number(BigInt(result.block_timestamp_ns) / 1000000n) + 1,
    ).toISOString(),
    block: {
      hash,
      height: result.block_height,
      timestampNs: result.block_timestamp_ns,
    },
    market: { ...result, data: structuredClone(state) },
    player: { ...result, data: structuredClone(wallet) },
  });
  const blockHash = (step) =>
    step.receipt.receipts_outcome.find(
      (r) =>
        r.id ===
        step.receipt.transaction_outcome.outcome.status.SuccessReceiptId,
    ).block_hash;
  const initial = structuredClone(fixture.seed.market.data);
  initial.registered_player_count = "1";
  initial.total_issued_gold = "650";
  const purchased = structuredClone(initial);
  purchased.next_trade_id = "2";
  purchased.merchants[0].gold = "228";
  purchased.merchants[0].inventory.crystal = "3";
  purchased.merchants[0].listings[0].quantity = "3";
  purchased.merchants[0].listings[0].version = "2";
  const wallet = {
    ...steps[0].result.data,
    gold: "52",
    inventory: { crystal: "12", wood: "0", herb: "0", iron: "0" },
  };
  const points = [
    point(steps[0].result, initial, steps[0].result.data, blockHash(steps[0])),
    point(steps[1].result, purchased, wallet, blockHash(steps[1])),
    point(
      steps[2].result,
      fixture.pending.market.data,
      wallet,
      blockHash(steps[2]),
    ),
    point(
      steps[3].result,
      fixture.final.market.data,
      wallet,
      blockHash(steps[3]),
    ),
  ];
  const actions = steps.slice(1).map((step, index) => ({
    id: `action-${index}`,
    source: index === 0 ? "player" : "model",
    merchantId: index === 0 ? null : index === 1 ? "rex" : "luna",
    decisionId: index === 0 ? null : `decision-${index}`,
    intentId: index === 0 ? null : `intent-${index}`,
    explorerUrl: `https://testnet.nearblocks.io/txns/${step.transaction_hash}`,
    receipt: sanitizeReplayReceipt(step.receipt),
  }));
  const decisions = steps.slice(2).map((step, index) => ({
    id: `decision-${index + 1}`,
    requestId: `request-${index + 1}`,
    merchantId: index === 0 ? "rex" : "luna",
    provider: "controlled-fixture",
    requestedModel: "controlled-test",
    returnedModel: "controlled-test",
    startedAt: new Date(
      Number(BigInt(step.result.block_timestamp_ns) / 1000000n) - 2000,
    ).toISOString(),
    returnedAt: new Date(
      Number(BigInt(step.result.block_timestamp_ns) / 1000000n) - 1000,
    ).toISOString(),
    policyOutcome: "allowed",
    explanation: "Scripted validation test data; no provider request.",
    action: { method: step.method, args: step.args },
    transactionId: `action-${index + 1}`,
  }));
  return {
    schema: "bot-bazaar-replay-v1",
    mode: "test_fixture",
    runId: "controlled-replay-validation",
    recordedFrom: new Date(Date.parse(points[0].capturedAt) - 1).toISOString(),
    recordedTo: new Date(
      Date.parse(points.at(-1).capturedAt) + 1000,
    ).toISOString(),
    identity: {
      networkId: "testnet",
      genesisHash: fixture.seed.finalized_block.hash,
      contractId: fixture.contract_id,
      codeHash: fixture.code_hash,
      controllers: {
        rex: "rex-bazaar.testnet",
        luna: "luna-bazaar.testnet",
        bolt: "bolt-bazaar.testnet",
      },
    },
    versions: {
      application: "controlled-test",
      contract: "controlled-test",
      policy: "v1",
      prompt: "1.1.0",
      decisionSchema: "merchant-decision-v1",
    },
    initialization: {
      transactionHash: fixture.seed.finalized_block.hash,
      blockHash: fixture.seed.finalized_block.hash,
    },
    playerId: steps[0].caller,
    checkpoints: points,
    actions,
    decisions,
    verification: {
      verifiedAt: "2026-10-31T00:00:00.000Z",
      scope: "clean_single_player",
      missingEvidence: [],
      interleaving: false,
      modelProvenance: "operator_recorded_not_cryptographic",
    },
    conservation: {
      seedGold: "550",
      playerIssuance: "100",
      totalGold: "650",
      resources: { crystal: "29", wood: "25", herb: "26", iron: "24" },
    },
  };
}
