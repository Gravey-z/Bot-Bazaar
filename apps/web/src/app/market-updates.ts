import { Injectable, signal } from "@angular/core";

@Injectable({ providedIn: "root" })
export class MarketUpdates {
  readonly revision = signal(0);
  notify(): void {
    this.revision.update((value) => value + 1);
  }
}
