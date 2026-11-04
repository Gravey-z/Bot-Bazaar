import type { MerchantId } from "@bot-bazaar/shared";
import type { MarketObservation, MarketViewState } from "./market-reader";
import type { ActivityFeedState } from "./activity-feed";

export interface ValueChange {
  readonly key: string;
  readonly merchant: MerchantId;
  readonly text: string;
}
const delta = (before: string, after: string): string => {
  const difference = BigInt(after) - BigInt(before);
  return difference > 0n ? `+${difference}` : `−${-difference}`;
};

// Feedback describes differences between accepted reads, not their cause.
export class SnapshotFeedback {
  private previous: MarketObservation | null = null;
  private cachedBeforeResume: MarketObservation | null = null;
  reset(cached: MarketObservation | null = null): void {
    this.previous = null;
    this.cachedBeforeResume = cached;
  }
  accept(state: MarketViewState): readonly ValueChange[] | null {
    if (state.status !== "ready" || !state.observation) {
      this.reset();
      return [];
    }
    const next = state.observation,
      old = this.previous;
    if (next === this.cachedBeforeResume) return null;
    this.cachedBeforeResume = null;
    if (
      old &&
      (BigInt(next.block.height) < BigInt(old.block.height) ||
        BigInt(next.market.market_revision) <
          BigInt(old.market.market_revision))
    )
      return [];
    if (
      old &&
      next.block.hash === old.block.hash &&
      old.market.data.contract_account_id ===
        next.market.data.contract_account_id
    )
      return null;
    this.previous = structuredClone(next);
    if (
      !old ||
      old.market.data.contract_account_id !==
        next.market.data.contract_account_id
    )
      return [];
    const changes: ValueChange[] = [];
    for (const merchant of next.market.data.merchants) {
      const before = old.market.data.merchants.find(
        (item) => item.merchant_id === merchant.merchant_id,
      );
      if (!before) continue;
      const add = (key: string, text: string): void => {
        changes.push({
          key: `${merchant.merchant_id}:${key}`,
          merchant: merchant.merchant_id,
          text,
        });
      };
      if (merchant.gold !== before.gold)
        add("gold", `Virtual gold ${delta(before.gold, merchant.gold)}`);
      for (const resource of ["crystal", "wood", "herb", "iron"] as const) {
        if (merchant.inventory[resource] !== before.inventory[resource])
          add(
            `${resource}:inventory`,
            `${resource} inventory ${delta(before.inventory[resource], merchant.inventory[resource])}`,
          );
        const listing = merchant.listings.find(
            (item) => item.resource === resource,
          ),
          prior = before.listings.find((item) => item.resource === resource);
        if (!listing || !prior) continue;
        if (listing.quantity !== prior.quantity)
          add(
            `${resource}:quantity`,
            `${resource} listed stock ${delta(prior.quantity, listing.quantity)}`,
          );
        if (listing.unit_price !== prior.unit_price)
          add(
            `${resource}:price`,
            `${resource} ${listing.active ? "price" : "stored price"} ${prior.unit_price} → ${listing.unit_price} gold`,
          );
        if (listing.active !== prior.active)
          add(
            `${resource}:active`,
            `${resource} listing ${listing.active ? "activated" : "deactivated"}`,
          );
      }
    }
    return changes.length ? changes : null;
  }
}

export class CompletionFeedback {
  private baselineAt: number | null = null;
  private watermark = 0n;
  private generation: string | null = null;
  reset(): void {
    this.baselineAt = null;
    this.watermark = 0n;
    this.generation = null;
  }
  accept(state: ActivityFeedState, now: number): readonly string[] {
    if (state.chainStatus !== "ready" || state.hasMore || state.historyGap) {
      this.reset();
      return [];
    }
    if (
      this.generation &&
      state.workerGeneration &&
      this.generation !== state.workerGeneration
    )
      this.reset();
    this.generation = state.workerGeneration;
    const baseline = this.baselineAt;
    if (baseline === null || now < baseline) {
      this.baselineAt = now;
    }
    const confirmed: string[] = [];
    const previousWatermark = this.watermark;
    for (const row of state.rows) {
      const match = /^trade:([1-9][0-9]*)$/.exec(row.id);
      if (!match || row.status !== "confirmed" || row.deltas.length === 0)
        continue;
      const id = BigInt(match[1]!);
      if (
        baseline !== null &&
        now >= baseline &&
        id > previousWatermark &&
        row.time >= baseline &&
        row.time <= now &&
        now - row.time <= 15000
      )
        confirmed.push(row.id);
      if (id > this.watermark) this.watermark = id;
    }
    return confirmed;
  }
}
