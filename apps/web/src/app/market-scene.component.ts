import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { MarketUpdates } from "./market-updates";
import type { OnDestroy, OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import type { MerchantId, Resource } from "@bot-bazaar/shared";
import type { Merchant } from "@bot-bazaar/chain";
import { PUBLIC_CONFIG } from "./public-config";
import {
  createMarketReader,
  MarketFeed,
  formatMarketAmount,
} from "./market-reader";
import type { MarketViewState } from "./market-reader";
import { merchantProfiles, marketResources } from "./merchant-profiles";
import { marketNotice } from "./degraded-states";
import { SnapshotFeedback } from "./market-feedback";
import type { ValueChange } from "./market-feedback";

@Component({
  selector: "app-market-scene",
  imports: [DatePipe],
  templateUrl: "./market-scene.component.html",
  styleUrl: "./market-scene.component.css",
})
export class MarketSceneComponent implements OnInit, OnDestroy {
  private readonly feedback = new SnapshotFeedback();
  protected readonly changes = signal<readonly ValueChange[]>([]);
  protected readonly alternateFeedback = signal(false);
  private feedbackTimer?: ReturnType<typeof setTimeout>;
  protected changed(key: string): boolean {
    return this.changes().some((change) => change.key === key);
  }
  protected merchantChanges(id: MerchantId): readonly ValueChange[] {
    return this.changes().filter((change) => change.merchant === id);
  }
  private receive(state: MarketViewState): void {
    this.state.set(state);
    const changes = this.feedback.accept(state);
    if (changes === null) return;
    clearTimeout(this.feedbackTimer);
    this.changes.set(changes);
    if (changes.length) this.alternateFeedback.update((value) => !value);
    if (changes.length)
      this.feedbackTimer = setTimeout(() => this.changes.set([]), 6000);
  }
  private readonly updates = inject(MarketUpdates);
  protected readonly config = inject(PUBLIC_CONFIG);
  protected readonly profiles = merchantProfiles;
  protected readonly resources = marketResources;
  protected readonly format = formatMarketAmount;
  protected readonly state = signal<MarketViewState>({
    observation: null,
    status: "loading",
    refreshing: false,
    readFailed: false,
  });
  protected readonly selectedId = signal<MerchantId | null>(null);
  protected readonly notice = computed(() => marketNotice(this.state()));
  protected readonly selectedProfile = computed(
    () =>
      this.profiles.find((profile) => profile.id === this.selectedId()) ?? null,
  );
  protected readonly selectedMerchant = computed(() =>
    this.merchant(this.selectedId()),
  );
  private readonly feed = new MarketFeed(
    createMarketReader(this.config),
    (state) => this.receive(state),
  );
  private readonly visibilityChanged = (): void => {
    if (document.hidden) {
      this.feed.stop();
      this.feedback.reset(this.state().observation);
      clearTimeout(this.feedbackTimer);
      this.changes.set([]);
    } else this.feed.start();
  };
  constructor() {
    effect(() => {
      this.updates.revision();
      untracked(() => this.refresh());
    });
  }

  ngOnInit(): void {
    document.addEventListener("visibilitychange", this.visibilityChanged);
    this.visibilityChanged();
  }
  ngOnDestroy(): void {
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.feed.stop();
    clearTimeout(this.feedbackTimer);
  }
  protected merchant(id: MerchantId | null): Merchant | null {
    return (
      this.state().observation?.market.data.merchants.find(
        (row) => row.merchant_id === id,
      ) ?? null
    );
  }
  protected listing(
    id: MerchantId,
    resource: Resource,
  ): Merchant["listings"][number] | null {
    return (
      this.merchant(id)?.listings.find((row) => row.resource === resource) ??
      null
    );
  }
  protected inspect(id: MerchantId): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
  }
  protected refresh(): void {
    void this.feed.refresh();
  }
}
