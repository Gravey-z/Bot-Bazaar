import type { MerchantId } from "@bot-bazaar/chain";

export interface RecoveryContext {
  sessionId: string;
  identityHash: string;
}
export interface ContinuityAttestation extends RecoveryContext {
  journal: "current" | "missing_interval";
  fencing: "verified" | "unverified";
  providerHistory: "accounted" | "unknown";
  evidenceRef: string;
  // Required only when adopting previously unknown merchant baselines.
  baselines?: Partial<
    Record<MerchantId, { actionId: string; digest: string | null }>
  >;
}
// Trusted operator/journal integration only; never a model, HTTP body or env flag.
export type ContinuityVerifier = (
  context: RecoveryContext,
) => Promise<ContinuityAttestation | undefined>;
export interface RecoveryReport {
  kind: "ready" | "blocked";
  reasons: string[];
  unresolved: number | null;
}
