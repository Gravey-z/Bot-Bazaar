import { Injectable, inject, signal } from "@angular/core";
import { PUBLIC_CONFIG } from "./public-config";
import { createWalletPort } from "./wallet-adapter";
import { WalletContextStore } from "./wallet-context";
import { WalletSession } from "./wallet-session";
import type { WalletState } from "./wallet-session";

@Injectable({ providedIn: "root" })
export class WalletService {
  private readonly config = inject(PUBLIC_CONFIG);
  readonly state = signal<WalletState>({
    status: "disconnected",
    accounts: [],
    accountId: null,
    message: "",
    pending: null,
  });
  // Access storage inside methods so a browser denying storage yields a visible
  // wallet error without taking down the spectator market.
  private readonly preferences = {
    getItem: (key: string): string | null => localStorage.getItem(key),
    setItem: (key: string, value: string): void =>
      localStorage.setItem(key, value),
    removeItem: (key: string): void => localStorage.removeItem(key),
  };
  readonly context = new WalletContextStore(
    this.config,
    {
      getItem: (key) => sessionStorage.getItem(key),
      setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key),
    },
    location.href,
  );
  readonly session = new WalletSession(
    this.config,
    this.preferences,
    this.context,
    () => createWalletPort(this.config, this.preferences),
    (state) => this.state.set(state),
    (context) => history.replaceState(history.state, "", context.returnUrl),
  );
}
