import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { ReadClock } from "./read-clock";
import { playerReadStale } from "./degraded-states";
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
  private readonly clock = inject(ReadClock);
  protected readonly stale = computed(() =>
    playerReadStale(this.state().observation, this.clock.now()),
  );
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
    (context, identityVersion) =>
      this.wallet.session.submitRegistration(context, identityVersion),
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
        wallet.identityVersion,
      );
    });
  }
  protected register(): void {
    this.syncAccount();
    void this.controller.register();
  }
  protected refresh(): void {
    this.syncAccount();
    void this.controller.refresh();
  }
  private syncAccount(): void {
    const wallet = this.wallet.state();
    this.controller.setAccount(
      wallet.status === "connected" ? wallet.accountId : null,
      wallet.identityVersion,
    );
  }
}
