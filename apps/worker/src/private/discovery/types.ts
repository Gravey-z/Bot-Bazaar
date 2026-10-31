import type {
  FinalizedBlock,
  MarketState,
  MerchantId,
  Offer,
  Snapshot,
  Trade,
} from "@bot-bazaar/chain";

export type DiscoverySignal =
  | { key: string; kind: "offer_pending"; merchantId: MerchantId; offer: Offer }
  | {
      key: string;
      kind: "player_purchase";
      merchantId: MerchantId;
      trade: Trade;
    }
  | {
      key: string;
      kind: "history_gap";
      merchantId: null;
      stream: "offers" | "trades";
      after: string | null;
      prunedThrough: string;
      upperBound: string;
    };

export interface DiscoveryState {
  block: FinalizedBlock;
  market: Snapshot<MarketState>;
  // A full retained offer scan, including effective-expired views.
  offers: Offer[];
  // Retained history on bootstrap/resync; new records on incremental passes.
  trades: Trade[];
  tradeCursor: string;
  mode: "initial" | "incremental" | "resync";
  observedAt: number;
}
export interface DiscoveryCommit {
  previousHash: string | null;
  state: DiscoveryState;
  signals: DiscoverySignal[];
}
