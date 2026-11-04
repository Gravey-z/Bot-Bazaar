import { createMarketCall } from "@bot-bazaar/chain";
import type { CallInput } from "@bot-bazaar/chain";
import type { MerchantId, Resource } from "@bot-bazaar/shared";
import {
  PurchaseNotOpenedError,
  walletTransactionHash,
} from "./registration-reader";
import type {
  RegistrationObservation,
  RegistrationReads,
} from "./registration-reader";
import type { WalletContext, WalletContextStore } from "./wallet-context";
import { WalletRejectedError } from "./transaction-errors";

export interface PurchaseQuote {
  readonly accountId: string;
  readonly args: CallInput<"buy_from_merchant">;
  readonly stock: string;
  readonly unitPrice: string;
  readonly gold: string;
  readonly owned: string;
  readonly blockHeight: string;
  readonly revision: string;
}
class QuoteError extends Error {}
export function quotePurchase(
  observation: RegistrationObservation,
  accountId: string,
  merchantId: MerchantId,
  resource: Resource,
  quantity: string,
  now: number,
): PurchaseQuote {
  const { market, player } = observation;
  const chainTime = Number(BigInt(market.block_timestamp_ns) / 1000000n);
  if (
    observation.accountId !== accountId ||
    player.data?.account_id !== accountId
  )
    throw new QuoteError("Register this player account before buying.");
  if (
    now < observation.receivedAt ||
    now - observation.receivedAt > 15000 ||
    now - chainTime > 15000 ||
    chainTime - now > 5000
  )
    throw new QuoteError(
      "This quote is out of date. Refresh the quote before buying.",
    );
  if (
    market.block_height !== player.block_height ||
    market.market_revision !== player.market_revision ||
    market.block_timestamp_ns !== player.block_timestamp_ns
  )
    throw new QuoteError(
      "Market and player data do not match. Refresh the quote.",
    );
  if (market.data.paused)
    throw new QuoteError("The market is paused. Purchases are unavailable.");
  if (
    !/^[1-9][0-9]{0,2}$/.test(quantity) ||
    BigInt(quantity) > 100n ||
    BigInt(quantity) > BigInt(market.data.limits.max_trade_quantity)
  )
    throw new QuoteError(
      "Enter a whole quantity from 1 to 100, without decimals or exponent notation.",
    );
  const merchant = market.data.merchants.find(
    (row) => row.merchant_id === merchantId,
  );
  const listing = merchant?.listings.find((row) => row.resource === resource);
  if (!merchant || !listing || !listing.active)
    throw new QuoteError("This resource is not currently listed for sale.");
  const count = BigInt(quantity),
    total = count * BigInt(listing.unit_price);
  if (
    count > BigInt(listing.quantity) ||
    count > BigInt(merchant.inventory[resource])
  )
    throw new QuoteError("The requested quantity exceeds the stock for sale.");
  if (total > BigInt(player.data.gold))
    throw new QuoteError("This player does not have enough virtual gold.");
  if (
    count + BigInt(player.data.inventory[resource]) >
      BigInt(market.data.limits.max_actor_resource) ||
    total + BigInt(merchant.gold) > BigInt(market.data.limits.max_actor_gold)
  )
    throw new QuoteError(
      "This purchase would exceed a player or merchant balance limit.",
    );
  if (total > BigInt(market.data.limits.max_total_price))
    throw new QuoteError(
      "This purchase exceeds the market's total-price limit.",
    );
  const args = createMarketCall("buy_from_merchant", {
    merchant_id: merchantId,
    resource,
    quantity,
    max_total_price: total.toString(),
    listing_version: listing.version,
  }).args;
  return {
    accountId,
    args,
    stock: listing.quantity,
    unitPrice: listing.unit_price,
    gold: player.data.gold,
    owned: player.data.inventory[resource],
    blockHeight: market.block_height,
    revision: market.market_revision,
  };
}
function sameQuote(left: PurchaseQuote, right: PurchaseQuote): boolean {
  return (
    JSON.stringify([
      left.accountId,
      left.args,
      left.stock,
      left.unitPrice,
      left.gold,
      left.owned,
    ]) ===
    JSON.stringify([
      right.accountId,
      right.args,
      right.stock,
      right.unitPrice,
      right.gold,
      right.owned,
    ])
  );
}
export interface PurchaseState {
  readonly accountId: string | null;
  readonly merchantId: MerchantId;
  readonly resource: Resource;
  readonly quantity: string;
  readonly phase:
    | "disconnected"
    | "loading"
    | "editing"
    | "review"
    | "signing"
    | "unknown"
    | "succeeded"
    | "failed";
  readonly observation: RegistrationObservation | null;
  readonly quote: PurchaseQuote | null;
  readonly reviewed: PurchaseQuote | null;
  readonly validation: string;
  readonly message: string;
}
export class PurchaseController {
  private current: PurchaseState = {
    accountId: null,
    merchantId: "rex",
    resource: "crystal",
    quantity: "1",
    phase: "disconnected",
    observation: null,
    quote: null,
    reviewed: null,
    validation: "Connect a registered Testnet player wallet to buy.",
    message: "",
  };
  private epoch = 0;
  private sending = false;
  constructor(
    private readonly reads: RegistrationReads,
    private readonly context: WalletContextStore,
    private readonly send: (context: WalletContext) => Promise<unknown>,
    private readonly changed: (state: PurchaseState) => void,
    private readonly pendingChanged: () => void = () => {},
    private readonly settled: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}
  get state(): PurchaseState {
    return this.current;
  }
  private publish(values: Partial<PurchaseState>): void {
    this.current = { ...this.current, ...values };
    this.changed(this.current);
  }
  private derive(
    value: RegistrationObservation,
  ): Pick<PurchaseState, "quote" | "validation"> {
    try {
      return {
        quote: quotePurchase(
          value,
          this.current.accountId!,
          this.current.merchantId,
          this.current.resource,
          this.current.quantity,
          this.now(),
        ),
        validation: "",
      };
    } catch (error) {
      return {
        quote: null,
        validation:
          error instanceof QuoteError
            ? error.message
            : "The quote is unavailable. Refresh before buying.",
      };
    }
  }
  setAccount(accountId: string | null): void {
    if (this.current.accountId === accountId) return;
    ++this.epoch;
    this.publish({
      accountId,
      phase: accountId ? "loading" : "disconnected",
      observation: null,
      quote: null,
      reviewed: null,
      message: "",
      validation: accountId
        ? ""
        : "Connect a registered Testnet player wallet to buy.",
    });
    if (accountId && !this.sending) void this.refresh();
  }
  edit(merchantId: MerchantId, resource: Resource, quantity: string): void {
    if (this.sending || this.current.phase === "unknown") return;
    ++this.epoch;
    this.publish({
      merchantId,
      resource,
      quantity,
      reviewed: null,
      message: "",
      phase: this.current.accountId ? "editing" : "disconnected",
    });
    if (this.current.observation)
      this.publish(this.derive(this.current.observation));
    else if (this.current.accountId) void this.refresh();
  }
  async refresh(): Promise<void> {
    const accountId = this.current.accountId;
    if (!accountId || this.sending) return;
    const epoch = ++this.epoch;
    const message = this.current.message;
    this.publish({
      phase: "loading",
      quote: null,
      reviewed: null,
      observation: null,
    });
    let outcome: "succeeded" | "failed" | null = null;
    try {
      const pending = this.context.read();
      if (
        pending?.accountId === accountId &&
        pending.call?.method === "buy_from_merchant" &&
        pending.transactionHash
      ) {
        try {
          const receipt = await this.reads.receipt(pending);
          if (epoch !== this.epoch) return;
          if (receipt.kind === "succeeded" || receipt.kind === "failed") {
            this.context.finishPurchase(
              pending.id,
              receipt.kind === "succeeded" ? "confirmed" : "failed",
            );
            this.pendingChanged();
            outcome = receipt.kind;
            this.settled();
          }
        } catch {
          /* Unverified receipts cannot release the purchase intent. */
        }
      }
      const value = await this.reads.read(accountId);
      if (epoch !== this.epoch) return;
      if (
        value.accountId !== accountId ||
        (value.player.data && value.player.data.account_id !== accountId)
      )
        throw new Error("Player changed");
      const pendingNow = this.context.read();
      this.publish({
        observation: value,
        ...this.derive(value),
        phase: pendingNow ? "unknown" : (outcome ?? "editing"),
        message: pendingNow
          ? "An earlier wallet transaction is unresolved. Check status; a new purchase is blocked."
          : outcome === "succeeded"
            ? "Purchase confirmed on Testnet. Balances were refreshed."
            : outcome === "failed"
              ? "The purchase failed on-chain. Review a fresh quote before trying again."
              : message,
      });
    } catch {
      if (epoch === this.epoch)
        this.publish({
          observation: null,
          quote: null,
          phase: outcome ?? "failed",
          validation: "Could not refresh finalized player and market data.",
          message:
            outcome === "succeeded"
              ? "Purchase confirmed on Testnet; balance refresh is unavailable."
              : "Check status before taking another action. No purchase will be sent automatically.",
        });
    }
  }
  async review(): Promise<void> {
    if (
      this.sending ||
      this.current.phase === "loading" ||
      this.current.phase === "unknown"
    )
      return;
    await this.refresh();
    if (this.state.quote && this.state.phase !== "unknown") {
      this.publish({
        phase: "review",
        reviewed: this.current.quote,
        message: "Review the exact total and account, then confirm in Meteor.",
      });
    }
  }
  async confirm(): Promise<void> {
    const reviewed = this.current.reviewed;
    if (
      !reviewed ||
      this.current.phase !== "review" ||
      this.sending ||
      reviewed.accountId !== this.current.accountId
    )
      return;
    this.sending = true;
    const epoch = ++this.epoch;
    let pending: WalletContext | null = null;
    this.publish({
      phase: "signing",
      message: "Checking the reviewed quote before opening Meteor…",
    });
    try {
      if (this.context.read()) throw new Error("Unresolved wallet operation");
      const value = await this.reads.read(reviewed.accountId);
      if (epoch !== this.epoch) return;
      const next = quotePurchase(
        value,
        reviewed.accountId,
        this.current.merchantId,
        this.current.resource,
        this.current.quantity,
        this.now(),
      );
      if (
        BigInt(next.blockHeight) < BigInt(reviewed.blockHeight) ||
        BigInt(next.revision) < BigInt(reviewed.revision)
      )
        throw new QuoteError(
          "The quote source regressed. Refresh and review before buying.",
        );
      if (!sameQuote(reviewed, next)) {
        this.publish({
          observation: value,
          quote: next,
          reviewed: null,
          phase: "editing",
          message:
            "The quote or player balance changed. Review the updated purchase and confirm again.",
        });
        return;
      }
      pending = this.context.prepareTransaction(
        reviewed.accountId,
        "buy_from_merchant",
        reviewed.args,
        value.market.block_height,
      );
      this.pendingChanged();
      const result = await this.send(pending);
      const hash = walletTransactionHash(result);
      if (hash) this.context.recordPurchaseHash(pending.id, hash);
      if (epoch === this.epoch)
        this.publish({
          phase: "unknown",
          reviewed: null,
          message: "Wallet returned. Checking the original purchase…",
        });
    } catch (error) {
      if (
        pending &&
        (error instanceof PurchaseNotOpenedError ||
          error instanceof WalletRejectedError)
      ) {
        try {
          if (
            error instanceof WalletRejectedError &&
            this.context.read()?.id === pending.id
          )
            this.context.settle(pending.id, "rejected");
          else this.context.finishPurchase(pending.id);
          this.pendingChanged();
        } catch {
          /* Retain an intent that could not be cleared. */
        }
      }
      if (epoch === this.epoch)
        this.publish({
          phase:
            pending &&
            !(error instanceof PurchaseNotOpenedError) &&
            !(error instanceof WalletRejectedError)
              ? "unknown"
              : "failed",
          reviewed: null,
          message:
            error instanceof WalletRejectedError
              ? "Purchase rejected in Meteor. Review a fresh quote to try again."
              : error instanceof QuoteError
                ? error.message
                : pending && !(error instanceof PurchaseNotOpenedError)
                  ? "The wallet outcome is unknown. Check status; this purchase will not be sent again."
                  : "The purchase was not opened. Refresh and review a new quote before retrying.",
        });
    } finally {
      this.sending = false;
      if (this.state.phase === "signing")
        this.publish({ phase: "editing", reviewed: null });
      if (this.state.accountId && this.state.phase !== "editing")
        await this.refresh();
    }
  }
}
