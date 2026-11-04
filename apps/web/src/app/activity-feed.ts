import type {
  ActivityPage,
  PublicActivityEntry,
  PublicTrade,
} from "@bot-bazaar/shared";
import { ActivityReadError } from "./activity-reader";
import type { ActivityReads, ChainActivityPage } from "./activity-reader";

export interface FeedRow {
  readonly id: string;
  readonly time: number;
  readonly source: string;
  readonly status: string;
  readonly title: string;
  readonly detail: string;
  readonly reason: string | null;
  readonly reasonKind: "model" | "status" | null;
  readonly ids: string;
  readonly group: string;
  readonly incomplete: boolean;
}
export interface ActivityFeedState {
  readonly rows: readonly FeedRow[];
  readonly refreshing: boolean;
  readonly chainStatus: "loading" | "ready" | "stale" | "unavailable";
  readonly workerStatus:
    "loading" | "ready" | "waiting" | "unavailable" | "mismatch";
  readonly workerStale: boolean;
  readonly chainBlock: string | null;
  readonly workerGeneration: string | null;
  readonly workerCapturedAt: number | null;
  readonly hasMore: boolean;
  readonly historyGap: boolean;
  readonly trimmed: boolean;
  readonly notice: string;
}
const initial: ActivityFeedState = {
  rows: [],
  refreshing: false,
  chainStatus: "loading",
  workerStatus: "loading",
  workerStale: true,
  chainBlock: null,
  workerGeneration: null,
  workerCapturedAt: null,
  hasMore: false,
  historyGap: false,
  trimmed: false,
  notice: "",
};
function tradeTime(trade: PublicTrade): number {
  return Number(BigInt(trade.settled_at_ns) / 1000000n);
}
function publicTradeKey(trade: PublicTrade): string {
  return JSON.stringify([
    trade.trade_id,
    trade.kind,
    trade.buyer,
    trade.seller,
    trade.resource,
    trade.quantity,
    trade.unit_price,
    trade.total_price,
    trade.settled_at_ns,
  ]);
}
function tradeRow(trade: PublicTrade, source: string): FeedRow {
  return {
    id: `trade:${trade.trade_id}`,
    time: tradeTime(trade),
    source,
    status: "confirmed",
    title:
      trade.kind === "player_purchase"
        ? "Player purchase confirmed"
        : "Merchant trade confirmed",
    detail: `${trade.kind === "player_purchase" ? "A player" : trade.buyer} bought ${trade.quantity} ${trade.resource} from ${trade.seller} for ${trade.total_price} virtual gold (${trade.unit_price} each).`,
    reason: null,
    reasonKind: null,
    ids: `Trade #${trade.trade_id}`,
    group: `trade:${trade.trade_id}`,
    incomplete: false,
  };
}
function workerRow(entry: PublicActivityEntry): FeedRow {
  const source =
    entry.source === "model"
      ? "Worker model record"
      : entry.source === "policy"
        ? "Worker policy"
        : entry.source === "chain"
          ? "Worker chain evidence"
          : "Worker system";
  const title = entry.late_ignored
    ? "Late response ignored"
    : entry.source === "model"
      ? entry.status === "thinking"
        ? "Model request in progress"
        : entry.status === "held"
          ? "Model chose to hold"
          : entry.status === "rejected"
            ? "Model declined"
            : "Model proposal"
      : entry.phase === "offer"
        ? `Offer ${entry.status === "confirmed" ? "accepted" : entry.status}`
        : entry.phase === "transaction"
          ? `Transaction ${entry.status}`
          : entry.phase === "market"
            ? `Market ${entry.status}`
            : `${entry.phase} · ${entry.status}`;
  const ids = [
    ["Root", entry.root_id],
    ["Decision", entry.decision_id],
    ["Intent", entry.intent_id],
    ["Action", entry.action_id],
    ["Offer", entry.offer_id],
    ["Trade", entry.trade_id],
  ]
    .filter((pair) => pair[1] !== null)
    .map((pair) => `${pair[0]} ${pair[1]}`)
    .join(" · ");
  let detail = entry.merchant_id ? `Merchant: ${entry.merchant_id}. ` : "";
  if (entry.method) detail += `Method: ${entry.method}.`;
  if (entry.selection) {
    const selection = entry.selection;
    detail += ` Proposed: ${selection.quantity ?? ""} ${selection.resource ?? "action"}${selection.seller ? ` from ${selection.seller}` : ""}${selection.buyer ? ` for ${selection.buyer}` : ""}${selection.total_price ? ` · ${selection.total_price} virtual gold` : ""}. No completed transfer is implied.`;
  }
  if (entry.status === "submitted")
    detail += " Network acknowledgement; final confirmation is outstanding.";
  if (entry.status === "confirmed" && !entry.trade)
    detail +=
      " Action/offer confirmation; this record does not include a completed transfer's amounts.";
  if (entry.block) detail += ` Observed block ${entry.block.height}.`;
  return {
    id: `worker:${entry.id}`,
    time: entry.observed_at,
    source,
    status: entry.status,
    title,
    detail,
    reason: entry.reason,
    reasonKind: entry.reason_kind,
    ids: ids || `Event ${entry.id}`,
    group:
      entry.root_id ?? entry.decision_id ?? entry.intent_id ?? entry.domain_key,
    incomplete: entry.transaction?.evidence_incomplete ?? false,
  };
}
export function mergeActivityRows(
  trades: readonly PublicTrade[],
  entries: readonly PublicActivityEntry[],
): { rows: FeedRow[]; conflict: boolean } {
  const confirmed = new Map(
    trades.map((trade) => [
      trade.trade_id,
      tradeRow(trade, "Finalized contract view"),
    ]),
  );
  const direct = new Set(trades.map((trade) => trade.trade_id));
  const terms = new Map(
    trades.map((trade) => [trade.trade_id, publicTradeKey(trade)]),
  );
  const rows: FeedRow[] = [];
  let conflict = false;
  for (const entry of entries) {
    if (entry.trade) {
      const previous = terms.get(entry.trade.trade_id);
      if (previous && previous !== publicTradeKey(entry.trade)) {
        conflict = true;
        continue;
      }
      terms.set(entry.trade.trade_id, publicTradeKey(entry.trade));
      const row =
        confirmed.get(entry.trade.trade_id) ??
        tradeRow(entry.trade, "Worker confirmed chain evidence");
      confirmed.set(entry.trade.trade_id, {
        ...row,
        source: direct.has(entry.trade.trade_id)
          ? "Finalized contract view + worker evidence"
          : row.source,
        incomplete:
          row.incomplete || (entry.transaction?.evidence_incomplete ?? false),
        ids: [
          ...new Set([
            ...row.ids.split(" · "),
            ...(entry.root_id ? [`Root ${entry.root_id}`] : []),
            ...(entry.decision_id ? [`Decision ${entry.decision_id}`] : []),
            ...(entry.intent_id ? [`Intent ${entry.intent_id}`] : []),
            ...(entry.action_id ? [`Action ${entry.action_id}`] : []),
            ...(entry.offer_id ? [`Offer ${entry.offer_id}`] : []),
          ]),
        ].join(" · "),
      });
    } else rows.push(workerRow(entry));
  }
  rows.push(...confirmed.values());
  return {
    rows: rows.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)),
    conflict,
  };
}
export class ActivityFeed {
  private current: ActivityFeedState = initial;
  private readonly trades = new Map<string, PublicTrade>();
  private readonly events = new Map<string, PublicActivityEntry>();
  private chainPage: ChainActivityPage | null = null;
  private workerPage: ActivityPage | null = null;
  private workerCursor: string | null = null;
  private chainCursor: string | null = null;
  private sequence = "0";
  private pending = false;
  private running = false;
  private generation = 0;
  private chainFailed = false;
  private workerFailures = 0;
  private chainFailures = 0;
  private readonly gaps = new Set<string>();
  private nextWorker = 0;
  private nextChain = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly reads: ActivityReads,
    private readonly changed: (state: ActivityFeedState) => void,
    private readonly gap: () => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly timers = { set: setTimeout, clear: clearTimeout },
  ) {}
  get state(): ActivityFeedState {
    return this.current;
  }
  private freshChain(): boolean {
    if (!this.chainPage) return false;
    const chainTime = Number(
      BigInt(this.chainPage.block.timestampNs) / 1000000n,
    );
    return (
      this.now() >= this.chainPage.capturedAt &&
      this.now() - this.chainPage.capturedAt <= 15000 &&
      this.now() - chainTime <= 15000 &&
      chainTime - this.now() <= 5000
    );
  }
  private publish(values: Partial<ActivityFeedState>): void {
    const merged = mergeActivityRows(
      [...this.trades.values()],
      [...this.events.values()],
    );
    this.current = {
      ...this.current,
      ...values,
      rows: merged.rows,
      chainStatus: this.chainPage
        ? !this.chainFailed && this.freshChain()
          ? "ready"
          : "stale"
        : this.chainFailed
          ? "unavailable"
          : "loading",
      workerStale:
        !this.workerPage ||
        this.workerPage.chain.stale ||
        this.workerPage.chain.observed_at === null ||
        this.now() - this.workerPage.chain.observed_at > 15000 ||
        this.workerPage.chain.observed_at > this.now() + 5000 ||
        this.now() - this.workerPage.captured_at > 15000 ||
        this.workerPage.captured_at > this.now() + 5000,
      chainBlock: this.chainPage?.block.height ?? null,
      workerCapturedAt: this.workerPage?.captured_at ?? null,
      workerGeneration: this.workerPage?.feed_generation ?? null,
      hasMore: !!this.workerPage?.has_more || !!this.chainPage?.hasMore,
      ...(merged.conflict
        ? {
            notice:
              "Conflicting worker trade evidence was ignored; finalized contract terms are shown.",
          }
        : {}),
    };
    this.changed(this.current);
  }
  private trim<T>(map: Map<string, T>): void {
    while (map.size > 200) {
      map.delete(map.keys().next().value!);
      this.current = { ...this.current, trimmed: true };
    }
  }
  private historyGap(key: string): void {
    if (!this.gaps.has(key)) {
      this.gaps.add(key);
      if (this.gaps.size > 64)
        this.gaps.delete(this.gaps.values().next().value!);
      this.gap();
    }
    this.current = { ...this.current, historyGap: true };
  }
  private resetWorker(notice: string): void {
    const generation = this.workerPage?.feed_generation ?? "none";
    this.events.clear();
    this.workerCursor = null;
    this.workerPage = null;
    this.sequence = "0";
    this.current = { ...this.current, notice, workerStatus: "loading" };
    this.historyGap(`reset:${generation}:${notice}`);
  }
  private acceptChain(page: ChainActivityPage, used: string | null): void {
    const previous = this.chainPage;
    const replaced =
      previous && (page.codeHash !== previous.codeHash || page.reset);
    if (replaced) {
      this.trades.clear();
      this.chainCursor = null;
      this.resetWorker(
        "Contract code/history changed. Source cursors were reset; previous deployment entries were removed.",
      );
      this.chainPage = { ...page, trades: [], hasMore: true };
      if (used !== null && !page.reset) return;
    } else if (
      previous &&
      (BigInt(page.block.height) < BigInt(previous.block.height) ||
        (page.block.height === previous.block.height &&
          (page.block.hash !== previous.block.hash ||
            page.block.timestampNs !== previous.block.timestampNs ||
            page.marketRevision !== previous.marketRevision ||
            page.highWater !== previous.highWater)) ||
        BigInt(page.marketRevision) < BigInt(previous.marketRevision) ||
        BigInt(page.highWater) < BigInt(previous.highWater))
    )
      throw new ActivityReadError("invalid");
    for (const trade of page.trades) {
      const old = this.trades.get(trade.trade_id);
      if (old && publicTradeKey(old) !== publicTradeKey(trade))
        throw new ActivityReadError("invalid");
    }
    if (
      page.historyGap ||
      (used !== null && BigInt(used) < BigInt(page.prunedThrough))
    )
      this.historyGap(`chain:${page.codeHash}:${page.prunedThrough}`);
    for (const trade of page.trades) this.trades.set(trade.trade_id, trade);
    this.trim(this.trades);
    this.chainCursor = page.nextAfter;
    this.chainPage = page;
  }
  private acceptWorker(page: ActivityPage, used: string | null): void {
    if (used !== this.workerCursor) return;
    if (!this.chainPage || this.chainFailed || !this.freshChain()) {
      this.current = { ...this.current, workerStatus: "waiting" };
      return;
    }
    if (page.deployment.expected_code_hash !== this.chainPage.codeHash) {
      this.resetWorker(
        "Worker deployment does not match the finalized contract code. Worker entries are hidden.",
      );
      this.current = { ...this.current, workerStatus: "mismatch" };
      return;
    }
    if (
      page.entries.some(
        (entry) =>
          (entry.block &&
            (BigInt(entry.block.height) >
              BigInt(this.chainPage!.block.height) ||
              BigInt(entry.block.market_revision) >
                BigInt(this.chainPage!.marketRevision))) ||
          (entry.trade &&
            BigInt(entry.trade.trade_id) > BigInt(this.chainPage!.highWater)),
      )
    ) {
      this.current = { ...this.current, workerStatus: "waiting" };
      return;
    }
    const previous = this.workerPage;
    if (
      previous &&
      (previous.feed_generation !== page.feed_generation ||
        previous.deployment.id !== page.deployment.id)
    ) {
      this.resetWorker(
        "Worker feed was restarted/restored. Reloading the retained history from its beginning.",
      );
      if (used !== null) return;
    } else if (
      previous &&
      (BigInt(page.high_water_sequence) <
        BigInt(previous.high_water_sequence) ||
        BigInt(page.pruned_through) < BigInt(previous.pruned_through))
    ) {
      this.resetWorker(
        "Worker history moved backwards. Reloading the retained history.",
      );
      return;
    }
    if (
      page.entries.some(
        (entry) => BigInt(entry.sequence) <= BigInt(this.sequence),
      ) ||
      (page.has_more && page.next_after === used)
    )
      throw new ActivityReadError("invalid");
    if (
      page.captured_at > this.now() + 5000 ||
      this.now() - page.captured_at > 15000
    )
      throw new ActivityReadError("invalid");
    if (page.history_gap || BigInt(this.sequence) < BigInt(page.pruned_through))
      this.historyGap(`worker:${page.feed_generation}:${page.pruned_through}`);
    for (const entry of page.entries) {
      const old = this.events.get(entry.id);
      if (old && JSON.stringify(old) !== JSON.stringify(entry))
        throw new ActivityReadError("invalid");
    }
    for (const entry of page.entries) this.events.set(entry.id, entry);
    this.trim(this.events);
    this.sequence = page.entries.at(-1)?.sequence ?? page.high_water_sequence;
    this.workerCursor = page.next_after;
    this.workerPage = page;
    this.current = { ...this.current, workerStatus: "ready" };
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    void this.refresh();
  }
  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.publish({ refreshing: false });
  }
  reset(): void {
    this.generation++;
    this.events.clear();
    this.trades.clear();
    this.chainPage = null;
    this.workerPage = null;
    this.workerCursor = null;
    this.chainCursor = null;
    this.sequence = "0";
    this.current = initial;
    this.gaps.clear();
    this.chainFailed = false;
    this.nextWorker = 0;
    this.nextChain = 0;
    this.workerFailures = 0;
    this.chainFailures = 0;
    this.publish({
      notice: "Reloading retained activity. Wallet transactions are unchanged.",
    });
    if (this.running) void this.refresh();
  }
  async refresh(manual = true): Promise<void> {
    this.publish({});
    if (!this.running || this.pending) return;
    this.pending = true;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    const generation = this.generation,
      workerCursor = this.workerCursor,
      chainCursor = this.chainCursor;
    const workerDue = manual || this.now() >= this.nextWorker,
      chainDue = manual || this.now() >= this.nextChain;
    this.publish({ refreshing: true });
    try {
      const [chain, worker] = await Promise.allSettled([
        chainDue ? this.reads.chain(chainCursor) : Promise.resolve(null),
        workerDue ? this.reads.worker(workerCursor) : Promise.resolve(null),
      ]);
      if (!this.running || generation !== this.generation) return;
      if (chainDue) {
        try {
          if (chain.status !== "fulfilled" || chain.value === null)
            throw new ActivityReadError("unavailable");
          this.acceptChain(chain.value, chainCursor);
          this.chainFailed = false;
          this.chainFailures = 0;
        } catch {
          this.chainFailed = true;
          this.chainFailures++;
        }
        this.nextChain =
          this.now() +
          Math.min(30000, 3000 * 2 ** Math.min(this.chainFailures, 4));
      }
      if (workerDue) {
        try {
          if (worker.status !== "fulfilled") throw worker.reason;
          if (worker.value !== null)
            this.acceptWorker(worker.value, workerCursor);
          this.workerFailures = 0;
        } catch (error) {
          this.workerFailures++;
          if (
            error instanceof ActivityReadError &&
            (error.kind === "generation" || error.kind === "deployment")
          )
            this.resetWorker(
              "Worker identity/generation changed. Reloading its retained history with a new cursor.",
            );
          this.current = {
            ...this.current,
            workerStatus:
              error instanceof ActivityReadError && error.kind === "deployment"
                ? "mismatch"
                : "unavailable",
          };
        }
        this.nextWorker =
          this.now() +
          Math.min(30000, 3000 * 2 ** Math.min(this.workerFailures, 4));
      }
      this.publish({});
    } finally {
      this.pending = false;
      if (this.running) {
        this.publish({ refreshing: false });
        this.timer = this.timers.set(
          () => {
            void this.refresh(false);
          },
          generation === this.generation ? 3000 : 0,
        );
      }
    }
  }
}
