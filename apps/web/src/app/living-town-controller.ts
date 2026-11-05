import type { LivingTownAttempt } from "./living-town-transactions";
import type {
  LivingTownReceiptStatus,
  LivingTownMethod,
  livingTownPlayer,
  livingTownShop,
  livingTownLedger,
  livingTownTown,
  livingTownListing,
} from "@bot-bazaar/chain";
export type TownPlayer = ReturnType<typeof livingTownPlayer>;
export type TownShop = ReturnType<typeof livingTownShop>;
export type TownLedger = ReturnType<typeof livingTownLedger>;
export interface TownObservation {
  accountId: string | null;
  town: ReturnType<typeof livingTownTown>;
  player: TownPlayer | null;
  shop: TownShop | null;
  ledger: TownLedger | null;
  listings: ReturnType<typeof livingTownListing>[];
  receivedAt: number;
  stale: boolean;
  ownershipKnown: boolean;
  source: "chain" | "projection";
  ownershipUrl: string | null;
}
export interface TownPort {
  accounts(): Promise<readonly { accountId: string }[]>;
  connect(): Promise<readonly { accountId: string }[]>;
  disconnect(): Promise<void>;
  subscribe(changed: () => void): () => void;
  read(account: string | null): Promise<TownObservation>;
  prepare(
    account: string,
    method: LivingTownMethod,
    args: Record<string, unknown>,
  ): Promise<LivingTownAttempt>;
  submit(id: string): Promise<void>;
  pending(): Promise<LivingTownAttempt | null>;
  restore(): Promise<LivingTownAttempt | null>;
  reconcile(): Promise<LivingTownReceiptStatus | null>;
  recoverHash(id: string, hash: string): Promise<void>;
  discardPrepared(id: string): Promise<void>;
}
export interface TownState {
  phase: "preview" | "disconnected" | "loading" | "ready" | "unavailable";
  accountId: string | null;
  accounts: readonly string[];
  observation: TownObservation | null;
  pending: LivingTownAttempt | null;
  busy: boolean;
  transactionAvailable: boolean;
  message: string;
  ownershipUrl: string | null;
}
export const initialTownState: TownState = {
  phase: "preview",
  accountId: null,
  accounts: [],
  observation: null,
  pending: null,
  busy: false,
  transactionAvailable: false,
  message: "",
  ownershipUrl: null,
};
export function describeTownAttempt(a: LivingTownAttempt): string {
  const args = a.call.args;
  if (a.call.method === "register_player")
    return "Register player: one-time 100 game gold grant.";
  if (a.call.method === "create_shop" && "name" in args)
    return `Create shop: ${args.name}.`;
  if (a.call.method === "rename_shop" && "shop_id" in args)
    return `Rename shop #${args.shop_id}: ${args.name}.`;
  if ("quantity" in args)
    return `Buy ${args.quantity} ${args.item_id.replaceAll("_", " ")}: maximum ${args.max_total_price} game gold.`;
  return "Review the original saved request.";
}
const readFailureMessage =
  "Confirmed town data is unavailable. Your last known balances have not changed.";
export class LivingTownController {
  private value: TownState = { ...initialTownState };
  private epoch = 0;
  private stopped = false;
  private refreshing = false;
  private unsubscribe?: () => void;
  constructor(
    private readonly port: TownPort | null,
    private readonly changed: (state: TownState) => void,
    private readonly now: () => number = Date.now,
  ) {}
  get state(): TownState {
    return this.value;
  }
  private publish(patch: Partial<TownState>): void {
    if (!this.stopped) {
      this.value = { ...this.value, ...patch };
      this.changed(this.value);
    }
  }
  async start(): Promise<void> {
    if (!this.port || this.stopped) return;
    this.publish({ phase: "loading" });
    this.unsubscribe = this.port.subscribe(() => {
      void this.syncAccounts();
    });
    try {
      const pending = await this.port.restore();
      this.publish({ pending, transactionAvailable: true });
    } catch {
      this.publish({
        transactionAvailable: false,
        message:
          "Saved transaction details are unavailable. New actions remain blocked.",
      });
    }
    await this.syncAccounts();
  }
  private select(account: string | null, accounts: readonly string[]): void {
    if (account !== this.value.accountId) {
      this.epoch++;
      this.publish({
        accountId: account,
        accounts,
        observation: null,
        ownershipUrl: null,
        phase: "loading",
      });
    } else this.publish({ accounts });
  }
  async syncAccounts(): Promise<void> {
    if (!this.port || this.stopped) return;
    try {
      const accounts = (await this.port.accounts()).map((a) => a.accountId);
      if (this.stopped) return;
      this.select(
        accounts.includes(this.value.accountId ?? "")
          ? this.value.accountId
          : (accounts[0] ?? null),
        accounts,
      );
      await this.refresh();
    } catch {
      this.epoch++;
      this.publish({
        phase: "unavailable",
        observation: null,
        ownershipUrl: null,
        accountId: null,
        accounts: [],
        message:
          "Wallet connection could not be checked. Refresh to try again.",
      });
      await this.refresh();
    }
  }
  async connect(): Promise<void> {
    if (!this.port || this.value.busy) return;
    this.publish({ busy: true, message: "" });
    try {
      const rows = await this.port.connect();
      this.select(
        rows[0]?.accountId ?? null,
        rows.map((a) => a.accountId),
      );
    } catch {
      this.publish({ message: "Wallet connection was not completed." });
    } finally {
      this.publish({ busy: false });
    }
    await this.refresh();
  }
  async disconnect(): Promise<void> {
    if (!this.port || this.value.busy) return;
    this.epoch++;
    this.publish({
      accountId: null,
      accounts: [],
      observation: null,
      ownershipUrl: null,
      busy: true,
    });
    try {
      await this.port.disconnect();
    } catch {
      this.publish({ message: "Wallet disconnect could not be completed." });
    } finally {
      this.publish({ busy: false });
    }
    await this.refresh();
  }
  async chooseAccount(account: string): Promise<void> {
    if (!this.value.accounts.includes(account) || this.value.busy) return;
    this.select(account, this.value.accounts);
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.port || this.refreshing || this.value.busy || this.stopped)
      return;
    this.refreshing = true;
    const epoch = this.epoch,
      account = this.value.accountId;
    try {
      const observation = await this.port.read(account);
      if (
        this.stopped ||
        epoch !== this.epoch ||
        account !== this.value.accountId
      )
        return;
      if (observation.accountId !== account)
        throw new Error("Account mismatch");
      const recovered = this.value.message === readFailureMessage;
      this.publish({
        ...(recovered ? { message: "" } : {}),
        observation,
        ownershipUrl: observation.ownershipUrl,
        phase: account ? "ready" : "disconnected",
      });
    } catch {
      if (epoch === this.epoch)
        this.publish({
          phase: "unavailable",
          observation: this.value.observation
            ? { ...this.value.observation, stale: true }
            : null,
          message: readFailureMessage,
        });
    } finally {
      this.refreshing = false;
      if (epoch !== this.epoch && !this.stopped) void this.refresh();
    }
  }
  get canTransact(): boolean {
    return this.canAct();
  }
  private canAct(): boolean {
    return (
      !this.stopped &&
      !!this.port &&
      this.value.transactionAvailable &&
      !!this.value.accountId &&
      this.value.phase === "ready" &&
      !this.value.busy &&
      !this.value.pending &&
      !!this.value.observation?.ownershipKnown &&
      !this.value.observation.stale &&
      this.now() >= this.value.observation.receivedAt &&
      this.now() - this.value.observation.receivedAt <= 30000 &&
      !this.value.observation.town.paused
    );
  }
  async act(
    method: LivingTownMethod,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (!this.canAct()) return;
    this.epoch++;
    const account = this.value.accountId!,
      epoch = this.epoch,
      observation = this.value.observation!;
    if (method === "register_player" && observation.player) return;
    if (method === "create_shop" && (!observation.player || observation.shop))
      return;
    if (
      method === "rename_shop" &&
      (!observation.shop ||
        observation.shop.owner.kind !== "player" ||
        observation.shop.owner.account_id !== account)
    )
      return;
    if (method === "buy_from_merchant" && !observation.player) return;
    this.publish({ busy: true, message: "" });
    try {
      const attempt = await this.port!.prepare(account, method, args);
      this.publish({ pending: attempt });
      if (
        this.stopped ||
        epoch !== this.epoch ||
        account !== this.value.accountId
      ) {
        await this.port!.discardPrepared(attempt.id);
        return;
      }
      await this.port!.submit(attempt.id);
      this.publish({ pending: await this.port!.pending() });
      if (epoch === this.epoch)
        this.publish({
          message:
            "Check the original transaction to confirm its outcome. It will not be sent again automatically.",
        });
    } catch {
      this.publish({
        message:
          "The action could not be completed. Check saved transaction details before trying again.",
      });
      try {
        this.publish({ pending: await this.port!.pending() });
      } catch {
        this.publish({ phase: "unavailable", transactionAvailable: false });
      }
    } finally {
      this.publish({ busy: false });
      if (epoch !== this.epoch && !this.stopped) await this.refresh();
    }
    await this.checkTransaction();
  }
  async checkTransaction(): Promise<void> {
    if (!this.port || this.value.busy || this.stopped) return;
    this.epoch++;
    this.publish({ busy: true });
    try {
      const status = await this.port.reconcile();
      this.publish({ pending: await this.port.pending() });
      if (status?.kind === "succeeded")
        this.publish({
          message: "Transaction confirmed. Your shop data will refresh.",
        });
      else if (status?.kind === "failed")
        this.publish({
          message:
            "The original transaction failed. No successful change was confirmed.",
        });
      else if (this.value.pending)
        this.publish({
          message:
            "The outcome is still unresolved. Keep this attempt and check again.",
        });
    } catch {
      this.publish({
        message:
          "Could not verify the original transaction. No replacement was sent.",
      });
    } finally {
      this.publish({ busy: false });
    }
    await this.refresh();
  }
  async recover(hash: string): Promise<void> {
    if (!this.port || !this.value.pending || this.value.busy) return;
    try {
      await this.port.recoverHash(this.value.pending.id, hash);
      await this.checkTransaction();
    } catch {
      this.publish({
        message: "That hash could not be verified for this attempt.",
      });
    }
  }
  async resumePrepared(): Promise<void> {
    const a = this.value.pending;
    if (
      !this.port ||
      this.stopped ||
      !a ||
      a.phase !== "prepared" ||
      a.accountId !== this.value.accountId ||
      this.value.busy ||
      this.value.phase !== "ready" ||
      this.value.observation?.stale ||
      this.value.observation?.town.paused ||
      !this.value.observation?.ownershipKnown
    )
      return;
    this.publish({ busy: true });
    try {
      await this.port.submit(a.id);
      this.publish({ pending: await this.port.pending() });
    } catch {
      this.publish({
        message:
          "The prepared request could not be submitted. Check its original details.",
      });
    } finally {
      this.publish({ busy: false });
    }
    await this.checkTransaction();
  }
  async discardPrepared(): Promise<void> {
    const a = this.value.pending;
    if (!this.port || !a || a.phase !== "prepared" || this.value.busy) return;
    try {
      await this.port.discardPrepared(a.id);
      this.publish({
        pending: await this.port.pending(),
        message:
          "The unsubmitted request was cancelled. No wallet request was sent.",
      });
    } catch {
      this.publish({ message: "Could not discard the unsubmitted request." });
    }
  }
  stop(): void {
    this.stopped = true;
    this.epoch++;
    this.unsubscribe?.();
  }
}
export function inventoryRows(ledger: TownLedger): {
  id: string;
  name: string;
  held: string;
  available: string;
  reserved: string;
  incoming: string;
}[] {
  return (
    [
      ["crystal", "Crystals"],
      ["wood", "Wood"],
      ["herb", "Herbs"],
      ["iron", "Iron"],
      ["health_potion", "Health potions"],
      ["iron_tool", "Iron tools"],
    ] as const
  ).map(([id, name]) => ({
    id,
    name,
    held: ledger.inventory.held[id],
    available: ledger.inventory.available[id],
    reserved: (
      BigInt(ledger.inventory.listing_reserved[id]) +
      BigInt(ledger.inventory.trade_reserved[id])
    ).toString(),
    incoming: (
      BigInt(ledger.inventory.production_output_reserved[id]) +
      BigInt(ledger.inventory.trade_inbound_reserved[id])
    ).toString(),
  }));
}
