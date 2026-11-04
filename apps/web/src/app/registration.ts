import {
  RegistrationNotOpenedError,
  walletTransactionHash,
} from "./registration-reader";
import type {
  RegistrationObservation,
  RegistrationReads,
} from "./registration-reader";
import type { WalletContext, WalletContextStore } from "./wallet-context";
import { WalletRejectedError } from "./transaction-errors";
import { acceptPlayerObservation } from "./player-observation";

export type RegistrationStatus =
  | "disconnected"
  | "loading"
  | "unavailable"
  | "eligible"
  | "registered"
  | "reserved"
  | "paused"
  | "full";
export interface RegistrationState {
  readonly accountId: string | null;
  readonly status: RegistrationStatus;
  readonly observation: RegistrationObservation | null;
  readonly attempt: "idle" | "signing" | "unknown" | "failed";
  readonly message: string;
}
export function registrationStatus(
  value: RegistrationObservation,
): RegistrationStatus {
  if (value.player.data) return "registered";
  const market = value.market.data;
  if (
    [
      market.contract_account_id,
      market.owner_account_id,
      ...market.merchants.map((row) => row.controller_account_id),
    ].includes(value.accountId)
  )
    return "reserved";
  if (market.paused) return "paused";
  if (
    BigInt(market.registered_player_count) >= BigInt(market.limits.max_players)
  )
    return "full";
  return "eligible";
}
function failureMessage(code: string): string {
  switch (code) {
    case "E_ALREADY_REGISTERED":
      return "This account is already registered. The starter grant is issued only once.";
    case "E_PLAYER_CAPACITY":
      return "The market has reached its player limit. No starter gold was granted by this attempt.";
    case "E_MARKET_PAUSED":
      return "Registration is paused on the contract.";
    case "E_RESERVED_ACCOUNT":
      return "Use a separate player account. The contract, owner and merchant accounts cannot register.";
    default:
      return "Registration failed on-chain. Check wallet gas funding; contract storage funding is separate from game gold.";
  }
}
export class RegistrationController {
  private current: RegistrationState = {
    accountId: null,
    status: "disconnected",
    observation: null,
    attempt: "idle",
    message: "",
  };
  private epoch = 0;
  private sending = false;
  private identityVersion = 0;
  private lastObservation: RegistrationObservation | null = null;
  constructor(
    private readonly reads: RegistrationReads,
    private readonly context: WalletContextStore,
    private readonly send: (
      context: WalletContext,
      identityVersion: number,
    ) => Promise<unknown>,
    private readonly changed: (state: RegistrationState) => void,
    private readonly pendingChanged: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}
  get state(): RegistrationState {
    return this.current;
  }
  private publish(values: Partial<RegistrationState>): void {
    this.current = { ...this.current, ...values };
    this.changed(this.current);
  }
  setAccount(accountId: string | null, identityVersion = 0): void {
    if (
      accountId === this.current.accountId &&
      this.identityVersion === identityVersion
    )
      return;
    this.identityVersion = identityVersion;
    ++this.epoch;
    this.lastObservation = null;
    this.publish({
      accountId,
      status: accountId ? "loading" : "disconnected",
      observation: null,
      attempt: "idle",
      message: "",
    });
    if (accountId && !this.sending) void this.refresh();
  }
  private validate(
    value: RegistrationObservation,
    accountId: string,
  ): RegistrationObservation {
    this.lastObservation = acceptPlayerObservation(
      value,
      accountId,
      this.lastObservation,
      this.now(),
    );
    return this.lastObservation;
  }
  async refresh(): Promise<void> {
    const accountId = this.current.accountId;
    if (!accountId || this.sending) return;
    const epoch = ++this.epoch;
    const priorFailure =
      this.current.attempt === "failed" ? this.current.message : "";
    this.publish({ status: "loading", observation: null });
    try {
      const pending = this.context.read();
      let failed: string | null = null;
      let confirmed = false;
      if (
        pending?.accountId === accountId &&
        pending.call?.method === "register_player" &&
        pending.transactionHash
      ) {
        try {
          const receipt = await this.reads.receipt(pending);
          if (receipt.kind === "failed") failed = receipt.code;
          if (receipt.kind === "succeeded") confirmed = true;
        } catch {
          /* Preserve ambiguous attempts; a player read can still prove registration exists. */
        }
      }
      const read = await this.reads.read(accountId);
      if (epoch !== this.epoch) return;
      const value = this.validate(read, accountId);
      const own =
        pending?.accountId === accountId &&
        pending.call?.method === "register_player";
      if (
        own &&
        (confirmed || failed || (value.player.data && !pending.transactionHash))
      ) {
        this.context.finishRegistration(
          pending.id,
          confirmed ? "confirmed" : failed ? "failed" : "registered",
        );
        this.pendingChanged();
      }
      const unresolved = this.context.read()?.kind === "transaction";
      this.publish({
        observation: value,
        status: registrationStatus(value),
        attempt: unresolved
          ? "unknown"
          : failed || (priorFailure && !value.player.data)
            ? "failed"
            : "idle",
        message: unresolved
          ? "An earlier transaction is unresolved. Check status; it will not be sent again."
          : failed
            ? failureMessage(failed)
            : value.player.data
              ? "Already registered. The starter grant is issued only once."
              : priorFailure,
      });
    } catch {
      if (epoch === this.epoch)
        this.publish({
          status: "unavailable",
          observation: null,
          message:
            "Could not read finalized registration status. Check again before registering.",
        });
    }
  }
  async register(): Promise<void> {
    const accountId = this.current.accountId;
    if (
      !accountId ||
      this.sending ||
      this.current.status !== "eligible" ||
      this.current.attempt === "unknown"
    )
      return;
    this.sending = true;
    const epoch = ++this.epoch;
    let pending: WalletContext | null = null;
    this.publish({
      attempt: "signing",
      message: "Checking registration before opening the wallet…",
    });
    try {
      if (this.context.read()) throw new Error("Pending wallet operation");
      const read = await this.reads.read(accountId);
      if (epoch !== this.epoch) return;
      const fresh = this.validate(read, accountId);
      const status = registrationStatus(fresh);
      this.publish({ status, observation: fresh });
      if (status !== "eligible") return;
      pending = this.context.prepareTransaction(
        accountId,
        "register_player",
        {},
        fresh.market.block_height,
      );
      this.pendingChanged();
      const result = await this.send(pending, this.identityVersion);
      const hash = walletTransactionHash(result);
      if (hash) this.context.recordRegistrationHash(pending.id, hash);
      if (epoch === this.epoch)
        this.publish({
          attempt: "unknown",
          message: "Wallet returned. Checking finalized registration status…",
        });
    } catch (error) {
      if (
        pending &&
        (error instanceof RegistrationNotOpenedError ||
          error instanceof WalletRejectedError)
      ) {
        try {
          if (
            error instanceof WalletRejectedError &&
            this.context.read()?.id === pending.id
          )
            this.context.settle(pending.id, "rejected");
          else this.context.finishRegistration(pending.id);
          this.pendingChanged();
        } catch {
          /* Preserve the intent when browser storage cannot confirm clearing it. */
        }
      }
      if (epoch === this.epoch)
        this.publish({
          attempt:
            pending &&
            !(error instanceof RegistrationNotOpenedError) &&
            !(error instanceof WalletRejectedError)
              ? "unknown"
              : "failed",
          message:
            error instanceof WalletRejectedError
              ? "Registration rejected in Meteor. You can explicitly try again."
              : pending && !(error instanceof RegistrationNotOpenedError)
                ? "The wallet request did not complete. Its outcome is unknown; check status before taking another action."
                : "Registration was not submitted. Check the active Meteor account and Testnet connection, then try again.",
        });
    } finally {
      this.sending = false;
      if (this.current.attempt === "signing") this.publish({ attempt: "idle" });
      if (this.current.accountId) await this.refresh();
    }
  }
}
