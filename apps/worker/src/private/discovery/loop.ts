import type { DiscoveryObserver } from "./observer.js";

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
        await this.observer.poll(this.abort.signal);
        if (!this.abort.signal.aborted) this.status = "ready";
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
