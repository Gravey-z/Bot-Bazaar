import { Component, effect, inject, signal, untracked } from "@angular/core";
import { MarketUpdates } from "./market-updates";
import { PUBLIC_CONFIG } from "./public-config";
import { WalletService } from "./wallet.service";
import { RegistrationController } from "./registration";
import type { RegistrationState } from "./registration";
import { createRegistrationReads } from "./registration-reader";
import { formatMarketAmount } from "./market-reader";

@Component({
  selector: "app-registration",
  templateUrl: "./registration.component.html",
  styleUrl: "./registration.component.css",
})
export class RegistrationComponent {
  private readonly updates = inject(MarketUpdates);
  protected readonly wallet = inject(WalletService);
  protected readonly format = formatMarketAmount;
  protected readonly state = signal<RegistrationState>({
    accountId: null,
    status: "disconnected",
    observation: null,
    attempt: "idle",
    message: "",
  });
  private readonly controller = new RegistrationController(
    createRegistrationReads(inject(PUBLIC_CONFIG)),
    this.wallet.context,
    (context) => this.wallet.session.submitRegistration(context),
    (state) => this.state.set(state),
    () => this.wallet.session.syncPending(),
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
      );
    });
  }
  protected register(): void {
    void this.controller.register();
  }
  protected refresh(): void {
    void this.controller.refresh();
  }
}
