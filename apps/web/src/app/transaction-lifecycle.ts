import type {
  WalletContext,
  WalletContextStore,
  TransactionPhase,
} from "./wallet-context";
import type { RegistrationReceipt } from "./registration-reader";

export interface TransactionView {
  readonly record: WalletContext | null;
  readonly phase: TransactionPhase | "idle" | "unavailable";
  readonly checking: boolean;
  readonly message: string;
}
export class TransactionLifecycle {
  private current: TransactionView = {
    record: null,
    phase: "idle",
    checking: false,
    message: "",
  };
  private checking = false;
  private failures = 0;
  private nextCheck = 0;
  private stopped = false;
  constructor(
    private readonly context: WalletContextStore,
    private readonly receipt: (
      context: WalletContext,
    ) => Promise<RegistrationReceipt>,
    private readonly changed: (state: TransactionView) => void,
    private readonly settled: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}
  get state(): TransactionView {
    return this.current;
  }
  private publish(values: Partial<TransactionView>): void {
    if (this.stopped) return;
    this.current = { ...this.current, ...values };
    this.changed(this.current);
  }
  sync(): void {
    try {
      const pending = this.context.read();
      const record =
        pending?.kind === "transaction"
          ? pending
          : this.context.lastTransaction();
      this.publish({
        record,
        phase: record?.lifecycle?.phase ?? (record ? "unknown" : "idle"),
      });
    } catch {
      this.publish({
        phase: "unavailable",
        message:
          "Saved transaction details could not be read. A new transaction remains blocked.",
      });
    }
  }
  async restore(pageUrl: string): Promise<"none" | "invalid" | "accepted"> {
    let returned: "none" | "invalid" | "accepted" = "none";
    try {
      returned = this.context.consumeReturn(pageUrl);
      const pending = this.context.read();
      if (
        pending?.kind === "transaction" &&
        (!pending.lifecycle ||
          ["prepared", "awaiting_wallet"].includes(pending.lifecycle.phase))
      )
        this.context.progress(pending.id, "unknown");
      this.sync();
      if (returned === "invalid")
        this.publish({
          message:
            "Wallet return could not be matched to this attempt. No transaction was confirmed or resent.",
        });
      await this.refresh();
    } catch {
      this.sync();
    }
    return returned;
  }
  async refresh(manual = true): Promise<void> {
    if (
      this.checking ||
      this.stopped ||
      (!manual && this.now() < this.nextCheck)
    )
      return;
    this.sync();
    let pending: WalletContext | null;
    try {
      pending = this.context.read();
    } catch {
      return;
    }
    if (!pending || pending.kind !== "transaction" || !pending.transactionHash)
      return;
    this.checking = true;
    this.publish({ checking: true });
    try {
      const result = await this.receipt(pending);
      if (this.stopped) return;
      const active = this.context.read();
      // An old response cannot mutate another attempt or overwrite a resolved one.
      if (
        active?.id !== pending.id ||
        active.transactionHash !== pending.transactionHash
      )
        return;
      if (result.kind === "succeeded" || result.kind === "failed") {
        this.context.settle(
          pending.id,
          result.kind === "succeeded" ? "confirmed" : "failed",
        );
        this.settled();
      } else
        this.context.progress(
          pending.id,
          result.kind === "pending" ? "submitted" : "unknown",
        );
      this.failures = 0;
      this.publish({ message: "" });
    } catch {
      this.failures++;
      try {
        if (this.context.read()?.id === pending.id)
          this.context.progress(pending.id, "unknown");
      } catch {
        /* Keep the unresolved lock. */
      }
      this.publish({
        message:
          "Could not verify the original transaction. Check again; it will not be sent again.",
      });
    } finally {
      this.checking = false;
      this.nextCheck =
        this.now() + Math.min(30000, 3000 * 2 ** Math.min(this.failures, 4));
      this.sync();
      this.publish({ checking: false });
    }
  }
  async recover(hash: string): Promise<void> {
    try {
      const pending = this.context.read();
      if (!pending || pending.kind !== "transaction") return;
      this.context.recoverHash(pending.id, hash);
      this.sync();
      await this.refresh();
    } catch {
      this.publish({
        message:
          "That transaction hash could not be attached. Keep the original attempt and check its details.",
      });
    }
  }
  stop(): void {
    this.stopped = true;
  }
}
