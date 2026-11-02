import { Component, inject } from "@angular/core";
import type { OnDestroy, OnInit } from "@angular/core";
import { WalletService } from "./wallet.service";

@Component({
  selector: "app-wallet",
  templateUrl: "./wallet.component.html",
  styleUrl: "./wallet.component.css",
})
export class WalletComponent implements OnInit, OnDestroy {
  protected readonly wallet = inject(WalletService);
  private timer?: ReturnType<typeof setInterval>;
  private readonly refresh = (): void => {
    if (!document.hidden) void this.wallet.session.refresh();
  };
  private readonly storageChanged = (event: StorageEvent): void => {
    if (event.key === null || event.key.startsWith("bot-bazaar:wallet:"))
      this.wallet.session.preferencesChanged();
    else this.refresh();
  };
  ngOnInit(): void {
    void this.wallet.session.restore(location.href);
    window.addEventListener("focus", this.refresh);
    window.addEventListener("pageshow", this.refresh);
    window.addEventListener("storage", this.storageChanged);
    document.addEventListener("visibilitychange", this.refresh);
    this.timer = setInterval(this.refresh, 10000);
  }
  ngOnDestroy(): void {
    window.removeEventListener("focus", this.refresh);
    window.removeEventListener("pageshow", this.refresh);
    window.removeEventListener("storage", this.storageChanged);
    document.removeEventListener("visibilitychange", this.refresh);
    clearInterval(this.timer);
    this.wallet.session.destroy();
  }
  protected connect(): void {
    void this.wallet.session.connect();
  }
  protected disconnect(): void {
    void this.wallet.session.disconnect();
  }
  protected select(event: Event): void {
    if (event.target instanceof HTMLSelectElement)
      this.wallet.session.select(event.target.value);
  }
  protected retry(): void {
    void this.wallet.session.refresh();
  }
}
