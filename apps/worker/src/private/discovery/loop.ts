import type { DiscoveryObserver } from "./observer.js";
import type { DiscoveryState } from "./types.js";

export class DiscoveryLoop {
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private started = false;
  status: "starting" | "ready" | "unavailable" | "stopped" = "starting";
  constructor(
    private readonly observer: DiscoveryObserver,
    private readonly onError: () => void = () => {},
    private readonly intervalMs = 3000,
    private readonly onObserved: (
      state: DiscoveryState,
      signal: AbortSignal,
    ) => void | Promise<void> = () => {},
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
      throw new Error("invalid discovery interval");
  }
  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    this.run();
  }
  private run(): void {
    this.active = (async () => {
      try {
        const state = await this.observer.poll(this.abort.signal);
        if (!this.abort.signal.aborted) {
          await this.onObserved(state, this.abort.signal);
          this.status = "ready";
        }
      } catch {
        if (!this.abort.signal.aborted) {
          this.status = "unavailable";
          this.onError();
        }
      } finally {
        if (!this.abort.signal.aborted) {
          this.timer = setTimeout(() => this.run(), this.intervalMs);
          this.timer.unref();
        }
      }
    })();
  }
  async stop(): Promise<void> {
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    this.status = "stopped";
  }
}
