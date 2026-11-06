import {
  canonicalLivingTownJson,
  livingTownActivity,
  livingTownActivityPage,
  townActivityPosition,
  townActivityCursor,
  parseLivingTownJson,
} from "@bot-bazaar/chain";
import type { LivingTownIdentity, TownActivity } from "@bot-bazaar/chain";
export class TownActivityReset extends Error {}
export interface TownLiveState {
  events: TownActivity[];
  mode: "connecting" | "live" | "polling" | "unavailable";
  gap: boolean;
}
type Page = ReturnType<typeof livingTownActivityPage>;
export type TownEventSource = Pick<
  EventSource,
  "addEventListener" | "close" | "onerror"
>;
/** One bounded feed connection per mounted town; existing fact polling remains active. */
export class LivingTownLiveFeed {
  private cursor: string | null = null;
  private generation: string | null = null;
  private source: TownEventSource | null = null;
  private readonly rows = new Map<string, TownActivity>();
  private mode: TownLiveState["mode"] = "connecting";
  private gap = false;
  private stopped = false;
  private polling = false;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryAt = 0;
  private connection = 0;
  constructor(
    private readonly identity: LivingTownIdentity,
    private readonly url: string,
    private readonly read: (
      cursor: string | null,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly publish: (state: TownLiveState) => void,
    private readonly createSource: (url: string) => TownEventSource = (url) =>
      new EventSource(url, { withCredentials: false }),
    private readonly now = Date.now,
    private readonly pollMs = 15000,
  ) {}
  private emit(): void {
    if (!this.stopped)
      this.publish({
        events: [...this.rows.values()].slice(-20).reverse(),
        mode: this.mode,
        gap: this.gap,
      });
  }
  private validate(value: unknown): Page {
    const page = livingTownActivityPage(value);
    if (
      canonicalLivingTownJson(page.deployment) !==
        canonicalLivingTownJson(this.identity.deployment) ||
      page.code_hash !== this.identity.codeHash
    )
      throw new Error("activity deployment mismatch");
    return page;
  }
  private append(event: TownActivity): void {
    if (!this.rows.has(event.event_id)) {
      this.rows.set(event.event_id, event);
      while (this.rows.size > 512)
        this.rows.delete(this.rows.keys().next().value!);
    }
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.emit();
    void this.cycle();
    this.timer = setInterval(() => {
      if (this.mode !== "live") void this.cycle();
    }, this.pollMs);
  }
  private async cycle(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    const abort = new AbortController();
    this.abort = abort;
    try {
      for (let n = 0; n < 6; n++) {
        const page = this.validate(await this.read(this.cursor, abort.signal));
        if (this.stopped || abort.signal.aborted) return;
        if (
          this.generation !== null &&
          this.generation !== page.feed_generation
        ) {
          this.gap = true;
        }
        this.generation = page.feed_generation;
        for (const r of page.events) this.append(r.event);
        this.cursor = page.next_cursor;
        if (!page.has_more) break;
      }
      this.mode = "polling";
      this.emit();
      if (this.now() >= this.retryAt) this.connect();
    } catch (e) {
      if (this.stopped || abort.signal.aborted) return;
      if (e instanceof TownActivityReset) {
        this.cursor = null;
        this.generation = null;
        this.gap = true;
        this.mode = "polling";
      } else this.mode = "unavailable";
      this.emit();
    } finally {
      this.polling = false;
      if (this.abort === abort) this.abort = null;
    }
  }
  private connect(): void {
    this.source?.close();
    this.source = null;
    const token = ++this.connection;
    this.retryAt = this.now() + 30000;
    try {
      const url = new URL(this.url);
      if (this.cursor) url.searchParams.set("after", this.cursor);
      const source = this.createSource(url.href);
      this.source = source;
      let ready = false;
      const current = () =>
        !this.stopped && this.connection === token && this.source === source;
      const fail = (reset = false) => {
        if (!current()) return;
        source.close();
        this.source = null;
        this.mode = "polling";
        if (reset) {
          this.cursor = null;
          this.generation = null;
          this.gap = true;
        }
        this.emit();
      };
      source.addEventListener("ready", ((raw: MessageEvent) => {
        if (!current()) return;
        try {
          const p = this.validate(parseLivingTownJson(raw.data));
          if (this.generation !== null && p.feed_generation !== this.generation)
            throw new TownActivityReset();
          this.generation = p.feed_generation;
          ready = true;
          this.mode = "live";
          this.emit();
        } catch (e) {
          fail(e instanceof TownActivityReset);
        }
      }) as EventListener);
      for (const type of [
        "market_event",
        "sale_confirmed",
        "production_ready",
        "agent_action",
      ])
        source.addEventListener(type, ((raw: MessageEvent) => {
          if (!current()) return;
          try {
            if (!ready || raw.data.length > 20000)
              throw new Error("invalid activity stream");
            const event = livingTownActivity(parseLivingTownJson(raw.data));
            if (event.type !== type) throw new Error("wrong activity frame");
            const position = townActivityPosition(raw.lastEventId),
              previous = this.cursor ? townActivityPosition(this.cursor) : null;
            if (
              position.generation !== this.generation ||
              (previous && position.identity !== previous.identity)
            )
              throw new Error("activity cursor binding changed");
            if (previous && position.sequence <= previous.sequence) return;
            this.cursor = townActivityCursor(raw.lastEventId);
            this.append(event);
            this.emit();
          } catch {
            fail();
          }
        }) as EventListener);
      source.addEventListener("reset", ((raw: MessageEvent) => {
        if (!current()) return;
        try {
          const r = parseLivingTownJson(raw.data) as {
            reset_required?: boolean;
          };
          fail(r.reset_required === true);
        } catch {
          fail();
        }
      }) as EventListener);
      source.onerror = () => fail();
    } catch {
      this.mode = "polling";
      this.emit();
    }
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.connection++;
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    this.source?.close();
    this.source = null;
  }
}
export function townActivityText(event: TownActivity): string {
  if (event.type === "sale_confirmed")
    return `Sale #${event.data.trade_id}: ${event.data.quantity} ${event.data.item_id.replaceAll("_", " ")} for ${event.data.total_price} game gold. Confirmed.`;
  if (event.type === "production_ready")
    return `Batch #${event.data.job_id} at shop #${event.data.shop_id} was observed ready to claim. This is a readiness observation, not a completed claim.`;
  if (event.type === "market_event")
    return `Herb shortage ${event.data.boundary}: epochs ${event.data.event.start_epoch} to ${event.data.event.end_epoch} (end exclusive). ${event.source === "chain_boundary_observation" ? "Observed from finalized town state." : "Schedule confirmed."}`;
  return `${event.data.merchant}: ${event.source === "confirmed" ? "Confirmed action" : event.source === "model_proposal" ? "Model proposal" : "Rules-based decision"} · ${event.data.proposal_type.replaceAll("_", " ")} · ${event.data.outcome.replaceAll("_", " ")}. ${event.data.reason} Validation: ${event.data.validation.replaceAll("_", " ")}.${event.data.signals.map((s) => ` ${s.item_id}: ${s.held} held, ${s.reserved} reserved, ${Number(s.scarcity_bps) / 100}% scarcity.`).join("")}`;
}
