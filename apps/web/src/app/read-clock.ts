import { Injectable, signal } from "@angular/core";
import type { OnDestroy } from "@angular/core";

@Injectable({ providedIn: "root" })
export class ReadClock implements OnDestroy {
  readonly now = signal(Date.now());
  private readonly tick = (): void => {
    if (!document.hidden) this.now.set(Date.now());
  };
  private readonly timer = setInterval(this.tick, 1000);
  constructor() {
    document.addEventListener("visibilitychange", this.tick);
  }
  ngOnDestroy(): void {
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.tick);
  }
}
