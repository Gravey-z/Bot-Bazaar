import { Component, inject, signal } from "@angular/core";
import type { OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { PUBLIC_CONFIG } from "./public-config";
import { MarketUpdates } from "./market-updates";
import { createActivityReads } from "./activity-reader";
import { ActivityFeed } from "./activity-feed";
import type { ActivityFeedState } from "./activity-feed";
import { CompletionFeedback } from "./market-feedback";

@Component({
  selector: "app-activity",
  imports: [DatePipe],
  templateUrl: "./activity.component.html",
  styleUrl: "./activity.component.css",
})
export class ActivityComponent implements OnInit, OnDestroy {
  private readonly feedback = new CompletionFeedback();
  protected readonly completed = signal<readonly string[]>([]);
  private feedbackTimer?: ReturnType<typeof setTimeout>;
  private receive(state: ActivityFeedState): void {
    this.state.set(state);
    const ids = this.feedback.accept(state, Date.now());
    if (state.chainStatus !== "ready" || state.hasMore || state.historyGap) {
      clearTimeout(this.feedbackTimer);
      this.completed.set([]);
    }
    if (!ids.length) return;
    clearTimeout(this.feedbackTimer);
    this.completed.set(ids);
    this.feedbackTimer = setTimeout(() => this.completed.set([]), 6000);
    this.updates.notify();
  }
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
    (state) => this.receive(state),
    () => this.updates.notify(),
  );
  private readonly visibility = (): void => {
    if (document.hidden) {
      this.feed.stop();
      this.feedback.reset();
      clearTimeout(this.feedbackTimer);
      this.completed.set([]);
    } else this.feed.start();
  };
  ngOnInit(): void {
    document.addEventListener("visibilitychange", this.visibility);
    this.visibility();
  }
  ngOnDestroy(): void {
    document.removeEventListener("visibilitychange", this.visibility);
    this.feed.stop();
    clearTimeout(this.feedbackTimer);
  }
  protected refresh(): void {
    void this.feed.refresh();
  }
  protected reset(): void {
    this.feedback.reset();
    clearTimeout(this.feedbackTimer);
    this.completed.set([]);
    this.feed.reset();
  }
}
