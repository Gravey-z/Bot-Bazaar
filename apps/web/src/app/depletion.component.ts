import { Component, computed, input, signal } from "@angular/core";
import type { OnInit, OnDestroy } from "@angular/core";
import { ReplayLoader } from "./replay-loader";
import { replayPageUrl } from "./replay-navigation";
import { historicalAlternative } from "./depletion-guidance";
import type {
  ArchiveAvailability,
  DepletionGuidance,
} from "./depletion-guidance";

@Component({
  selector: "app-depletion",
  templateUrl: "./depletion.component.html",
  styleUrl: "./depletion.component.css",
})
export class DepletionComponent implements OnInit, OnDestroy {
  readonly guidance = input.required<DepletionGuidance>();
  protected readonly replayUrl = replayPageUrl(location.href, true);
  private readonly availability = signal<ArchiveAvailability>("loading");
  protected readonly historical = computed(() =>
    historicalAlternative(this.availability()),
  );
  private readonly abort = new AbortController();
  ngOnInit(): void {
    // Only the static index is read. The historical page validates the chosen
    // file before playback; neither this link nor its availability runs AI.
    void new ReplayLoader(new URL(document.baseURI))
      .index(this.abort.signal)
      .then(
        (index) => {
          if (!this.abort.signal.aborted)
            this.availability.set(index.entries.length ? "available" : "empty");
        },
        () => {
          if (!this.abort.signal.aborted) this.availability.set("unavailable");
        },
      );
  }
  ngOnDestroy(): void {
    this.abort.abort();
  }
}
