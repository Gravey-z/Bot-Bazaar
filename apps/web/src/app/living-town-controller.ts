import type { TownLiveState } from "./living-town-live";
import { listingQuote } from "./living-town-sales-ui";
import type { TownMarketPage, TownHistoryPage } from "./living-town-sales-ui";
import type { LivingTownAttempt } from "./living-town-transactions";
import type {
  TownTransactionMethod,
  TownTransactionStatus,
} from "./living-town-transactions";
import { verifyAssistantReview } from "@bot-bazaar/chain";
import type { AssistantManualReview } from "@bot-bazaar/chain";
import { LivingTownIdentityError } from "@bot-bazaar/chain";
import { productionQuote } from "./living-town-production-ui";
import type { TownRecipe } from "./living-town-production-ui";
import type {
  livingTownProductionJob,
  livingTownPlayer,
  livingTownShop,
  livingTownLedger,
  livingTownTown,
  livingTownListing,
} from "@bot-bazaar/chain";
export type TownPlayer = ReturnType<typeof livingTownPlayer>;
export type TownShop = ReturnType<typeof livingTownShop>;
export type TownLedger = ReturnType<typeof livingTownLedger>;
export interface TownShopPage {
  shops: TownShop[];
  nextCursor: string | null;
  receivedAt: number;
}
export interface TownObservation {
  accountId: string | null;
  town: ReturnType<typeof livingTownTown>;
  player: TownPlayer | null;
  shop: TownShop | null;
  ledger: TownLedger | null;
  listings: ReturnType<typeof livingTownListing>[];
  ownListings?: ReturnType<typeof livingTownListing>[];
  receivedAt: number;
  stale: boolean;
  ownershipKnown: boolean;
  source: "chain" | "projection";
  ownershipUrl: string | null;
  production?: {
    items: ReturnType<typeof livingTownProductionJob>[];
    historyGap: boolean;
  };
  chainTimestampNs?: string;
  recipes?: TownRecipe[];
}
export interface TownPort {
  assistant?: {
    authenticate(accountId: string, shopId: string): Promise<void>;
    scope(shopId: string): Promise<unknown>;
    recommendations?(shopId: string): Promise<unknown>;
    generate?(shopId: string): Promise<unknown>;
    configure?(
      shopId: string,
      mode: "off" | "recommendations",
    ): Promise<unknown>;
    logout(): void;
    review?(shopId: string, proposalId: string): Promise<AssistantManualReview>;
    dismiss?(shopId: string, proposalId: string): Promise<unknown>;
  };
  watchActivity?: (changed: (state: TownLiveState) => void) => () => void;
  market?(cursor: string | null, signal?: AbortSignal): Promise<TownMarketPage>;
  history?(
    shopId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<TownHistoryPage>;
  accounts(): Promise<readonly { accountId: string }[]>;
  connect(): Promise<readonly { accountId: string }[]>;
  disconnect(): Promise<void>;
  subscribe(changed: () => void): () => void;
  read(account: string | null, signal?: AbortSignal): Promise<TownObservation>;
  browse(cursor: string | null, signal?: AbortSignal): Promise<TownShopPage>;
  prepare(
    account: string,
    method: TownTransactionMethod,
    args: Record<string, unknown>,
    assistantReview?: AssistantManualReview,
  ): Promise<LivingTownAttempt>;
  submit(id: string): Promise<void>;
  pending(): Promise<LivingTownAttempt | null>;
  restore(): Promise<LivingTownAttempt | null>;
  last?(): Promise<LivingTownAttempt | null>;
  reconcile(): Promise<TownTransactionStatus | null>;
  recoverHash(id: string, hash: string): Promise<void>;
  discardPrepared(id: string): Promise<void>;
}
export interface TownState {
  activity: TownLiveState;
  phase: "preview" | "disconnected" | "loading" | "ready" | "unavailable";
  accountId: string | null;
  accounts: readonly string[];
  observation: TownObservation | null;
  pending: LivingTownAttempt | null;
  lastAttempt: LivingTownAttempt | null;
  busy: boolean;
  transactionAvailable: boolean;
  message: string;
  ownershipUrl: string | null;
  directory: TownShopPage | null;
  directoryBusy: boolean;
  directoryMessage: string;
  market: TownMarketPage | null;
  history: TownHistoryPage | null;
  marketBusy: boolean;
  historyBusy: boolean;
  salesMessage: string;
}
export const initialTownState: TownState = {
  activity: { events: [], mode: "polling", gap: false },
  phase: "preview",
  accountId: null,
  accounts: [],
  observation: null,
  pending: null,
  lastAttempt: null,
  busy: false,
  transactionAvailable: false,
  message: "",
  ownershipUrl: null,
  directory: null,
  directoryBusy: false,
  directoryMessage: "",
  market: null,
  history: null,
  marketBusy: false,
  historyBusy: false,
  salesMessage: "",
};
export function describeTownAttempt(a: LivingTownAttempt): string {
  const args = a.call.args;
  if (a.call.method === "complete_production" && "job_id" in args)
    return `Claim the whole output of production batch #${args.job_id}. No game gold reward; wallet fees use NEAR.`;
  if (a.call.method === "start_production" && "recipe_id" in args)
    return `Start ${args.quantity} ${args.recipe_id.replaceAll("_", " ")} in shop #${args.shop_id}, recipe version ${args.recipe_version}.`;
  if (a.call.method === "register_player")
    return "Register player: one-time 100 game gold grant.";
  if (a.call.method === "create_shop" && "name" in args)
    return `Create shop: ${args.name}.`;
  if (a.call.method === "rename_shop" && "shop_id" in args && "name" in args)
    return `Rename shop #${args.shop_id}: ${args.name}.`;
  if (
    a.call.method === "set_listing" &&
    "item_id" in args &&
    "unit_price" in args
  )
    return `Set ${args.item_id} remaining stock to ${args.quantity} at ${args.unit_price} gold each.`;
  if (a.call.method === "cancel_listing" && "listing_id" in args)
    return `Cancel listing #${args.listing_id} and release its remaining stock.`;
  if ("item_id" in args && "max_total_price" in args)
    return `Buy ${args.quantity} ${args.item_id.replaceAll("_", " ")}: maximum ${args.max_total_price} game gold.`;
  return "Review the original saved request.";
}
const readFailureMessage =
  "Confirmed town data is unavailable. Your last known balances have not changed.";
export class LivingTownController {
  private value: TownState = { ...initialTownState };
  private epoch = 0;
  private stopped = false;
  private started = false;
  private preferredAccount: string | null = null;
  private refreshing = false;
  private accountEpoch = 0;
  private checkingAccounts = false;
  private browseEpoch = 0;
  private marketEpoch = 0;
  private historyEpoch = 0;
  private marketAbort?: AbortController;
  private historyAbort?: AbortController;
  private readonly seenSales = new Set<string>();
  private readAbort: AbortController | undefined;
  private browseAbort: AbortController | undefined;
  private unsubscribe?: () => void;
  private stopActivity: (() => void) | undefined;
  constructor(
    private readonly port: TownPort | null,
    private readonly changed: (state: TownState) => void,
    private readonly now: () => number = Date.now,
  ) {}
  get state(): TownState {
    return this.value;
  }
  get assistant(): TownPort["assistant"] {
    return this.port?.assistant;
  }
  async acceptAssistantReview(value: unknown): Promise<void> {
    if (!this.canAct()) return;
    const account = this.value.accountId,
      version = this.accountEpoch;
    try {
      const review = await verifyAssistantReview(value),
        o = this.value.observation;
      if (
        version !== this.accountEpoch ||
        account !== this.value.accountId ||
        review.proposal.owner_account_id !== account ||
        !o?.shop ||
        !o.ledger ||
        o.shop.shop_id !== review.proposal.shop_id ||
        o.shop.revision !== review.proposal.expected_shop_revision ||
        o.ledger.revision !== review.proposal.expected_ledger_revision ||
        o.shop.policy_revision !== review.proposal.expected_policy_revision
      )
        throw new Error("Assistant review changed");
      await this.act(review.call.method, review.call.args, review);
    } catch {
      this.publish({
        message:
          "Recommendation terms changed or expired. Refresh and review again before signing.",
      });
    }
  }
  private publish(patch: Partial<TownState>): void {
    if (!this.stopped) {
      this.value = { ...this.value, ...patch };
      this.changed(this.value);
    }
  }
  async start(): Promise<void> {
    if (!this.port || this.stopped || this.started) return;
    this.started = true;
    this.publish({ phase: "loading" });
    this.stopActivity = this.port.watchActivity?.((activity) => {
      const last = this.value.activity.events[0]?.event_id;
      this.publish({ activity });
      if (activity.events[0]?.event_id !== last) void this.refresh();
    });
    this.unsubscribe = this.port.subscribe(() => {
      void this.syncAccounts();
    });
    try {
      const pending = await this.port.restore();
      this.publish({
        pending,
        lastAttempt: (await this.port.last?.()) ?? null,
        transactionAvailable: true,
      });
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
    if (account !== this.preferredAccount) this.port?.assistant?.logout();
    this.preferredAccount = account;
    if (account !== this.value.accountId) {
      this.invalidateReads();
      this.publish({
        accountId: account,
        accounts,
        observation: null,
        ownershipUrl: null,
        phase: "loading",
      });
    } else this.publish({ accounts });
  }
  private invalidateReads(): void {
    this.epoch++;
    this.browseEpoch++;
    this.marketEpoch++;
    this.historyEpoch++;
    this.marketAbort?.abort();
    this.historyAbort?.abort();
    this.seenSales.clear();
    this.readAbort?.abort();
    this.browseAbort?.abort();
    this.publish({
      directory: null,
      market: null,
      history: null,
      marketBusy: false,
      historyBusy: false,
      salesMessage: "",
      directoryBusy: false,
      directoryMessage: "",
    });
  }
  private beginAccountCheck(): number {
    const request = ++this.accountEpoch;
    this.checkingAccounts = true;
    this.invalidateReads();
    this.publish({
      accountId: null,
      accounts: [],
      observation: null,
      ownershipUrl: null,
      phase: "loading",
      message: this.value.transactionAvailable ? "" : this.value.message,
    });
    return request;
  }
  private clearUnverifiedIdentity(): void {
    this.port?.assistant?.logout();
    this.accountEpoch++;
    this.preferredAccount = null;
    this.browseEpoch++;
    this.browseAbort?.abort();
    this.publish({
      phase: "unavailable",
      accountId: null,
      accounts: [],
      observation: null,
      ownershipUrl: null,
      directory: null,
      directoryBusy: false,
      directoryMessage: "",
      message:
        "The town network or deployment could not be verified. Reconnect to the configured town before taking an action.",
    });
  }
  async syncAccounts(): Promise<void> {
    if (!this.port || this.stopped) return;
    const preferred = this.value.accountId ?? this.preferredAccount,
      request = this.beginAccountCheck();
    try {
      const accounts = (await this.port.accounts()).map((a) => a.accountId);
      if (this.stopped || request !== this.accountEpoch) return;
      this.select(
        accounts.includes(preferred ?? "") ? preferred : (accounts[0] ?? null),
        accounts,
      );
      try {
        const pending = await this.port.pending();
        const lastAttempt = (await this.port.last?.()) ?? null;
        if (request === this.accountEpoch)
          this.publish({ pending, lastAttempt });
      } catch {
        if (request === this.accountEpoch)
          this.publish({
            transactionAvailable: false,
            message:
              "Saved transaction details are unavailable. New actions remain blocked.",
          });
      }
    } catch {
      if (this.stopped || request !== this.accountEpoch) return;
      this.port.assistant?.logout();
      this.publish({
        phase: "unavailable",
        observation: null,
        ownershipUrl: null,
        accountId: null,
        accounts: [],
        message:
          "Wallet connection could not be checked. Refresh to try again.",
      });
    } finally {
      if (request === this.accountEpoch) {
        this.checkingAccounts = false;
        await this.refresh();
      }
    }
  }
  async connect(): Promise<void> {
    if (!this.port || this.value.busy || this.stopped) return;
    const request = this.beginAccountCheck();
    this.publish({ busy: true, message: "" });
    try {
      const rows = await this.port.connect();
      if (request !== this.accountEpoch || this.stopped) return;
      this.select(
        rows[0]?.accountId ?? null,
        rows.map((a) => a.accountId),
      );
    } catch {
      if (request === this.accountEpoch)
        this.publish({ message: "Wallet connection was not completed." });
    } finally {
      if (request === this.accountEpoch) this.checkingAccounts = false;
      this.publish({ busy: false });
      await this.refresh();
    }
  }
  async disconnect(): Promise<void> {
    if (!this.port || this.value.busy || this.stopped) return;
    this.accountEpoch++;
    this.preferredAccount = null;
    this.checkingAccounts = false;
    this.invalidateReads();
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
    if (
      this.stopped ||
      !this.value.accounts.includes(account) ||
      this.value.busy
    )
      return;
    this.accountEpoch++;
    this.checkingAccounts = false;
    this.select(account, this.value.accounts);
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (
      !this.port ||
      this.refreshing ||
      this.checkingAccounts ||
      this.value.busy ||
      this.stopped
    )
      return;
    this.refreshing = true;
    const epoch = this.epoch,
      account = this.value.accountId;
    const abort = (this.readAbort = new AbortController());
    try {
      const observation = await this.port.read(account, abort.signal);
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
    } catch (error) {
      if (
        epoch === this.epoch &&
        !this.stopped &&
        error instanceof LivingTownIdentityError
      ) {
        this.clearUnverifiedIdentity();
      } else if (epoch === this.epoch)
        this.publish({
          phase: "unavailable",
          observation: this.value.observation
            ? { ...this.value.observation, stale: true }
            : null,
          message: readFailureMessage,
        });
    } finally {
      if (this.readAbort === abort) this.readAbort = undefined;
      this.refreshing = false;
      if (epoch !== this.epoch && !this.stopped) void this.refresh();
    }
  }
  async browseShops(restart = false): Promise<void> {
    if (
      !this.port ||
      this.stopped ||
      this.checkingAccounts ||
      this.value.directoryBusy
    )
      return;
    const cursor = restart ? null : (this.value.directory?.nextCursor ?? null);
    if (!restart && this.value.directory && !cursor) return;
    const epoch = ++this.browseEpoch;
    const abort = (this.browseAbort = new AbortController());
    this.publish({
      directoryBusy: true,
      directoryMessage: "",
      ...(restart ? { directory: null } : {}),
    });
    try {
      const directory = await this.port.browse(cursor, abort.signal);
      if (epoch !== this.browseEpoch || this.stopped) return;
      this.publish({ directory });
    } catch (error) {
      if (
        epoch === this.browseEpoch &&
        error instanceof LivingTownIdentityError
      ) {
        this.invalidateReads();
        this.clearUnverifiedIdentity();
      } else if (epoch === this.browseEpoch)
        this.publish({
          directory: null,
          directoryMessage:
            "The shop directory is unavailable or its snapshot expired. Start again to read a fresh page.",
        });
    } finally {
      if (epoch === this.browseEpoch) this.publish({ directoryBusy: false });
      if (this.browseAbort === abort) this.browseAbort = undefined;
    }
  }
  async loadMarket(restart = true): Promise<void> {
    if (!this.port?.market || this.stopped || this.value.marketBusy) return;
    const cursor = restart ? null : this.value.market?.nextCursor;
    if (!restart && !cursor) return;
    const epoch = ++this.marketEpoch,
      abort = (this.marketAbort = new AbortController());
    this.publish({ marketBusy: true, salesMessage: "" });
    try {
      const page = await this.port.market(cursor ?? null, abort.signal);
      if (this.stopped || epoch !== this.marketEpoch) return;
      const items = restart
        ? page.items
        : [...(this.value.market?.items ?? []), ...page.items];
      if (
        items.length > 2018 ||
        new Set(items.map((l) => l.listing_id)).size !== items.length
      )
        throw Error("Market page overlap");
      this.publish({ market: { ...page, items } });
    } catch {
      if (epoch === this.marketEpoch)
        this.publish({
          market: this.value.market
            ? { ...this.value.market, stale: true, nextCursor: null }
            : null,
          salesMessage:
            "Comparable offers are unavailable or their snapshot changed. Refresh offers to start again.",
        });
    } finally {
      if (epoch === this.marketEpoch) this.publish({ marketBusy: false });
    }
  }
  async loadHistory(restart = true): Promise<void> {
    const shopId = this.value.observation?.shop?.shop_id,
      account = this.value.accountId;
    if (
      !this.port?.history ||
      !shopId ||
      !account ||
      this.stopped ||
      this.value.historyBusy
    )
      return;
    const cursor = restart ? null : this.value.history?.nextCursor;
    if (!restart && !cursor) return;
    const epoch = ++this.historyEpoch,
      abort = (this.historyAbort = new AbortController());
    this.publish({ historyBusy: true, salesMessage: "" });
    try {
      const page = await this.port.history(
        shopId,
        cursor ?? null,
        abort.signal,
      );
      if (
        this.stopped ||
        epoch !== this.historyEpoch ||
        account !== this.value.accountId ||
        shopId !== this.value.observation?.shop?.shop_id
      )
        return;
      if (page.shopId !== shopId) throw Error("History shop mismatch");
      const items = restart
        ? page.items
        : [...(this.value.history?.items ?? []), ...page.items];
      if (
        items.length > 10000 ||
        new Set(items.map((r) => r.event_sequence)).size !== items.length
      )
        throw Error("History page overlap");
      this.publish({ history: { ...page, items } });
      let changed = false;
      for (const row of page.items)
        if (row.kind === "customer_sale") {
          const key = `${shopId}:${row.receipt_id}:${row.log_index}`;
          if (!this.seenSales.has(key) && this.seenSales.size < 10000) {
            this.seenSales.add(key);
            changed = true;
          }
        }
      // Only refresh facts; confirmed rows have stable identities and no replay animation.
      if (changed) await this.refresh();
    } catch {
      if (epoch === this.historyEpoch)
        this.publish({
          history: this.value.history
            ? { ...this.value.history, stale: true, nextCursor: null }
            : null,
          salesMessage:
            "Confirmed history is unavailable or its snapshot changed. Refresh history to start again. Costs have not been assumed to be zero.",
        });
    } finally {
      if (epoch === this.historyEpoch) this.publish({ historyBusy: false });
    }
  }
  get canTransact(): boolean {
    return this.canAct();
  }
  get canClaim(): boolean {
    return this.canAct(true);
  }
  private canAct(claim = false): boolean {
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
      (claim || !this.value.observation.town.paused)
    );
  }
  async act(
    method: TownTransactionMethod,
    args: Record<string, unknown>,
    assistantReview?: AssistantManualReview,
  ): Promise<void> {
    if (
      !this.canAct(
        method === "complete_production" || method === "cancel_listing",
      )
    )
      return;
    this.epoch++;
    const account = this.value.accountId!,
      epoch = this.epoch,
      observation = this.value.observation!;
    if (method === "complete_production") {
      const job = observation.production?.items.find(
        (j) => j.job_id === args["job_id"],
      );
      if (
        !job ||
        job.status !== "running" ||
        job.owner.kind !== "player" ||
        job.owner.account_id !== account ||
        !observation.chainTimestampNs ||
        BigInt(job.ready_at_ns) > BigInt(observation.chainTimestampNs)
      )
        return;
    }
    if (method === "start_production") {
      const recipe = observation.recipes?.find(
        (r) => r.recipe_id === args["recipe_id"],
      );
      if (!recipe || typeof args["quantity"] !== "string") return;
      const quote = productionQuote(observation, recipe, args["quantity"]);
      if (
        !quote.review ||
        quote.reason ||
        args["shop_id"] !== quote.review.shopId ||
        args["expected_shop_revision"] !== quote.review.shopRevision ||
        args["recipe_version"] !== recipe.version
      )
        return;
    }
    if (method === "set_listing") {
      const quote = listingQuote(
        observation,
        String(args["item_id"]),
        String(args["quantity"]),
        String(args["unit_price"]),
      );
      if (
        !quote.review ||
        quote.reason ||
        args["shop_id"] !== quote.review.shopId ||
        args["expected_listing_revision"] !== quote.review.revision
      )
        return;
    }
    if (method === "cancel_listing") {
      const listing = observation.ownListings?.find(
        (l) => l.listing_id === args["listing_id"],
      );
      if (
        !listing?.active ||
        listing.owner.kind !== "player" ||
        listing.owner.account_id !== account ||
        args["expected_listing_revision"] !== listing.revision
      )
        return;
    }
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
      const attempt = await this.port!.prepare(
        account,
        method,
        args,
        assistantReview,
      );
      this.publish({ pending: attempt });
      if (
        this.stopped ||
        epoch !== this.epoch ||
        account !== this.value.accountId
      ) {
        await this.port!.discardPrepared(attempt.id);
        this.publish({ pending: await this.port!.pending() });
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
          method === "set_listing" || method === "cancel_listing"
            ? "Listing terms may have changed. Refresh and review again. Check any saved request before retrying."
            : "The action could not be completed. Check saved transaction details before trying again.",
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
    const originalAccount = this.value.pending?.accountId;
    this.publish({ busy: true });
    try {
      const status = await this.port.reconcile();
      this.publish({
        pending: await this.port.pending(),
        lastAttempt: (await this.port.last?.()) ?? null,
      });
      if (status?.kind === "succeeded")
        this.publish({
          message:
            originalAccount && originalAccount !== this.value.accountId
              ? `Transaction confirmed for ${originalAccount}. The selected player's data will refresh.`
              : "Transaction confirmed. Your shop data will refresh.",
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
      !this.value.transactionAvailable ||
      this.value.phase !== "ready" ||
      this.value.observation?.stale ||
      (a.call.method !== "complete_production" &&
        this.value.observation?.town.paused) ||
      !this.value.observation?.ownershipKnown ||
      this.now() < this.value.observation.receivedAt ||
      this.now() - this.value.observation.receivedAt > 30000
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
    this.accountEpoch++;
    this.invalidateReads();
    this.unsubscribe?.();
    this.stopActivity?.();
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
