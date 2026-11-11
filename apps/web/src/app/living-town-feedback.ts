import type { TownState, TownObservation } from "./living-town-controller";
import { ownedTownObservation, townSnapshotFresh } from "./living-town-layout";

export interface TownFeedback {
  id: string;
  kind: "ready" | "sale" | "upgrade";
  text: string;
}

/** Session-only feedback; never authorizes a transaction or becomes game state. */
export class TownFeedbackTracker {
  private scope: string | null = null;
  private previous: TownObservation | null = null;
  private baselineTime = 0n;
  private saleSequence = 0n;
  private readonly readySeen = new Set<string>();
  observe(state: TownState, now: number): TownFeedback[] {
    const o = ownedTownObservation(state);
    const scope = o ? `${state.accountId}:${o.shop!.shop_id}` : null;
    if (!o || !townSnapshotFresh(state, now) || !o.chainTimestampNs) {
      this.previous = null;
      return [];
    }
    const time = BigInt(o.chainTimestampNs);
    if (scope !== this.scope || !this.previous) {
      this.scope = scope;
      this.previous = structuredClone(o);
      this.baselineTime = time;
      this.saleSequence = 0n;
      this.readySeen.clear();
      for (const job of o.production?.items ?? [])
        if (job.status === "running" && BigInt(job.ready_at_ns) <= time)
          this.readySeen.add(job.job_id);
      return [];
    }
    const before = this.previous;
    const previousTime = BigInt(before.chainTimestampNs!);
    if (time < previousTime) return [];
    const events: TownFeedback[] = [];
    const add = (kind: TownFeedback["kind"], key: string, text: string) =>
      events.push({ id: `${scope}:${kind}:${key}`, kind, text });
    if (time > previousTime) {
      if (o.shop!.production_slots !== before.shop!.production_slots)
        add(
          "upgrade",
          `${time}`,
          `Confirmed production capacity: ${before.shop!.production_slots} → ${o.shop!.production_slots} slots. Existing batches keep their original timing and output.`,
        );
      for (const job of o.production?.items ?? []) {
        if (
          job.shop_id !== o.shop!.shop_id ||
          job.owner.kind !== "player" ||
          job.owner.account_id !== state.accountId ||
          job.status !== "running" ||
          BigInt(job.ready_at_ns) > time ||
          this.readySeen.has(job.job_id)
        )
          continue;
        const old = before.production?.items.find(
          (j) => j.job_id === job.job_id,
        );
        // A newly loaded historical page is not a new ready-job event.
        if (
          (old?.status === "running" &&
            BigInt(old.ready_at_ns) > previousTime) ||
          BigInt(job.start_at_ns) > this.baselineTime
        ) {
          if (this.readySeen.size < 2048) {
            this.readySeen.add(job.job_id);
            const item = job.output_item.replaceAll("_", " ") + (job.output_quantity === "1" ? "" : "s");
            add(
              "ready",
              job.job_id,
              `Batch #${job.job_id} is ready: ${job.output_quantity} ${item}. Collect ${job.output_quantity === "1" ? "it" : "them"} in your shop.`,
            );
          }
        }
      }
      this.previous = structuredClone(o);
    }
    const sales = new Map<
      string,
      { sequence: string; timestamp: string; key: string; text: string }
    >();
    for (const event of state.activity.events) {
      if (
        event.type !== "sale_confirmed" ||
        !o.ownListings?.some(
          (listing) =>
            listing.listing_id === event.data.listing_id &&
            listing.shop_id === o.shop!.shop_id &&
            listing.owner.kind === "player" &&
            listing.owner.account_id === state.accountId,
        )
      )
        continue;
      sales.set(event.data.effect_event_sequence, {
        sequence: event.data.effect_event_sequence,
        timestamp: event.checkpoint.block_timestamp_ns,
        key: event.data.receipt_id,
        text: `Confirmed customer sale: ${event.data.quantity} ${event.data.item_id} for ${event.data.total_price} game gold revenue. See History for cost basis and realized profit. Receipt ${event.data.receipt_id}.`,
      });
    }
    const history = state.history;
    if (history?.shopId === o.shop!.shop_id && !history.stale) {
      for (const row of history.items) {
        if (row.kind !== "customer_sale") continue;
        sales.set(row.event_sequence, {
          sequence: row.event_sequence,
          timestamp: row.block_timestamp_ns,
          key: `${row.receipt_id}:${row.log_index}`,
          text: `Confirmed customer sale: ${row.quantity} ${row.item_id} for ${row.gold_amount} game gold revenue. ${row.profit === null ? "Realized profit is unknown." : `Realized profit: ${row.profit} game gold.`} Receipt ${row.receipt_id}, log ${row.log_index}.`,
        });
      }
    }
    for (const sale of [...sales.values()].sort((a, b) =>
      BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1,
    )) {
      const sequence = BigInt(sale.sequence),
        timestamp = BigInt(sale.timestamp);
      if (sequence <= this.saleSequence || timestamp > time) continue;
      this.saleSequence = sequence;
      if (timestamp > this.baselineTime) add("sale", sale.key, sale.text);
    }
    return events;
  }
}

/** Local synthesized cue, opt-in only. Audio failure never affects gameplay. */
export class TownFeedbackSound {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private enabled = false;
  private generation = 0;
  constructor(private readonly create = () => new AudioContext()) {}
  async enable(): Promise<boolean> {
    const generation = ++this.generation;
    try {
      this.context ??= this.create();
      this.gain ??= this.context.createGain();
      this.gain.disconnect();
      this.gain.connect(this.context.destination);
      await this.context.resume();
      if (generation !== this.generation) return false;
      this.enabled = this.context.state === "running";
      this.gain.gain.setValueAtTime(
        this.enabled ? 0.035 : 0,
        this.context.currentTime,
      );
      return this.enabled;
    } catch {
      this.mute();
      return false;
    }
  }
  mute(): void {
    this.generation++;
    this.enabled = false;
    this.gain?.gain.setValueAtTime(0, this.context!.currentTime);
  }
  play(): void {
    if (!this.enabled || this.context?.state !== "running" || !this.gain)
      return;
    try {
      const tone = this.context.createOscillator();
      tone.frequency.value = 660;
      tone.connect(this.gain);
      tone.onended = () => tone.disconnect();
      tone.start();
      tone.stop(this.context.currentTime + 0.1);
    } catch {
      this.mute();
    }
  }
  dispose(): void {
    this.mute();
    void this.context?.close().catch(() => {});
  }
}
