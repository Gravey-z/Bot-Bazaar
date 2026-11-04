import { Component, inject, signal } from "@angular/core";
import type { OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { PUBLIC_CONFIG } from "./public-config";
import { MarketUpdates } from "./market-updates";
import { createActivityReads } from "./activity-reader";
import { ActivityFeed } from "./activity-feed";
import type { ActivityFeedState } from "./activity-feed";

@Component({
  selector: "app-activity",
  imports: [DatePipe],
  templateUrl: "./activity.component.html",
  styleUrl: "./activity.component.css",
})
export class ActivityComponent implements OnInit, OnDestroy {
  private readonly updates = inject(MarketUpdates);
  protected readonly state = signal<ActivityFeedState>({
    availability: "Reading worker and AI availability…",
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
  });
  private readonly feed = new ActivityFeed(
    createActivityReads(inject(PUBLIC_CONFIG)),
    (state) => this.state.set(state),
    () => this.updates.notify(),
  );
  private readonly visibility = (): void => {
    if (document.hidden) this.feed.stop();
    else this.feed.start();
  };
  ngOnInit(): void {
    document.addEventListener("visibilitychange", this.visibility);
    this.visibility();
  }
  ngOnDestroy(): void {
    document.removeEventListener("visibilitychange", this.visibility);
    this.feed.stop();
  }
  protected refresh(): void {
    void this.feed.refresh();
  }
  protected reset(): void {
    this.feed.reset();
  }
}
