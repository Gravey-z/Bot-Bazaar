import { Injectable, effect, inject, signal, untracked } from "@angular/core";
import { WalletService } from "./wallet.service";
import { PUBLIC_CONFIG } from "./public-config";
import {
  createPurchaseReads,
  createRegistrationReads,
} from "./registration-reader";
import { MarketUpdates } from "./market-updates";
import { TransactionLifecycle } from "./transaction-lifecycle";
import type { TransactionView } from "./transaction-lifecycle";

@Injectable({ providedIn: "root" })
export class TransactionService {
  private readonly wallet = inject(WalletService);
  private readonly updates = inject(MarketUpdates);
  private readonly config = inject(PUBLIC_CONFIG);
  private readonly registration = createRegistrationReads(this.config);
  private readonly purchase = createPurchaseReads(this.config);
  readonly state = signal<TransactionView>({
    record: null,
    phase: "idle",
    checking: false,
    message: "",
  });
  readonly controller = new TransactionLifecycle(
    this.wallet.context,
    (context) =>
      context.call?.method === "register_player"
        ? this.registration.receipt(context)
        : this.purchase.receipt(context),
    (state) => this.state.set(state),
    () => {
      this.wallet.session.syncPending();
      this.updates.notify();
    },
  );
  constructor() {
    effect(() => {
      this.wallet.state();
      untracked(() => this.controller.sync());
    });
  }
}
