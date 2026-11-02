import { isTestnetAccount } from "./wallet-context";
import type {
  WalletContext,
  WalletContextStore,
  WalletStorage,
} from "./wallet-context";
import type { PublicConfig } from "@bot-bazaar/shared";

export interface WalletPort {
  accounts(): Promise<readonly { accountId: string }[]>;
  connect(): Promise<readonly { accountId: string }[]>;
  disconnect(): Promise<void>;
  subscribe(changed: () => void): () => void;
}
export interface WalletState {
  readonly status:
    "disconnected" | "checking" | "connecting" | "connected" | "blocked";
  readonly accounts: readonly string[];
  readonly accountId: string | null;
  readonly message: string;
  readonly pending: WalletContext | null;
}
const initial: WalletState = {
  status: "disconnected",
  accounts: [],
  accountId: null,
  message: "",
  pending: null,
};

export class WalletSession {
  private current: WalletState = initial;
  private port: Promise<WalletPort> | null = null;
  private unsubscribe?: () => void;
  private generation = 0;
  private busy = false;
  private destroyed = false;
  private enabled = false;
  private preferred: string | null = null;
  private readonly hint: string;
  constructor(
    config: Pick<PublicConfig, "networkId" | "contractId">,
    private readonly storage: WalletStorage,
    private readonly context: WalletContextStore,
    private readonly load: () => Promise<WalletPort>,
    private readonly changed: (state: WalletState) => void,
  ) {
    this.hint = `bot-bazaar:wallet:${config.networkId}:${config.contractId}`;
  }
  get state(): WalletState {
    return this.current;
  }
  private publish(values: Partial<WalletState>): void {
    if (this.destroyed) return;
    this.current = { ...this.current, ...values };
    this.changed(this.current);
  }
  private async adapter(): Promise<WalletPort> {
    if (!this.port)
      this.port = this.load()
        .then((port) => {
          if (!this.destroyed)
            this.unsubscribe = port.subscribe(() => {
              void this.refresh();
            });
          return port;
        })
        .catch((error: unknown) => {
          this.port = null;
          throw error;
        });
    return this.port;
  }
  private accept(accounts: readonly { accountId: string }[]): void {
    if (
      !Array.isArray(accounts) ||
      accounts.length > 16 ||
      accounts.some((row) => !row || !isTestnetAccount(row.accountId))
    )
      throw new Error("Unsupported account/network");
    const ids = [...new Set(accounts.map((row) => row.accountId))];
    const selected = ids.includes(this.preferred ?? "")
      ? this.preferred
      : (ids[0] ?? null);
    this.preferred = selected;
    this.publish({
      status: ids.length ? "connected" : "disconnected",
      accounts: ids,
      accountId: selected,
      message: "",
    });
  }
  async restore(pageUrl: string): Promise<void> {
    try {
      const pending = this.context.read();
      this.publish({
        pending,
        message: this.context.returned(pageUrl)
          ? "Wallet return received. Any transaction still needs chain verification."
          : pending?.kind === "transaction"
            ? "An earlier transaction is unresolved. It will not be sent again."
            : "",
      });
      this.enabled =
        !!pending || this.storage.getItem(this.hint) === "meteor-wallet";
      if (this.enabled) await this.refresh();
    } catch {
      this.publish({
        status: "blocked",
        accountId: null,
        accounts: [],
        message:
          "Saved wallet context could not be read. Reconnect is paused to preserve unresolved work.",
      });
    }
  }
  async refresh(): Promise<void> {
    if (this.busy || this.destroyed || !this.enabled) return;
    this.busy = true;
    const generation = ++this.generation;
    this.publish({ status: "checking", accountId: null, accounts: [] });
    try {
      const accounts = await (await this.adapter()).accounts();
      if (generation !== this.generation || this.destroyed) return;
      this.accept(accounts);
      const pending = this.context.read();
      if (pending?.kind === "connect" && accounts.length) {
        this.context.finishConnect(pending.id);
        this.publish({ pending: null });
      } else if (pending?.kind === "transaction")
        this.publish({
          message:
            pending.accountId === this.current.accountId
              ? "An earlier transaction is unresolved. It will not be sent again."
              : "An earlier transaction belongs to another account. Its context is preserved.",
        });
    } catch {
      if (generation === this.generation)
        this.publish({
          status: "blocked",
          accounts: [],
          accountId: null,
          message:
            "Could not verify the Testnet wallet. Check the wallet network, then retry.",
        });
    } finally {
      this.busy = false;
    }
  }
  async connect(): Promise<void> {
    if (this.busy || this.destroyed || this.current.status === "connected")
      return;
    this.busy = true;
    const generation = ++this.generation;
    let id: string | undefined;
    try {
      const pending = this.context.read();
      if (pending?.kind === "transaction")
        throw new Error("unresolved transaction");
      if (pending?.kind === "connect") this.context.finishConnect(pending.id);
      const context = this.context.beginConnect();
      this.enabled = true;
      id = context.id;
      this.publish({
        status: "connecting",
        accounts: [],
        accountId: null,
        pending: context,
        message:
          "Approve the Testnet connection in Meteor. No transaction or session key is requested.",
      });
      const adapter = await this.adapter();
      if (generation !== this.generation || this.destroyed) return;
      await adapter.connect();
      const accounts = await adapter.accounts();
      if (generation !== this.generation || this.destroyed) return;
      if (!accounts.length) throw new Error("No connected account");
      this.accept(accounts);
      this.storage.setItem(this.hint, "meteor-wallet");
      this.context.finishConnect(id);
      this.publish({ pending: null });
    } catch {
      if (generation !== this.generation || this.destroyed) return;
      // A failed connection is safe to retry. A transaction context is never cleared here.
      try {
        if (id) this.context.finishConnect(id);
      } catch {
        /* Preserve unreadable context. */
      }
      this.publish({
        status: "blocked",
        accounts: [],
        accountId: null,
        message:
          "Wallet connection was not completed. Check Meteor is on Testnet and try again.",
        pending: this.contextSafely(),
      });
    } finally {
      this.busy = false;
    }
  }
  private contextSafely(): WalletContext | null {
    try {
      return this.context.read();
    } catch {
      return this.current.pending;
    }
  }
  select(accountId: string): void {
    if (
      this.current.status === "connected" &&
      this.current.accounts.includes(accountId)
    ) {
      this.preferred = accountId;
      this.publish({ accountId });
    }
  }
  preferencesChanged(): void {
    try {
      if (this.storage.getItem(this.hint) !== "meteor-wallet") {
        this.enabled = false;
        this.preferred = null;
        ++this.generation;
        this.publish({
          status: "disconnected",
          accountId: null,
          accounts: [],
          message:
            "Wallet disconnected in another tab. Any unresolved transaction is retained.",
        });
      } else if (this.enabled) void this.refresh();
    } catch {
      ++this.generation;
      this.enabled = false;
      this.publish({
        status: "blocked",
        accountId: null,
        accounts: [],
        message:
          "Wallet storage is unavailable. Reconnect to check the session.",
      });
    }
  }
  async disconnect(): Promise<void> {
    if (this.destroyed) return;
    this.enabled = false;
    this.preferred = null;
    ++this.generation;
    this.publish({
      status: "disconnected",
      accountId: null,
      accounts: [],
      message:
        "Disconnected from this page. Unresolved transaction context is retained.",
    });
    try {
      this.storage.removeItem(this.hint);
      const pending = this.context.read();
      if (pending?.kind === "connect") {
        this.context.finishConnect(pending.id);
        this.publish({ pending: null });
      }
      if (this.port) await (await this.port).disconnect();
    } catch {
      this.publish({
        message:
          "Disconnected locally. The wallet could not confirm sign-out; reconnect to check its session.",
      });
    }
  }
  destroy(): void {
    this.destroyed = true;
    ++this.generation;
    this.unsubscribe?.();
  }
}
