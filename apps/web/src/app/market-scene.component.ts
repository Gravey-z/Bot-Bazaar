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

@Component({
  selector: "app-market-scene",
  imports: [DatePipe],
  templateUrl: "./market-scene.component.html",
  styleUrl: "./market-scene.component.css",
})
export class MarketSceneComponent implements OnInit, OnDestroy {
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
  protected readonly selectedProfile = computed(
    () =>
      this.profiles.find((profile) => profile.id === this.selectedId()) ?? null,
  );
  protected readonly selectedMerchant = computed(() =>
    this.merchant(this.selectedId()),
  );
  private readonly feed = new MarketFeed(
    createMarketReader(this.config),
    (state) => this.state.set(state),
  );
  private readonly visibilityChanged = (): void => {
    if (document.hidden) this.feed.stop();
    else this.feed.start();
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
