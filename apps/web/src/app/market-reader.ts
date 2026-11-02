import { MarketClient, createRpcTransport } from "@bot-bazaar/chain";
import type { FinalizedBlock, MarketState, Snapshot } from "@bot-bazaar/chain";
import type { PublicConfig } from "@bot-bazaar/shared";

export interface MarketObservation {
  readonly block: FinalizedBlock;
  readonly market: Snapshot<MarketState>;
  readonly receivedAt: number;
}
export interface MarketViewState {
  readonly observation: MarketObservation | null;
  readonly status: "loading" | "ready" | "stale" | "unavailable";
  readonly refreshing: boolean;
  readonly readFailed: boolean;
}

export function createMarketReader(
  config: Pick<PublicConfig, "contractId" | "rpcUrl">,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): () => Promise<MarketObservation> {
  const client = new MarketClient(
    config.contractId,
    createRpcTransport(config.rpcUrl, fetcher),
  );
  return async () => {
    const reader = await client.finalized();
    const market = await reader.getMarketState();
    return { block: reader.block, market, receivedAt: now() };
  };
}

const freshnessMs = 15000;
function stale(observation: MarketObservation, now: number): boolean {
  const chainTime = Number(BigInt(observation.block.timestampNs) / 1000000n);
  return (
    now < observation.receivedAt ||
    now - observation.receivedAt > freshnessMs ||
    now - chainTime > freshnessMs ||
    chainTime - now > 5000
  );
}

// Read-only state: one request at a time, no hidden-tab polling, and no late
// response from a stopped generation can replace the visible snapshot.
export class MarketFeed {
  private current: MarketViewState = {
    observation: null,
    status: "loading",
    refreshing: false,
    readFailed: false,
  };
  private running = false;
  private pending = false;
  private generation = 0;
  private failures = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly read: () => Promise<MarketObservation>,
    private readonly changed: (state: MarketViewState) => void,
    private readonly now: () => number = Date.now,
    private readonly timers = { set: setTimeout, clear: clearTimeout },
  ) {}

  get state(): MarketViewState {
    return this.current;
  }
  private publish(values: Partial<MarketViewState>): void {
    this.current = { ...this.current, ...values };
    this.changed(this.current);
  }
  private status(): MarketViewState["status"] {
    if (!this.current.observation)
      return this.current.readFailed ? "unavailable" : "loading";
    return this.current.readFailed ||
      stale(this.current.observation, this.now())
      ? "stale"
      : "ready";
  }
  private armFreshness(): void {
    if (this.staleTimer !== undefined) this.timers.clear(this.staleTimer);
    const observation = this.current.observation;
    if (!this.running || !observation || this.current.status !== "ready")
      return;
    const chainTime = Number(BigInt(observation.block.timestampNs) / 1000000n);
    const remaining =
      Math.min(chainTime, observation.receivedAt) +
      freshnessMs -
      this.now() +
      1;
    this.staleTimer = this.timers.set(
      () => {
        this.publish({ status: this.status() });
      },
      Math.max(1, remaining),
    );
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.publish({ status: this.status() });
    this.armFreshness();
    void this.refresh();
  }
  stop(): void {
    this.running = false;
    this.generation++;
    if (this.pollTimer !== undefined) this.timers.clear(this.pollTimer);
    if (this.staleTimer !== undefined) this.timers.clear(this.staleTimer);
  }
  async refresh(): Promise<void> {
    if (!this.running || this.pending) return;
    if (this.pollTimer !== undefined) this.timers.clear(this.pollTimer);
    this.pending = true;
    const generation = this.generation;
    this.publish({ refreshing: true, status: this.status() });
    try {
      const observation = await this.read();
      if (!this.running || generation !== this.generation) return;
      const previous = this.current.observation;
      if (
        previous &&
        (observation.market.data.contract_account_id !==
          previous.market.data.contract_account_id ||
          BigInt(observation.block.height) < BigInt(previous.block.height) ||
          BigInt(observation.market.market_revision) <
            BigInt(previous.market.market_revision) ||
          (observation.block.height === previous.block.height &&
            (observation.block.hash !== previous.block.hash ||
              JSON.stringify(observation.market) !==
                JSON.stringify(previous.market))))
      )
        throw new Error("inconsistent market snapshot");
      this.failures = 0;
      this.publish({
        observation,
        readFailed: false,
        status: stale(observation, this.now()) ? "stale" : "ready",
      });
      this.armFreshness();
    } catch {
      if (!this.running || generation !== this.generation) return;
      this.failures++;
      this.publish({
        readFailed: true,
        status: this.current.observation ? "stale" : "unavailable",
      });
    } finally {
      this.pending = false;
      if (this.running) {
        this.publish({ refreshing: false });
        const delay =
          generation !== this.generation
            ? 0
            : Math.min(30000, 3000 * 2 ** Math.min(this.failures, 4));
        this.pollTimer = this.timers.set(() => {
          void this.refresh();
        }, delay);
      }
    }
  }
}

export function formatMarketAmount(value: string): string {
  return new Intl.NumberFormat("en-US").format(BigInt(value));
}
