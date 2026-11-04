import type {
  Replay,
  ReplayAction,
  ReplayCheckpoint,
  ReplayDecision,
  ReplayEntry,
  ReplayCollection,
} from "@bot-bazaar/chain";
import { decodeCallResult, decodeBase64Json } from "@bot-bazaar/chain";

export interface ReplayFrame {
  kind: "snapshot" | "decision" | "transaction";
  label: string;
  timestamp: string;
  checkpoint: ReplayCheckpoint;
  action: ReplayAction | null;
  decision: ReplayDecision | null;
  terms: string | null;
}
export interface ReplayView {
  phase: "loading" | "empty" | "list" | "loading_run" | "ready" | "error";
  entries: readonly ReplayEntry[];
  replay: Replay | null;
  frames: readonly ReplayFrame[];
  position: number;
  playing: boolean;
  message: string;
}
export interface ReplayReads {
  index(signal: AbortSignal): Promise<ReplayCollection>;
  load(entry: ReplayEntry, signal: AbortSignal): Promise<Replay>;
}
export function replayFrames(replay: Replay): readonly ReplayFrame[] {
  const first = replay.checkpoints[0]!;
  const frames: ReplayFrame[] = [
    {
      kind: "snapshot",
      label: "Recorded starting balances",
      timestamp: first.block.timestampNs,
      checkpoint: first,
      action: null,
      decision: null,
      terms: null,
    },
  ];
  for (const [index, action] of replay.actions.entries()) {
    const method =
      action.receipt.transaction.actions[0]!.FunctionCall.method_name;
    const data = decodeCallResult(
      method,
      decodeBase64Json(action.receipt.status.SuccessValue),
    ).data;
    const trade = "trade" in data ? data.trade : "kind" in data ? data : null;
    const offer = "offer" in data ? data.offer : null;
    const listing = "listing" in data ? data.listing : null;
    const terms = trade
      ? `${trade.quantity} ${trade.resource} · ${trade.total_price} total gold · ${trade.unit_price} gold each · trade #${trade.trade_id}${trade.offer_id ? ` · offer #${trade.offer_id}` : ""}`
      : offer
        ? `${offer.buyer} buys ${offer.quantity} ${offer.resource} from ${offer.seller} · ${offer.total_price} total gold · ${offer.unit_price} gold each · offer #${offer.offer_id}`
        : listing
          ? `${listing.merchant_id} · ${listing.resource} · ${listing.active ? listing.quantity + " listed" : "inactive"} · ${listing.unit_price} gold each`
          : null;
    const decision =
      replay.decisions.find((d) => d.id === action.decisionId) ?? null;
    if (decision)
      frames.push({
        kind: "decision",
        label: "Recorded model decision · proposed, no transfer yet",
        timestamp: String(BigInt(Date.parse(decision.returnedAt)) * 1000000n),
        checkpoint: replay.checkpoints[index]!,
        action: null,
        decision,
        terms,
      });
    const label =
      action.source === "policy"
        ? "Recorded policy preparation · confirmed"
        : method === "buy_from_merchant"
          ? "Recorded player purchase · confirmed"
          : method === "propose_trade"
            ? "Recorded offer · confirmed, no transfer yet"
            : method === "accept_trade"
              ? "Recorded merchant settlement · confirmed"
              : "Recorded listing change · confirmed";
    frames.push({
      kind: "transaction",
      label,
      timestamp: replay.checkpoints[index + 1]!.block.timestampNs,
      checkpoint: replay.checkpoints[index + 1]!,
      action,
      decision: null,
      terms,
    });
  }
  return frames;
}
export class ReplayPlayback {
  state: ReplayView = {
    phase: "loading",
    entries: [],
    replay: null,
    frames: [],
    position: 0,
    playing: false,
    message: "",
  };
  private generation = 0;
  private stopped = false;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly reads: ReplayReads,
    private readonly changed: (state: ReplayView) => void,
  ) {}
  private publish(update: Partial<ReplayView>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...update };
    this.changed(this.state);
  }
  private begin(): number {
    this.pause();
    this.abort.abort();
    this.abort = new AbortController();
    return ++this.generation;
  }
  async start(): Promise<void> {
    const generation = this.begin();
    this.publish({
      phase: "loading",
      replay: null,
      frames: [],
      position: 0,
      message: "",
    });
    try {
      const index = await this.reads.index(this.abort.signal);
      if (generation !== this.generation || this.stopped) return;
      this.publish({
        phase: index.entries.length ? "list" : "empty",
        entries: index.entries,
      });
    } catch {
      if (generation === this.generation)
        this.publish({
          phase: "error",
          message:
            "The historical archive could not be verified or loaded. You can retry or return to the live market.",
        });
    }
  }
  async select(runId: string): Promise<void> {
    const entry = this.state.entries.find((item) => item.runId === runId);
    if (!entry || this.stopped) return;
    const generation = this.begin();
    this.publish({
      phase: "loading_run",
      replay: null,
      frames: [],
      position: 0,
      message: "",
    });
    try {
      const replay = await this.reads.load(entry, this.abort.signal);
      if (generation !== this.generation || this.stopped) return;
      this.publish({ phase: "ready", replay, frames: replayFrames(replay) });
    } catch {
      if (generation === this.generation)
        this.publish({
          phase: "error",
          message:
            "This recording did not load or pass its evidence checks. No historical balances were applied to the live market.",
        });
    }
  }
  seek(position: number): void {
    this.pause();
    if (
      this.state.phase === "ready" &&
      Number.isInteger(position) &&
      position >= 0 &&
      position < this.state.frames.length
    )
      this.publish({ position });
  }
  play(): void {
    if (this.state.phase !== "ready" || this.state.playing || this.stopped)
      return;
    if (this.state.position === this.state.frames.length - 1)
      this.publish({ position: 0 });
    this.publish({ playing: true });
    const next = (): void => {
      if (!this.state.playing || this.stopped) return;
      const position = this.state.position + 1;
      this.publish({
        position,
        playing: position < this.state.frames.length - 1,
      });
      if (this.state.playing) this.timer = setTimeout(next, 3000);
    };
    this.timer = setTimeout(next, 3000);
  }
  pause(): void {
    clearTimeout(this.timer);
    if (this.state.playing) this.publish({ playing: false });
  }
  stop(): void {
    this.pause();
    this.abort.abort();
    ++this.generation;
    this.stopped = true;
  }
}
