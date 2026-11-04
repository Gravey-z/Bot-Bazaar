import type { MerchantId } from "@bot-bazaar/shared";
import type { MarketState, Player, Snapshot } from "./wire.js";
import type { MarketCall } from "./calls.js";

export interface ReplayCheckpoint {
  capturedAt: string;
  block: { hash: string; height: string; timestampNs: string };
  market: Snapshot<MarketState>;
  player: Snapshot<Player>;
}
export interface ReplayReceipt {
  final_execution_status: "FINAL";
  transaction: {
    hash: string;
    signer_id: string;
    receiver_id: string;
    public_key: string;
    nonce: string;
    actions: {
      FunctionCall: {
        method_name: MarketCall["method"];
        args: string;
        gas: string;
        deposit: "0";
      };
    }[];
  };
  transaction_outcome: ReplayOutcome;
  receipts_outcome: ReplayOutcome[];
  status: { SuccessValue: string };
}
export interface ReplayOutcome {
  id: string;
  block_hash: string;
  outcome: {
    executor_id: string;
    receipt_ids: string[];
    status: { SuccessValue: string } | { SuccessReceiptId: string };
  };
}
export interface ReplayAction {
  id: string;
  source: "player" | "policy" | "model";
  merchantId: MerchantId | null;
  decisionId: string | null;
  intentId: string | null;
  explorerUrl: string;
  receipt: ReplayReceipt;
}
export interface ReplayDecision {
  id: string;
  requestId: string;
  merchantId: MerchantId;
  provider: "near-ai" | "controlled-fixture";
  requestedModel: string;
  returnedModel: string;
  startedAt: string;
  returnedAt: string;
  policyOutcome: "allowed";
  explanation: string;
  action: MarketCall;
  transactionId: string;
}
export interface Replay {
  schema: "bot-bazaar-replay-v1";
  mode: "historical_replay" | "test_fixture";
  runId: string;
  recordedFrom: string;
  recordedTo: string;
  identity: {
    networkId: "testnet";
    genesisHash: string;
    contractId: string;
    codeHash: string;
    controllers: Record<MerchantId, string>;
  };
  versions: {
    application: string;
    contract: string;
    policy: string;
    prompt: string;
    decisionSchema: string;
  };
  initialization: { transactionHash: string; blockHash: string };
  playerId: string;
  checkpoints: ReplayCheckpoint[];
  actions: ReplayAction[];
  decisions: ReplayDecision[];
  verification: {
    verifiedAt: string;
    scope: "clean_single_player";
    missingEvidence: [];
    interleaving: false;
    modelProvenance: "operator_recorded_not_cryptographic";
  };
  conservation: {
    seedGold: "550";
    playerIssuance: "100";
    totalGold: "650";
    resources: { crystal: "29"; wood: "25"; herb: "26"; iron: "24" };
  };
}
