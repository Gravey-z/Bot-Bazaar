import { ConfigurationError, deploymentIdentity } from "@bot-bazaar/shared";
import type { PublicConfig, WebDeployment } from "@bot-bazaar/shared";
import { WalletContextStore } from "./wallet-context";
import type { WalletStorage } from "./wallet-context";
import { transactionExplorer } from "./activity-proof";

export interface DeploymentStorage extends WalletStorage {
  readonly length: number;
  key(index: number): string | null;
}
export interface DeploymentView {
  readonly pending: boolean;
  readonly canSwitch: boolean;
  readonly locked: boolean;
  readonly message: string;
  readonly archives: readonly {
    contractId: string;
    status: string;
    hash: string;
    url: string;
  }[];
}
class StorageUnavailable extends Error {}
const fail = (message: string): never => {
  throw new ConfigurationError(message);
};
const prefix = "bot-bazaar:wallet-context:v1:testnet:";

// A tab selects one published identity. Storage never supplies RPC/worker URLs.
export class DeploymentSession {
  readonly selected: PublicConfig;
  private readonly key: string;
  private readonly route: URL;
  private usable = true;
  constructor(
    readonly published: WebDeployment,
    private readonly storage: DeploymentStorage,
    pageUrl: string,
  ) {
    this.route = new URL(pageUrl);
    this.route.search = "";
    this.route.hash = "";
    this.key = `bot-bazaar:selected-market:v1:${this.route.origin}${this.route.pathname}`;
    this.selected = published.current;
    try {
      const raw = this.read(this.key),
        pending = this.pendingContracts();
      let selected = published.current;
      if (raw !== null) selected = this.resolvePin(raw);
      else if (pending.length === 1)
        selected =
          this.lookup(pending[0]!) ??
          fail(
            "The original pending market is not retained in this site's deployment history. Restore its configuration; saved wallet work has not been changed.",
          );
      else if (pending.length > 1)
        fail(
          "Multiple original markets have saved pending wallet work. Restore and reconcile those original deployments before selecting a market.",
        );
      if (pending.some((id) => id !== selected.contractId))
        fail(
          "Saved wallet work belongs to another market. Reconcile the original deployment before switching; no records were removed.",
        );
      this.selected = selected;
      this.pin(selected);
    } catch (error) {
      if (!(error instanceof StorageUnavailable)) throw error;
      this.usable = false; // Spectating works; the wallet storage wrapper fails closed.
    }
  }
  private access<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw new StorageUnavailable();
    }
  }
  private read(key: string): string | null {
    return this.access(() => this.storage.getItem(key));
  }
  private lookup(contractId: string): PublicConfig | undefined {
    return [this.published.current, ...this.published.retained].find(
      (config) => config.contractId === contractId,
    );
  }
  private resolvePin(raw: string): PublicConfig {
    if (raw.length > 512)
      return fail(
        "Saved market selection is invalid; wallet records are preserved.",
      );
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw);
    } catch {
      return fail(
        "Saved market selection is unreadable; wallet records are preserved.",
      );
    }
    if (
      !value ||
      Object.keys(value).sort().join() !==
        "contractId,mode,networkId,version" ||
      value["version"] !== 1 ||
      value["networkId"] !== "testnet" ||
      typeof value["contractId"] !== "string"
    )
      return fail(
        "Saved market selection is invalid; wallet records are preserved.",
      );
    if (value["mode"] !== this.published.mode)
      return fail(
        "Public and rehearsal pages must use separate browser origins or paths. The original market selection and wallet records are preserved.",
      );
    return (
      this.lookup(value["contractId"]) ??
      fail(
        "This tab's original market is missing from the published deployment history. Restore its configuration; pending records have not been changed.",
      )
    );
  }
  private pin(config: PublicConfig): void {
    const value = JSON.stringify({
      version: 1,
      networkId: config.networkId,
      contractId: config.contractId,
      mode: this.published.mode,
    });
    this.access(() => this.storage.setItem(this.key, value));
    if (this.read(this.key) !== value) throw new StorageUnavailable();
  }
  private pendingContracts(): string[] {
    const count = this.access(() => this.storage.length);
    if (!Number.isSafeInteger(count) || count < 0 || count > 512)
      return fail(
        "Wallet storage cannot be inspected safely; no market switch is allowed.",
      );
    const contracts = new Set<string>();
    for (let index = 0; index < count; index++) {
      const key = this.access(() => this.storage.key(index));
      if (!key?.startsWith(prefix) || key.endsWith(":last")) continue;
      const id = key.slice(prefix.length),
        raw = this.read(key);
      if (raw === null) continue;
      if (raw.length > 4096)
        return fail(
          "Saved wallet work is unreadable; it has not been removed.",
        );
      let callback: URL;
      try {
        callback = new URL(JSON.parse(raw).returnUrl);
      } catch {
        return fail(
          "Saved wallet work is unreadable; it has not been removed.",
        );
      }
      if (
        callback.origin !== this.route.origin ||
        callback.pathname !== this.route.pathname
      )
        continue;
      try {
        const context = new WalletContextStore(
          { networkId: "testnet", contractId: id },
          this.storage,
          this.route.href,
        ).read();
        if (context) contracts.add(id);
      } catch {
        return fail(
          "Saved wallet work is invalid; restore the original market before switching. No record was deleted.",
        );
      }
    }
    return [...contracts];
  }
  assertSelected(): void {
    if (!this.usable)
      throw new Error(
        "Market selection storage is unavailable; wallet actions are disabled.",
      );
    const raw = this.read(this.key);
    if (
      raw === null ||
      deploymentIdentity(this.resolvePin(raw)) !==
        deploymentIdentity(this.selected)
    )
      throw new Error(
        "Market selection changed. Reload before using the wallet; original records are preserved.",
      );
    this.pendingContracts();
    for (const config of this.published.retained)
      new WalletContextStore(
        config,
        this.storage,
        this.route.href,
      ).lastTransaction();
  }
  view(): DeploymentView {
    try {
      this.assertSelected();
      const pending = this.pendingContracts().length > 0;
      const archives: {
        contractId: string;
        status: string;
        hash: string;
        url: string;
      }[] = [];
      for (const config of this.published.retained) {
        if (config.contractId === this.selected.contractId) continue;
        const archive = new WalletContextStore(
          config,
          this.storage,
          this.route.href,
        ).lastTransaction();
        const url = transactionExplorer(config, archive?.transactionHash);
        if (archive?.transactionHash && url)
          archives.push({
            contractId: config.contractId,
            status: archive.lifecycle!.phase,
            hash: archive.transactionHash,
            url,
          });
      }
      return {
        pending,
        canSwitch:
          !pending &&
          this.selected.contractId !== this.published.current.contractId,
        locked: false,
        message: pending
          ? "Original wallet work is still pending. Check it on this market; switching is blocked and no call is resent."
          : this.selected.contractId !== this.published.current.contractId
            ? "This tab stays on its original market until you explicitly choose the newly published market."
            : "Balances and one-time grants belong to this contract. Rehearsals use a separate market.",
        archives,
      };
    } catch {
      return {
        pending: true,
        canSwitch: false,
        locked: true,
        message:
          "Market selection or saved wallet records cannot be verified. Spectating remains available; wallet actions and switching are blocked. No saved record was deleted.",
        archives: [],
      };
    }
  }
  selectPublished(): void {
    this.assertSelected();
    if (this.pendingContracts().length)
      return fail(
        "Reconcile original wallet work before choosing another market.",
      );
    if (!this.view().canSwitch)
      return fail("No verified market switch is available.");
    this.pin(this.published.current);
    this.usable = false; // Old components cannot sign in the interval before reload.
  }
}
