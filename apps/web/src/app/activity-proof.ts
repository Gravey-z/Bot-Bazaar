import { parsePublicConfig } from "@bot-bazaar/shared";
import type {
  PublicActivityEntry,
  PublicConfig,
  PublicTrade,
} from "@bot-bazaar/shared";
import { parseU64 } from "@bot-bazaar/chain";

export interface TransactionProof {
  readonly hash: string;
  readonly url: string;
  readonly label: string;
}

// Never accept a URL from a model, callback or worker projection.
export function transactionExplorer(
  config: PublicConfig,
  hash: unknown,
): string | null {
  try {
    const trusted = parsePublicConfig(config);
    if (typeof hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash))
      return null;
    return new URL(`txns/${hash}`, trusted.explorerUrl).href;
  } catch {
    return null;
  }
}

export function workerProof(
  entry: PublicActivityEntry,
  config?: PublicConfig,
): TransactionProof[] {
  const proof = entry.transaction;
  if (
    !config ||
    !proof ||
    proof.evidence === "action_checkpoint" ||
    proof.evidence === "unavailable"
  )
    return [];
  const hash = proof.signed_hash;
  const url = transactionExplorer(config, hash);
  if (!hash || !url) return [];
  const verified =
    entry.source === "chain" &&
    (entry.status === "confirmed" || entry.status === "failed") &&
    proof.evidence === "receipt" &&
    !proof.evidence_incomplete &&
    proof.receipt_hash === hash;
  return [
    {
      hash,
      url,
      label: verified
        ? `Worker verified ${entry.status === "failed" ? "failed" : "successful"} receipt · Testnet`
        : "Recorded transaction · finality unverified · Testnet",
    },
  ];
}

export function tradeDeltas(trade: PublicTrade): string[] {
  const quantity = BigInt(parseU64(trade.quantity));
  const unit = BigInt(parseU64(trade.unit_price));
  const total = BigInt(parseU64(trade.total_price));
  if (
    quantity < 1n ||
    quantity > 100n ||
    unit < 1n ||
    unit > 100n ||
    total !== quantity * unit
  )
    throw new Error("Invalid confirmed transfer terms");
  return [
    `${trade.buyer ?? "Player"}: +${quantity} ${trade.resource}, −${total} virtual gold`,
    `${trade.seller}: −${quantity} ${trade.resource}, +${total} virtual gold`,
  ];
}
