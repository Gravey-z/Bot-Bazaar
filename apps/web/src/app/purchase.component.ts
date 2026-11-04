import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { PUBLIC_CONFIG } from "./public-config";
import { WalletService } from "./wallet.service";
import { MarketUpdates } from "./market-updates";
import { PurchaseController } from "./purchase";
import type { PurchaseState } from "./purchase";
import { createPurchaseReads } from "./registration-reader";
import { formatMarketAmount } from "./market-reader";
import { merchantProfiles, marketResources } from "./merchant-profiles";
import { ReadClock } from "./read-clock";
import { playerReadStale } from "./degraded-states";

@Component({
  selector: "app-purchase",
  templateUrl: "./purchase.component.html",
  styleUrl: "./purchase.component.css",
})
export class PurchaseComponent {
  protected readonly wallet = inject(WalletService);
  protected readonly merchants = merchantProfiles;
  protected readonly resources = marketResources;
  protected readonly format = formatMarketAmount;
  private readonly updates = inject(MarketUpdates);
  private readonly clock = inject(ReadClock);
  protected readonly stale = computed(() =>
    playerReadStale(this.state().observation, this.clock.now()),
  );
  protected readonly state = signal<PurchaseState>({
    accountId: null,
    merchantId: "rex",
    resource: "crystal",
    quantity: "1",
    phase: "disconnected",
    observation: null,
    quote: null,
    reviewed: null,
    validation: "Connect a registered Testnet player wallet to buy.",
    message: "",
  });
  protected readonly listing = computed(() => {
    const state = this.state();
    return (
      state.observation?.market.data.merchants
        .find((row) => row.merchant_id === state.merchantId)
        ?.listings.find((row) => row.resource === state.resource) ?? null
    );
  });
  private readonly controller = new PurchaseController(
    createPurchaseReads(inject(PUBLIC_CONFIG)),
    this.wallet.context,
    (context, identityVersion) =>
      this.wallet.session.submitPurchase(context, identityVersion),
    (state) => this.state.set(state),
    () => this.wallet.session.syncPending(),
    () => this.updates.notify(),
  );
  constructor() {
    effect(() => {
      this.updates.revision();
      untracked(() => {
        void this.controller.refresh();
      });
    });
    effect(() => {
      const wallet = this.wallet.state();
      this.controller.setAccount(
        wallet.status === "connected" ? wallet.accountId : null,
        wallet.identityVersion,
      );
    });
  }
  protected edit(
    field: "merchant" | "resource" | "quantity",
    event: Event,
  ): void {
    this.syncAccount();
    if (!(
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    ))
      return;
    const value = event.target.value;
    const current = this.state();
    const merchant =
      field === "merchant"
        ? this.merchants.find((row) => row.id === value)?.id
        : current.merchantId;
    const resource =
      field === "resource"
        ? this.resources.find((row) => row.id === value)?.id
        : current.resource;
    if (merchant && resource)
      this.controller.edit(
        merchant,
        resource,
        field === "quantity" ? value : current.quantity,
      );
  }
  protected refresh(): void {
    this.syncAccount();
    void this.controller.refresh();
  }
  protected review(): void {
    this.syncAccount();
    void this.controller.review();
  }
  protected confirm(): void {
    this.syncAccount();
    void this.controller.confirm();
  }
  private syncAccount(): void {
    const wallet = this.wallet.state();
    this.controller.setAccount(
      wallet.status === "connected" ? wallet.accountId : null,
      wallet.identityVersion,
    );
  }
}
