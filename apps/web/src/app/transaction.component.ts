import { Component, inject, signal } from "@angular/core";
import type { OnInit, OnDestroy } from "@angular/core";
import { TransactionService } from "./transaction.service";
import { WalletService } from "./wallet.service";

@Component({
  selector: "app-transaction",
  templateUrl: "./transaction.component.html",
  styleUrl: "./transaction.component.css",
})
export class TransactionComponent implements OnInit, OnDestroy {
  protected readonly transactions = inject(TransactionService);
  private readonly wallet = inject(WalletService);
  protected readonly hash = signal("");
  private timer?: ReturnType<typeof setInterval>;
  private readonly refreshVisible = (): void => {
    if (!document.hidden) void this.transactions.controller.refresh(false);
  };
  ngOnInit(): void {
    void this.transactions.controller.restore(location.href).then((result) => {
      if (result === "accepted") {
        const url = new URL(location.href);
        for (const key of [
          "bbWalletState",
          "transactionHashes",
          "errorCode",
          "errorMessage",
          "account_id",
          "networkId",
          "contractId",
        ])
          url.searchParams.delete(key);
        history.replaceState(history.state, "", url.href);
        this.wallet.session.syncPending();
      }
    });
    document.addEventListener("visibilitychange", this.refreshVisible);
    window.addEventListener("focus", this.refreshVisible);
    window.addEventListener("pageshow", this.refreshVisible);
    this.timer = setInterval(this.refreshVisible, 3000);
  }
  ngOnDestroy(): void {
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.refreshVisible);
    window.removeEventListener("focus", this.refreshVisible);
    window.removeEventListener("pageshow", this.refreshVisible);
    this.transactions.controller.stop();
  }
  protected check(): void {
    void this.transactions.controller.refresh();
  }
  protected changeHash(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.hash.set(event.target.value);
  }
  protected recover(): void {
    void this.transactions.controller.recover(this.hash());
  }
}
