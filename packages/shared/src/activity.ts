import type { MerchantId, Resource } from "./index.js";
export type ActivitySource = "model" | "policy" | "chain" | "system";
export type ActivityStatus =
  | "thinking"
  | "proposed"
  | "rejected"
  | "held"
  | "prepared"
  | "signed"
  | "submitted"
  | "confirmed"
  | "failed"
  | "unknown"
  | "expired"
  | "paused"
  | "resumed"
  | "observed";
export interface PublicDeployment {
  id: string;
  network_id: "testnet";
  contract_id: string;
  expected_code_hash: string;
  identity_kind: "configured";
}
export interface PublicChainObservation {
  block_height: string | null;
  block_hash: string | null;
  market_revision: string | null;
  observed_at: number | null;
  age_ms: number | null;
  stale: boolean;
  paused: boolean | null;
}
export interface PublicSelection {
  method: string;
  resource: Resource | null;
  buyer: MerchantId | null;
  seller: MerchantId | null;
  quantity: string | null;
  unit_price: string | null;
  total_price: string | null;
  offer_id: string | null;
}
export interface PublicTrade {
  trade_id: string;
  kind: "player_purchase" | "merchant_trade";
  buyer: MerchantId | null;
  seller: MerchantId;
  resource: Resource;
  quantity: string;
  unit_price: string;
  total_price: string;
  settled_at_ns: string;
}
export interface PublicListing {
  merchant_id: MerchantId;
  resource: Resource;
  quantity: string;
  unit_price: string;
  active: boolean;
  version: string;
}
export interface PublicTransaction {
  signed_hash: string | null;
  receipt_hash: string | null;
  explorer_url: string | null;
  evidence: "signed" | "receipt" | "action_checkpoint" | "unavailable";
  evidence_incomplete: boolean;
}
export interface PublicActivityEntry {
  sequence: string;
  id: string;
  domain_key: string;
  source: ActivitySource;
  status: ActivityStatus;
  phase:
    | "inference"
    | "selection"
    | "validation"
    | "transaction"
    | "trade"
    | "offer"
    | "market";
  observed_at: number;
  merchant_id: MerchantId | null;
  root_id: string | null;
  decision_id: string | null;
  intent_id: string | null;
  action_id: string | null;
  offer_id: string | null;
  trade_id: string | null;
  reason: string | null;
  reason_kind: "model" | "status" | null;
  code: string | null;
  method: string | null;
  selection: PublicSelection | null;
  trade: PublicTrade | null;
  listing: PublicListing | null;
  transaction: PublicTransaction | null;
  block: {
    height: string;
    hash: string | null;
    timestamp_ns: string;
    market_revision: string;
  } | null;
  late_ignored: boolean;
  live_ai_evidence: false;
}
export interface ActivityPage {
  api_version: "1";
  deployment: PublicDeployment;
  feed_generation: string;
  captured_at: number;
  heartbeat_at: number;
  chain: PublicChainObservation;
  entries: PublicActivityEntry[];
  next_after: string;
  has_more: boolean;
  history_gap: boolean;
  high_water_sequence: string;
  pruned_through: string;
}
export interface PublicAiStatus {
  status:
    | "unavailable"
    | "pending"
    | "response_received"
    | "validation_error"
    | "diagnostic";
  label: string;
  code: string;
  observedAt: number | null;
  currentSession: boolean;
}
export interface PublicAiAvailability extends PublicAiStatus {
  mode: "disabled" | "unconfigured" | "provider" | "diagnostic";
  liveAiEvidence: false;
  lastInference: PublicAiStatus | null;
  lastAdmission: PublicAiStatus | null;
}
export interface PublicHealth {
  status: "not_ready" | "ready";
  api_version: "1";
  worker_version: string;
  policy_version: string | null;
  database: "ready" | "unavailable";
  recovery: "required" | "reconciled";
  backup: "verified" | "failed";
  discovery: "starting" | "ready" | "unavailable" | "stopped" | "disabled";
  scheduling: "ready" | "unavailable" | "waiting_for_recovery";
  ai: PublicAiAvailability;
  deployment: PublicDeployment;
  feed_generation: string | null;
  captured_at: number;
  heartbeat_at: number;
  chain: PublicChainObservation;
  activity: { high_water_sequence: string; pruned_through: string } | null;
}
