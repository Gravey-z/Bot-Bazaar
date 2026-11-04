import { Component, computed, signal } from "@angular/core";
import type { OnInit, OnDestroy } from "@angular/core";
import { ReplayLoader } from "./replay-loader";
import { ReplayPlayback } from "./replay-playback";
import type { ReplayView } from "./replay-playback";
import { replayPageUrl } from "./replay-navigation";
import { merchantProfiles, marketResources } from "./merchant-profiles";
import { merchantNames } from "@bot-bazaar/shared";

@Component({
  selector: "app-root",
  templateUrl: "./replay.component.html",
  styleUrl: "./replay.component.css",
})
export class ReplayComponent implements OnInit, OnDestroy {
  protected readonly liveUrl = replayPageUrl(location.href, false);
  protected readonly profiles = merchantProfiles;
  protected readonly names = merchantNames;
  protected readonly resources = marketResources;
  protected readonly state = signal<ReplayView>({
    phase: "loading",
    entries: [],
    replay: null,
    frames: [],
    position: 0,
    playing: false,
    message: "",
  });
  protected readonly frame = computed(
    () => this.state().frames[this.state().position] ?? null,
  );
  protected readonly initializationUrl = computed(() => {
    const hash = this.state().replay?.initialization.transactionHash;
    return hash ? `https://testnet.nearblocks.io/txns/${hash}` : null;
  });
  private readonly playback = new ReplayPlayback(
    new ReplayLoader(new URL(document.baseURI)),
    (state) => this.state.set(state),
  );
  private readonly visibility = (): void => {
    if (document.hidden) this.playback.pause();
  };
  ngOnInit(): void {
    void this.playback.start();
    document.addEventListener("visibilitychange", this.visibility);
  }
  ngOnDestroy(): void {
    this.playback.stop();
    document.removeEventListener("visibilitychange", this.visibility);
  }
  protected utcNanoseconds(value: string): string {
    return new Date(Number(BigInt(value) / 1000000n)).toISOString();
  }
  protected select(runId: string): void {
    void this.playback.select(runId);
  }
  protected retry(): void {
    void this.playback.start();
  }
  protected seek(position: number): void {
    this.playback.seek(position);
  }
  protected toggle(): void {
    if (this.state().playing) this.playback.pause();
    else this.playback.play();
  }
}
