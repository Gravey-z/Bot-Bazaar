import { townActivityText } from "./living-town-live";
import { MerchantEconomyComponent } from "./merchant-economy.component";
import { merchantEconomy } from "./living-town-merchants";
import { describeLivingTownMarketEvent } from "@bot-bazaar/chain";
import { LivingTownSalesComponent } from "./living-town-sales.component";
import { LivingTownAssistantComponent } from "./living-town-assistant.component";
import { TownArtComponent } from "./town-art.component";
import { TownGameComponent } from "./game/town-game.component";
import type { TownLocation, TownVisualSnapshot } from "./game/town-game.bridge";
import {
  Component,
  Injectable,
  inject,
  signal,
  computed,
  effect,
  ViewChild,
  ElementRef,
} from "@angular/core";
import type { OnInit, OnDestroy } from "@angular/core";
import { DatePipe } from "@angular/common";
import { LIVING_TOWN_SETUP } from "./living-town-profile";
import {
  LivingTownController,
  initialTownState,
  inventoryRows,
  describeTownAttempt,
} from "./living-town-controller";
import { townTransactionUrl } from "./living-town-port";
import { createPlayerTownPort } from "./guest-town-port";
import type { GuestUiState } from "./guest-town-port";
import { GuestActivityComponent } from "./guest-activity.component";
import type { TownState } from "./living-town-controller";
import type {
  livingTownListing,
  livingTownProductionJob,
} from "@bot-bazaar/chain";
import {
  productionQuote,
  productionReviewMatches,
  productionCountdown,
  durationText,
  itemSymbol,
} from "./living-town-production-ui";
import type { ProductionReview, TownRecipe } from "./living-town-production-ui";
import {
  shopManagerTabs,
  ownedTownObservation,
  townHud,
  townMode,
  townMarketComparisons,
  townSnapshotFresh,
} from "./living-town-layout";
import type { TownManagerTab } from "./living-town-layout";
import { firstLoopTutorial, TutorialGoalTracker } from "./living-town-tutorial";
import { TownFeedbackTracker, TownFeedbackSound } from "./living-town-feedback";
import type { TownFeedback } from "./living-town-feedback";

@Injectable()
export class LivingTownScreen {
  readonly setup = inject(LIVING_TOWN_SETUP);
  readonly state = signal<TownState>({ ...initialTownState });
  readonly guest = signal<GuestUiState>({ mode: "wallet", status: "idle", accountId: null, message: "" });
  readonly controller = new LivingTownController(
    this.setup.kind === "ready"
      ? createPlayerTownPort(this.setup.profile, {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
          removeItem: (key) => localStorage.removeItem(key),
        }, state => this.guest.set(state))
      : null,
    (state) => this.state.set(state),
  );
}
type Tab = TownManagerTab;
type Listing = ReturnType<typeof livingTownListing>;
interface PurchaseUiRequest {
  accountId: string; item: string; quantity: string; merchant: string;
  attemptId: string | null; previousAttemptId: string | null; handoffFinished: boolean; startedAt: number;
}
@Component({
  selector: "app-root",
  providers: [LivingTownScreen],
  imports: [
    DatePipe,
    LivingTownSalesComponent,
    LivingTownAssistantComponent,
    TownArtComponent,
    TownGameComponent,
    MerchantEconomyComponent,
    GuestActivityComponent,
  ],
  templateUrl: "./living-town.component.html",
  styleUrl: "./living-town.component.css",
})
export class LivingTownComponent implements OnInit, OnDestroy {
  protected readonly notice = signal("");
  protected readonly walletVisible = signal(false);
  protected readonly connectionError = signal("");
  private readonly purchaseRequest = signal<PurchaseUiRequest | null>(null);
  protected readonly purchaseToast = signal("");
  protected readonly purchaseToastPending = signal(false);
  private purchaseToastTimer: ReturnType<typeof setTimeout> | undefined;
  private purchaseToastElement: HTMLElement | undefined;
  private readonly readyToastQueue: { accountId: string; text: string }[] = [];
  @ViewChild("purchaseProgressToast") set purchaseProgressToast(ref: ElementRef<HTMLElement> | undefined) {
    this.purchaseToastElement = ref?.nativeElement;
    if (this.purchaseToast()) this.purchaseToastElement?.showPopover?.();
  }
  private showPurchaseToast(message: string, pending: boolean): void {
    if (this.purchaseToastTimer) clearTimeout(this.purchaseToastTimer);
    this.purchaseToastTimer = undefined;
    this.purchaseToast.set(message);
    this.purchaseToastPending.set(pending);
    this.purchaseToastElement?.showPopover?.();
    if (!pending) this.purchaseToastTimer = setTimeout(() => this.dismissPurchaseToast(), 10000);
  }
  protected dismissPurchaseToast(): void {
    if (this.purchaseToastTimer) clearTimeout(this.purchaseToastTimer);
    this.purchaseToastTimer = undefined;
    this.purchaseToast.set("");
    this.purchaseToastElement?.hidePopover?.();
    while (this.readyToastQueue.length) {
      const next = this.readyToastQueue.shift()!;
      if (next.accountId === this.state().accountId) {
        this.showPurchaseToast(next.text, false);
        break;
      }
    }
  }
  protected readonly pendingPurchase = computed(() => {
    const request = this.purchaseRequest(), state = this.state();
    if (!request || request.accountId !== state.accountId) return null;
    const last = state.lastAttempt;
    if (last && last.id === request.attemptId && ["confirmed", "failed", "not_submitted"].includes(last.phase)) return null;
    return state.pending?.id === request.attemptId || !request.handoffFinished ? request : null;
  });
  protected readonly guestToast = signal("");
  protected readonly guestToastPending = signal(false);
  private readonly guestToastTracking = signal(false);
  private guestToastTimer: ReturnType<typeof setTimeout> | undefined;
  private guestToastElement: HTMLElement | undefined;
  @ViewChild("guestProgressToast") set guestProgressToast(ref: ElementRef<HTMLElement> | undefined) {
    this.guestToastElement = ref?.nativeElement;
    if (this.guestToast()) this.guestToastElement?.showPopover?.();
  }
  private showGuestToast(message: string, pending: boolean): void {
    if (this.guestToastTimer) clearTimeout(this.guestToastTimer);
    this.guestToastTimer = undefined;
    this.guestToastPending.set(pending);
    this.guestToast.set(message);
    this.guestToastElement?.showPopover?.();
    if (!pending) this.guestToastTimer = setTimeout(() => this.dismissGuestToast(), 10000);
  }
  protected dismissGuestToast(): void {
    if (this.guestToastTimer) clearTimeout(this.guestToastTimer);
    this.guestToastTimer = undefined;
    this.guestToastTracking.set(false);
    this.guestToast.set("");
    this.guestToastElement?.hidePopover?.();
  }
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeElement: HTMLElement | undefined;
  private walletOpener: HTMLElement | null = null;
  @ViewChild("walletDialog")
  private walletDialog?: ElementRef<HTMLDialogElement>;
  @ViewChild("gameNotice") set gameNotice(
    ref: ElementRef<HTMLElement> | undefined,
  ) {
    this.noticeElement = ref?.nativeElement;
    if (this.notice()) this.noticeElement?.showPopover?.();
  }
  protected showNotice(message: string): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.notice.set(message);
    if (message) {
      this.noticeElement?.showPopover?.();
      this.noticeTimer = setTimeout(() => this.dismissNotice(), 10000);
    } else this.noticeElement?.hidePopover?.();
  }
  protected dismissNotice(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = undefined;
    this.notice.set("");
    this.noticeElement?.hidePopover?.();
  }
  protected openWalletDialog(): void {
    if (this.state().busy) return;
    this.connectionError.set("");
    this.walletOpener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (
      this.sceneDialog?.nativeElement.open ||
      this.managerDialog?.nativeElement.open
    )
      this.walletOpener = document.getElementById("town-shop-menu");
    this.sceneDialog?.nativeElement.close();
    this.managerDialog?.nativeElement.close();
    this.helpDialog?.nativeElement.close();
    this.walletVisible.set(true);
    if (!this.walletDialog?.nativeElement.open)
      this.walletDialog?.nativeElement.showModal();
  }
  protected closeWalletDialog(): void {
    this.walletDialog?.nativeElement.close();
  }
  protected walletDialogClosed(): void {
    if (this.walletDialog?.nativeElement.open) return;
    this.walletVisible.set(false);
    this.walletOpener?.focus();
  }
  protected async connectWallet(): Promise<void> {
    this.dismissGuestToast();
    this.closeWalletDialog();
    this.dismissNotice();
    await this.screen.controller.connect();
  }
  protected async playAsGuest(): Promise<void> {
    if (this.state().busy) return;
    this.connectionError.set("");
    this.closeWalletDialog();
    this.guestToastTracking.set(true);
    this.showGuestToast("Checking for your saved guest…", true);
    if (!await this.screen.controller.playAsGuest()) { this.dismissGuestToast(); return; }
    if (this.guest().status === "active" || this.guest().status === "provisioning") this.closeWalletDialog();
    else {
      const message = this.state().message || this.guest().message || "Guest setup could not complete. Try again shortly.";
      this.connectionError.set(message);
      this.guestToastTracking.set(false);
      this.showGuestToast(message, false);
    }
  }
  protected readonly usePhaser =
    new URLSearchParams(location.search).get("town") === "phaser";
  protected readonly sceneSelection = signal<TownLocation | null>(null);
  protected readonly scenePanel = signal<
    "rex" | "luna" | "bolt" | "notice" | "journal" | null
  >(null);
  private readonly helpVisible = signal(false);
  @ViewChild("sceneDialog") private sceneDialog?: ElementRef<HTMLDialogElement>;
  private sceneOpener: HTMLElement | null = null;
  protected readonly visualSnapshot = computed<TownVisualSnapshot>(() => ({
    selected: this.sceneSelection(),
    blocked:
      this.managerVisible() ||
      this.selected() !== null ||
      this.scenePanel() !== null ||
      this.walletVisible() ||
      this.helpVisible(),
    shopLabel: this.shop()?.name ?? "Your shop",
  }));
  protected openLocation(location: TownLocation): void {
    if (this.visualSnapshot().blocked) return;
    this.sceneSelection.set(location);
    document.getElementById("town-shop-menu")?.focus();
    if (location === "shop") this.openManager();
    else if (location === "production" || location === "listings")
      this.openManager(location);
    else this.openScenePanel(location);
  }
  protected openScenePanel(
    panel: "rex" | "luna" | "bolt" | "notice" | "journal",
  ): void {
    const fromManager = this.managerDialog?.nativeElement.open;
    this.sceneOpener = fromManager
      ? document.getElementById("town-shop-menu")
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (fromManager) this.closeManager();
    this.scenePanel.set(panel);
    this.sceneDialog?.nativeElement.showModal();
  }
  protected closeScenePanel(): void {
    this.sceneDialog?.nativeElement.close();
  }
  protected openGuestActivity(): void {
    this.openManager("activity");
  }
  protected visitGuestMerchant(merchant: "rex" | "luna" | "bolt"): void {
    if (this.usePhaser) { this.openScenePanel(merchant); return; }
    this.closeManager();
    const stall = document.getElementById(`merchant-${merchant}`);
    stall?.scrollIntoView({ behavior: "smooth", block: "start" }); stall?.focus();
  }
  protected scenePanelClosed(): void {
    this.scenePanel.set(null);
    if (
      !this.selected() &&
      !this.managerVisible() &&
      !this.walletDialog?.nativeElement.open
    )
      this.sceneOpener?.focus();
  }
  private readonly feedbackSound = new TownFeedbackSound();
  protected readonly feedback = signal<TownFeedback[]>([]);
  protected readonly feedbackAnnouncement = signal("");
  protected readonly managerVisible = signal(false);
  protected readonly soundEnabled = signal(false);
  protected readonly soundMessage = signal("");
  @ViewChild("managerDialog")
  private managerDialog?: ElementRef<HTMLDialogElement>;
  @ViewChild("purchaseDialog")
  private purchaseDialog?: ElementRef<HTMLDialogElement>;
  @ViewChild("helpDialog") private helpDialog?: ElementRef<HTMLDialogElement>;
  private helpOpener: HTMLElement | null = null;
  protected readonly goalNotice = signal("");
  protected readonly tutorial = computed(() => {
    this.elapsedMs();
    return firstLoopTutorial(this.state(), this.screen.setup.kind, Date.now());
  });
  private managerOpener: HTMLElement | null = null;
  private purchaseOpener: HTMLElement | null = null;
  protected readonly modeLabel = computed(() =>
    townMode(this.screen.setup.kind, this.state().accountId),
  );
  protected readonly hud = computed(() => {
    this.elapsedMs();
    return townHud(this.state(), Date.now());
  });
  protected readonly nextAction = computed(() => {
    return this.tutorial().action;
  });
  protected readonly comparisons = computed(() => {
    this.elapsedMs();
    return townMarketComparisons(this.state(), Date.now());
  });
  protected readonly marketEvent = computed(() => {
    const t = this.state().observation?.town;
    return t?.market_event
      ? {
          ...describeLivingTownMarketEvent(t.market_event, t.epoch),
          event: t.market_event,
        }
      : null;
  });
  protected readonly activityText = townActivityText;
  protected readonly productionPolicy =
    "Inputs are consumed when production starts. Batches cannot be cancelled or refunded. The full batch becomes claimable together when its production time has elapsed on the network. A town pause blocks new starts; ready batches can still be claimed.";
  protected readonly screen = inject(LivingTownScreen);
  protected readonly state = this.screen.state;
  protected readonly guest = this.screen.guest;
  protected readonly isGuest = computed(() => this.guest().mode === "guest");
  protected readonly explorer =
    this.screen.setup.kind === "ready"
      ? this.screen.setup.profile.public.explorerUrl
      : "";
  protected readonly activityPanelOpen = signal(true);
  private readonly activityNow = signal(Date.now());
  protected activityAge(time: number): string {
    const minutes = Math.floor(Math.max(0, this.activityNow() - time) / 60000);
    if (minutes === 0) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
  }
  private activityCategory(title: string): string {
    if (/\bregistered$/.test(title)) return "Registration";
    if (/\b(created|renamed)\b/.test(title)) return "Shop";
    if (/\bupgraded\b/.test(title)) return "Upgrade";
    if (/\b(changed|set)\b.*\bprice\b/.test(title)) return "Price change";
    if (/\blisted\b|\bremoved\b.*\blisting\b/.test(title)) return "Listing";
    if (/\boffered to buy\b/.test(title)) return "Trade offer";
    if (/^(Rex|Luna|Bolt) bought\b.*\bfrom (Rex|Luna|Bolt)$/.test(title)) return "Trade";
    if (/\bbought\b/.test(title)) return "Purchase";
    if (/\bsold\b/.test(title)) return "Sale";
    if (/\bproduction batch\b/.test(title)) return "Crafting";
    if (/\brestocked\b/.test(title)) return "Restock";
    return "Activity";
  }
  protected readonly recentTownActivity = computed(() => {
    if (!this.explorer) return [];
    const transactions = new Map<string, TownState["activity"]["events"][number]>();
    for (const event of this.state().activity.events) {
      if (event.source !== "confirmed" || !("transaction_hash" in event.data) || !event.data.transaction_hash) continue;
      const hash = event.data.transaction_hash, old = transactions.get(hash);
      if (!old || event.type === "transaction_confirmed") transactions.set(hash, event);
    }
    return [...transactions.entries()].sort(([, a], [, b]) => {
      const height = BigInt(b.checkpoint.block_height) - BigInt(a.checkpoint.block_height);
      if (height) return height > 0n ? 1 : -1;
      const sequence = BigInt(b.checkpoint.event_sequence) - BigInt(a.checkpoint.event_sequence);
      return sequence > 0n ? 1 : sequence < 0n ? -1 : 0;
    }).slice(0, 3).map(([hash, event]) => {
      const title = event.type === "agent_action"
        ? `${event.data.merchant[0]!.toUpperCase()}${event.data.merchant.slice(1)} ${event.data.proposal_type.replaceAll("_", " ")}`
        : townActivityText(event);
      const time = Number(BigInt(event.checkpoint.block_timestamp_ns) / 1000000n);
      return {
      id: hash,
      title,
      category: this.activityCategory(title),
      description: title.replace(/\b(\d+) gold\b/g, "$1g")
        .replace(/; (?=(?:Rex|Luna|Bolt) restocked\b)/g, "\n"),
      url: new URL(`txns/${encodeURIComponent(hash)}`, this.explorer.endsWith("/") ? this.explorer : this.explorer + "/").href,
      time,
      dateTime: new Date(time).toISOString(),
    }; });
  });
  protected readonly tab = signal<Tab>("overview");
  protected readonly shopName = signal("");
  protected readonly renameName = signal("");
  protected readonly recoveryHash = signal("");
  protected readonly quantity = signal("1");
  protected readonly selected = signal<Listing | null>(null);
  protected readonly batchQuantity = signal("1");
  protected readonly productionReview = signal<ProductionReview | null>(null);
  protected readonly activeBatches = computed(() =>
    (this.state().observation?.production?.items ?? []).filter(job => job.status === "running"));
  protected readonly completedBatches = computed(() =>
    (this.state().observation?.production?.items ?? []).filter(job => job.status === "completed").slice().reverse());
  protected readonly elapsedMs = signal(0);
  private observationAnchor = performance.now();
  private productionClockNs: string | undefined;
  private productionClockAnchor = performance.now();
  private productionClockAccount: string | null | undefined;
  protected readonly recipeCards = computed(() =>
    (this.state().observation?.recipes ?? []).map((recipe) => ({
      recipe,
      ...productionQuote(
        this.state().observation,
        recipe,
        this.batchQuantity(),
      ),
    })),
  );
  protected readonly reviewCurrent = computed(() => {
    const r = this.productionReview();
    return !!r && productionReviewMatches(r, this.state().observation);
  });
  protected readonly queued = computed(() => {
    const p = this.state().pending;
    return p?.accountId === this.state().accountId &&
      p.call.method === "start_production"
      ? p
      : null;
  });
  protected readonly productionFailure = computed(() => {
    const p = this.state().lastAttempt;
    return p?.accountId === this.state().accountId &&
      p.phase === "failed" &&
      ["start_production", "complete_production"].includes(p.call.method)
      ? p
      : null;
  });
  protected readonly durationText = durationText;
  protected readonly itemSymbol = itemSymbol;
  protected readonly profiles = [
    { id: "rex", name: "Rex", specialty: "Crystals", color: "sage" },
    { id: "luna", name: "Luna", specialty: "Herbs", color: "lilac" },
    { id: "bolt", name: "Bolt", specialty: "Wood & iron", color: "peach" },
  ] as const;
  protected readonly merchantEconomies = computed(() => {
    this.elapsedMs();
    const s = this.state();
    return {
      rex: merchantEconomy(
        s.observation,
        s.activity.events,
        "rex",
        Date.now(),
        s.activity.mode,
        s.activity.gap,
      ),
      luna: merchantEconomy(
        s.observation,
        s.activity.events,
        "luna",
        Date.now(),
        s.activity.mode,
        s.activity.gap,
      ),
      bolt: merchantEconomy(
        s.observation,
        s.activity.events,
        "bolt",
        Date.now(),
        s.activity.mode,
        s.activity.gap,
      ),
    };
  });
  protected get tabs() { return shopManagerTabs.filter(tab => this.isGuest() ? tab.id !== "assistant" : tab.id !== "activity"); }
  protected readonly items = computed(() => {
    const ledger = this.state().observation?.ledger;
    return ledger ? inventoryRows(ledger) : [];
  });
  protected readonly shop = computed(
    () => ownedTownObservation(this.state())?.shop ?? null,
  );
  protected readonly reserved = computed(() => {
    const account = this.state().accountId,
      s = this.screen.setup;
    return (
      !!account &&
      s.kind === "ready" &&
      [
        s.profile.identity.deployment.contract_id,
        s.profile.identity.ownerId,
        s.profile.identity.operatorId,
        ...Object.values(s.profile.identity.controllers),
      ].includes(account)
    );
  });
  protected readonly canAct = computed(() => {
    this.state();
    this.elapsedMs();
    return this.screen.controller.canTransact && !this.reserved();
  });
  protected readonly nameValid = computed(() =>
    this.validName(this.shopName()),
  );
  protected readonly renameValid = computed(
    () =>
      this.validName(this.renameName()) &&
      this.renameName() !== this.shop()?.name,
  );
  protected readonly quote = computed(() => {
    const listing = this.selected(),
      text = this.quantity();
    if (!listing || !/^[1-9][0-9]{0,2}$/.test(text)) return null;
    const q = BigInt(text),
      total = q * BigInt(listing.unit_price);
    if (q > 100n || q > BigInt(listing.remaining_quantity) || total > 10000n)
      return null;
    return { quantity: q.toString(), total: total.toString() };
  });
  protected readonly level = computed(() =>
    this.shop()?.production_slots === "1" ? "Level 1" : "Expanded shop",
  );
  protected readonly canRegister = computed(() => {
    const o = this.state().observation;
    return (
      this.canAct() &&
      !!o &&
      !o.player &&
      BigInt(o.town.registered_player_count) < BigInt(o.town.limits.max_players)
    );
  });
  protected readonly canAfford = computed(() => {
    const q = this.quote(),
      ledger = this.state().observation?.ledger;
    return !!q && !!ledger && BigInt(ledger.gold.available) >= BigInt(q.total);
  });
  protected readonly pendingSummary = computed(() => {
    const pending = this.state().pending;
    const summary = pending ? describeTownAttempt(pending) : "";
    return this.isGuest() ? summary.replace(/Wallet fees use NEAR separately\.|wallet fees use NEAR\./g, "Guest signing is automatic.") : summary;
  });
  protected readonly pendingUrl = computed(() => {
    const s = this.state(),
      setup = this.screen.setup;
    return s.pending?.transactionHash && setup.kind === "ready"
      ? townTransactionUrl(
          setup.profile.public.explorerUrl,
          s.pending.transactionHash,
        )
      : null;
  });
  constructor() {
    effect(() => {
      if (this.isGuest() && this.tab() === "activity")
        void this.screen.controller.refreshGuestActivity();
    });
    let craftingAttempt: { id: string; accountId: string; description: string; completing: boolean } | null = null;
    let lastCraftingStage = "";
    effect(() => {
      const state = this.state(), pending = state.pending;
      if (craftingAttempt && craftingAttempt.accountId !== state.accountId) {
        craftingAttempt = null;
        lastCraftingStage = "";
        this.dismissPurchaseToast();
      }
      if (pending?.accountId === state.accountId &&
        (pending.call.method === "start_production" || pending.call.method === "complete_production")) {
        const args = pending.call.args;
        if (craftingAttempt?.id !== pending.id) {
          const completing = pending.call.method === "complete_production";
          const job = "job_id" in args
            ? state.observation?.production?.items.find(j => j.job_id === args.job_id)
            : undefined;
          const description = "recipe_id" in args
            ? `${args.quantity} ${this.itemName(args.recipe_id).toLowerCase()}`
            : job ? `${job.output_quantity} ${this.itemName(job.output_item).toLowerCase()}`
            : "your batch";
          craftingAttempt = { id: pending.id, accountId: pending.accountId, description, completing };
        }
      }
      if (!craftingAttempt) return;
      const last = state.lastAttempt;
      const attempt = last?.id === craftingAttempt.id && last.accountId === craftingAttempt.accountId &&
        ["confirmed", "failed", "not_submitted"].includes(last.phase)
        ? last : pending?.id === craftingAttempt.id ? pending : null;
      if (!attempt) return;
      const stage = `${attempt.id}:${attempt.phase}`;
      if (stage === lastCraftingStage) return;
      lastCraftingStage = stage;
      const { description, completing } = craftingAttempt;
      if (attempt.phase === "confirmed")
        this.showPurchaseToast(completing ? `Crafting complete! Collected ${description}. Your inventory is updating.`
          : `Started crafting ${description}. You can follow its progress in your shop.`, false);
      else if (attempt.phase === "failed")
        this.showPurchaseToast(completing ? `Could not collect ${description}. Completion was not confirmed.`
          : `Could not start crafting ${description}. No batch was confirmed.`, false);
      else if (attempt.phase === "not_submitted")
        this.showPurchaseToast(`Crafting request was not submitted. ${state.message || "Please try again."}`, false);
      else this.showPurchaseToast(attempt.phase === "awaiting_wallet"
        ? `Approve ${completing ? "collecting" : "crafting"} ${description} in your wallet…`
        : `${completing ? "Collecting" : "Starting"} ${description}… Waiting for confirmation.`, true);
    });
    let lastPurchaseStage = "";
    effect(() => {
      const state = this.state(), pending = state.pending;
      let request = this.purchaseRequest();
      if (pending?.call.method === "buy_from_merchant" && pending.accountId === state.accountId && request?.attemptId !== pending.id) {
        const args = pending.call.args;
        if ("item_id" in args && "quantity" in args && "merchant_id" in args) {
          request = { accountId: pending.accountId, item: args.item_id, quantity: args.quantity,
            merchant: args.merchant_id, attemptId: pending.id, previousAttemptId: request?.previousAttemptId ?? state.lastAttempt?.id ?? null,
            handoffFinished: request?.handoffFinished ?? true, startedAt: request?.startedAt ?? Date.now() };
          this.purchaseRequest.set(request);
        }
      }
      if (!request) return;
      const guest = this.guest();
      if (request.accountId !== state.accountId && !(guest.mode === "guest" && guest.accountId === request.accountId)) {
        this.purchaseRequest.set(null); this.dismissPurchaseToast(); lastPurchaseStage = ""; return;
      }
      const merchant = request.merchant[0]!.toUpperCase() + request.merchant.slice(1);
      const description = `${request.quantity} ${this.itemName(request.item).toLowerCase()} from ${merchant}`;
      const last = state.lastAttempt;
      const matchingLast = last?.accountId === request.accountId && last.call.method === "buy_from_merchant" &&
        (last.id === request.attemptId || last.id !== request.previousAttemptId);
      const phase = matchingLast && ["confirmed", "failed", "not_submitted"].includes(last.phase)
        ? last.phase : pending?.id === request.attemptId ? pending.phase : request.handoffFinished ? "not_submitted" : "preparing";
      const stage = `${request.startedAt}:${phase}`;
      if (stage === lastPurchaseStage) return;
      lastPurchaseStage = stage;
      if (phase === "confirmed") this.showPurchaseToast(`Bought ${description}. Your inventory is updating.`, false);
      else if (phase === "failed") this.showPurchaseToast(`The purchase of ${description} failed. No purchase was confirmed.`, false);
      else if (phase === "not_submitted") this.showPurchaseToast(`Purchase of ${description} was not submitted. ${state.message || "Please review the offer again."}`, false);
      else this.showPurchaseToast(phase === "awaiting_wallet"
        ? `Approve your purchase of ${description} in your wallet…`
        : phase === "preparing" || phase === "prepared" ? `Preparing your purchase of ${description}…`
        : `Buying ${description}… Waiting for confirmation.`, true);
    });
    let lastGuestStage = "", sawGuest = false;
    effect(() => {
      if (!this.guestToastTracking()) { lastGuestStage = ""; sawGuest = false; return; }
      const guest = this.guest();
      const state = this.state();
      let stage: string, message: string, pending = true;
      if (guest.mode !== "guest") {
        stage = sawGuest ? "disconnected" : "checking";
        message = sawGuest ? "Guest disconnected. Your session is saved in this browser." : "Checking for your saved guest…";
        pending = !sawGuest;
      } else {
        sawGuest = true;
        stage = guest.status;
        if (guest.status === "unavailable" && guest.registrationObserved) {
          message = "Trying to restore your connection…";
        } else if (guest.status === "unavailable" || guest.status === "failed") {
          message = guest.message || "Guest setup is unavailable. Try connecting again shortly.";
          pending = false;
        } else if (guest.status === "provisioning") {
          message = "Creating your guest account… This can take a moment.";
        } else if (guest.status === "active") {
          const observation = state.observation;
          const balanceReady = state.accountId === guest.accountId &&
            townHud(state, Date.now()).available !== null &&
            observation?.stale === false && state.phase === "ready";
          pending = !guest.registrationObserved || !balanceReady || !state.transactionAvailable || !!state.pending;
          if (!guest.registrationObserved) {
            stage = "registering";
            message = "Account ready. Confirming your guest registration…";
          } else if (!balanceReady) {
            stage = state.phase === "unavailable" || observation?.stale ? "reconnecting" : "loading-balance";
            message = stage === "reconnecting"
              ? "The town is reconnecting…"
              : "The merchants are preparing your arrival…";
          } else if (!state.transactionAvailable) {
            stage = "restoring-actions";
            message = "Guest connected. Restoring your saved action details before you can play…";
          } else if (state.pending) {
            stage = "recovering-action";
            message = "Guest connected. Checking your previous action before starting another…";
          } else {
            stage = "ready";
            message = `${guest.displayId ?? "Guest"} is connected. Your gold and shop are up to date.`;
          }
        } else message = "Starting your guest session…";
      }
      if (stage !== lastGuestStage) {
        lastGuestStage = stage;
        this.showGuestToast(message, pending);
      }
      if (!pending) this.guestToastTracking.set(false);
    });
    let connectionGuest: string | null = null, connectionNeedsData = false;
    effect(() => {
      const guest = this.guest(), state = this.state();
      const account = guest.mode === "guest" ? guest.accountId : null;
      if (!account) { connectionGuest = null; connectionNeedsData = false; return; }
      if (account !== connectionGuest) { connectionGuest = account; connectionNeedsData = false; }
      const needsData = guest.status === "unavailable" || (guest.status === "active" &&
        (state.phase !== "ready" || state.observation?.stale === true ||
          state.accountId !== account || townHud(state, Date.now()).available === null));
      // Notify once per interruption, including restoring an existing browser
      // session, without restarting the toast on every background poll.
      if (needsData && !connectionNeedsData) this.guestToastTracking.set(true);
      connectionNeedsData = needsData;
    });
    let previousMessage: string | undefined;
    effect(() => {
      const message = this.state().message;
      if (message === previousMessage) return;
      previousMessage = message;
      this.showNotice(
        message ===
          "Wallet connection could not be checked. Refresh to try again."
          ? ""
          : message,
      );
    });
    const feedbackTracker = new TownFeedbackTracker();
    let feedbackScope: string | null = null;
    let feedbackRows: TownFeedback[] = [];
    effect(() => {
      this.elapsedMs();
      const state = this.state(),
        now = Date.now();
      const o =
        this.screen.setup.kind === "ready" ? ownedTownObservation(state) : null;
      const scope =
        o && townSnapshotFresh(state, now)
          ? `${state.accountId}:${o.shop!.shop_id}`
          : null;
      const events = feedbackTracker.observe(state, now);
      if (scope !== feedbackScope || !scope) {
        feedbackScope = scope;
        feedbackRows = [];
        this.feedback.set([]);
        this.feedbackAnnouncement.set("");
      }
      if (scope && events.length) {
        const ready = events.filter(event => event.kind === "ready");
        if (ready.length && state.accountId) {
          const text = ready.map(event => event.text).join(" ");
          if (this.purchaseToast()) {
            if (this.readyToastQueue.length < 12)
              this.readyToastQueue.push({ accountId: state.accountId, text });
          } else this.showPurchaseToast(text, false);
        }
        const updates = events.filter(event => event.kind !== "ready");
        feedbackRows = [...feedbackRows, ...updates].slice(-12);
        this.feedback.set(feedbackRows);
        this.feedbackAnnouncement.set(
          updates.map((event) => event.text).join(" "),
        );
        this.feedbackSound.play();
      }
    });
    let last: string | null | undefined;
    effect(() => {
      const account = this.state().accountId;
      if (account !== last) {
        last = account;
        this.selected.set(null);
        this.quantity.set("1");
        this.shopName.set("");
        this.renameName.set("");
        this.recoveryHash.set("");
        this.tab.set("overview");
        this.batchQuantity.set("1");
        this.productionReview.set(null);
        this.managerDialog?.nativeElement.close();
        this.purchaseDialog?.nativeElement.close();
        this.helpDialog?.nativeElement.close();
        this.sceneDialog?.nativeElement.close();
      }
    });
    let previousObservation: TownState["observation"] | undefined;
    effect(() => {
      const observation = this.state().observation;
      const account = this.state().accountId;
      const now = performance.now();
      if (account !== this.productionClockAccount) {
        this.productionClockAccount = account;
        this.productionClockNs = undefined;
        this.productionClockAnchor = now;
      }
      const chainNs = observation?.chainTimestampNs;
      if (chainNs && (!this.productionClockNs || BigInt(chainNs) > BigInt(this.productionClockNs))) {
        // Repeated database reads must not restart the estimate. When chain time
        // advances, retain any estimated progress it has not yet caught up with.
        const previousEstimate = this.productionClockNs
          ? BigInt(this.productionClockNs) + BigInt(Math.min(30000, Math.max(0, Math.floor(now - this.productionClockAnchor)))) * 1000000n
          : BigInt(chainNs);
        const carryMs = previousEstimate > BigInt(chainNs)
          ? Number((previousEstimate - BigInt(chainNs)) / 1000000n)
          : 0;
        this.productionClockNs = chainNs;
        this.productionClockAnchor = now - carryMs;
      }
      if (observation !== previousObservation) {
        previousObservation = observation;
        this.observationAnchor = performance.now();
        this.elapsedMs.set(0);
      }
    });
    const goals = new TutorialGoalTracker();
    let goalScope: string | null = null;
    effect(() => {
      const view = this.tutorial(),
        notice = goals.observe(view);
      if (
        view.scope !== goalScope ||
        !view.scope ||
        !view.fresh ||
        view.blocked
      ) {
        goalScope = view.scope;
        this.goalNotice.set("");
      } else if (notice) this.goalNotice.set(notice);
    });
    let historyScope: string | null = null,
      lastHistoryRequest = 0;
    effect(() => {
      const view = this.tutorial(),
        state = this.state(),
        shop = ownedTownObservation(state)?.shop;
      if (!view.scope || !shop) {
        historyScope = null;
        return;
      }
      const changed = historyScope !== view.scope;
      if (changed) {
        historyScope = view.scope;
        lastHistoryRequest = 0;
      }
      const now = Date.now(),
        history = state.history;
      if (
        view.completed === view.steps.length ||
        !view.fresh ||
        state.historyBusy ||
        (!changed && now - lastHistoryRequest < 15000)
      )
        return;
      if (
        changed ||
        !history ||
        history.shopId !== shop.shop_id ||
        history.stale ||
        now - history.receivedAt >= 15000
      ) {
        lastHistoryRequest = now;
        void this.screen.controller.loadHistory();
      }
    });
  }
  private timer: ReturnType<typeof setInterval> | undefined;
  private countdownTimer: ReturnType<typeof setInterval> | undefined;
  ngOnInit(): void {
    void this.screen.controller.start();
    this.timer = setInterval(() => {
      this.activityNow.set(Date.now());
      this.refreshProduction();
    }, 15000);
    this.countdownTimer = setInterval(
      () => this.elapsedMs.set(performance.now() - this.observationAnchor),
      1000,
    );
  }
  ngOnDestroy(): void {
    if (this.purchaseToastTimer) clearTimeout(this.purchaseToastTimer);
    if (this.guestToastTimer) clearTimeout(this.guestToastTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.feedbackSound.dispose();
    if (this.timer) clearInterval(this.timer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.screen.controller.stop();
  }
  protected validName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.exec(name)?.[0] === name;
  }
  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  protected offers(merchant: string): Listing[] {
    return (
      this.state().observation?.listings.filter(
        (l) => l.owner.kind === "merchant" && l.owner.merchant_id === merchant,
      ) ?? []
    );
  }
  protected itemName(id: string): string {
    return (
      (
        {
          crystal: "Crystals",
          wood: "Wood",
          herb: "Herbs",
          iron: "Iron",
          health_potion: "Health potions",
          iron_tool: "Iron tools",
        } as Record<string, string>
      )[id] ?? "Unknown item"
    );
  }
  protected selectOffer(listing: Listing): void {
    this.selected.set(listing);
    this.quantity.set("1");
    this.purchaseOpener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (this.sceneDialog?.nativeElement.open)
      this.purchaseOpener = this.sceneOpener;
    this.managerDialog?.nativeElement.close();
    this.sceneDialog?.nativeElement.close();
    queueMicrotask(() => {
      if (
        this.selected()?.listing_id === listing.listing_id &&
        !this.purchaseDialog?.nativeElement.open
      )
        this.purchaseDialog?.nativeElement.showModal();
    });
  }
  protected buy(): void {
    const l = this.selected(),
      q = this.quote();
    if (!l || !q || !this.canAfford() || l.owner.kind !== "merchant" || this.state().busy || !this.state().accountId) return;
    const startedAt = Date.now();
    this.purchaseRequest.set({ accountId: this.state().accountId!, item: l.item_id, quantity: q.quantity,
      merchant: l.owner.merchant_id, attemptId: null, previousAttemptId: this.state().lastAttempt?.id ?? null,
      handoffFinished: false, startedAt });
    const finish = (): void => {
      const current = this.purchaseRequest();
      if (current?.startedAt === startedAt) this.purchaseRequest.set({ ...current, handoffFinished: true });
    };
    void this.screen.controller.act("buy_from_merchant", {
      merchant_id: l.owner.merchant_id,
      item_id: l.item_id,
      quantity: q.quantity,
      expected_listing_revision: l.revision,
      max_total_price: q.total,
    }).then(finish, finish);
    this.closePurchase();
  }
  protected register(): void {
    this.managerDialog?.nativeElement.close();
    void this.screen.controller.act("register_player", {});
  }
  protected retryRegistration(): void {
    this.managerDialog?.nativeElement.close();
    void this.screen.controller.retryRegistration();
  }
  protected readonly canRetryRegistration = computed(() => {
    const s = this.state(),
      o = s.observation,
      a = s.pending;
    this.elapsedMs();
    return (
      !!a &&
      a.phase === "unknown" &&
      !a.transactionHash &&
      a.call.method === "register_player" &&
      a.accountId === s.accountId &&
      o?.accountId === s.accountId &&
      !o?.player &&
      !!o?.ownershipKnown &&
      !o.stale &&
      !o.town.paused &&
      !s.busy &&
      s.transactionAvailable &&
      Date.now() >= o.receivedAt &&
      Date.now() - o.receivedAt <= 30000
    );
  });
  protected purchaseUpgrade(): void {
    const o = this.state().observation;
    if (!this.canAct() || !o?.shop || !o.upgrade?.eligible) return;
    void this.screen.controller.act("purchase_upgrade", {
      shop_id: o.shop.shop_id,
      upgrade_id: "second_slot",
      expected_shop_revision: o.shop.revision,
    });
  }
  protected create(): void {
    if (this.nameValid())
      void this.screen.controller.act("create_shop", { name: this.shopName() });
  }
  protected rename(): void {
    const s = this.shop();
    if (s && this.renameValid())
      void this.screen.controller.act("rename_shop", {
        shop_id: s.shop_id,
        expected_shop_revision: s.revision,
        name: this.renameName(),
      });
  }
  protected canClaim(job: ReturnType<typeof livingTownProductionJob>): boolean {
    this.elapsedMs();
    return (
      this.screen.controller.canClaim && !this.reserved() && this.isReady(job)
    );
  }
  protected isReady(job: ReturnType<typeof livingTownProductionJob>): boolean {
    const timestamp = this.state().observation?.chainTimestampNs;
    return (
      job.status === "running" &&
      !!timestamp &&
      BigInt(timestamp) >= BigInt(job.ready_at_ns)
    );
  }
  protected claim(id: string): void {
    void this.screen.controller.act("complete_production", { job_id: id });
  }
  protected reviewRecipe(recipe: TownRecipe): void {
    const quote = productionQuote(
      this.state().observation,
      recipe,
      this.batchQuantity(),
    );
    if (!this.canAct() || quote.reason || !quote.review) return;
    this.productionReview.set(quote.review);
  }
  protected startBatch(): void {
    const r = this.productionReview();
    if (!r || !this.canAct() || !this.reviewCurrent()) return;
    this.productionReview.set(null);
    void this.screen.controller.act("start_production", {
      shop_id: r.shopId,
      recipe_id: r.recipe.recipe_id,
      recipe_version: r.recipe.version,
      quantity: r.quantity,
      expected_shop_revision: r.shopRevision,
    });
  }
  protected jobCountdown(
    job: ReturnType<typeof livingTownProductionJob>,
  ): string {
    this.elapsedMs();
    return productionCountdown(
      job,
      this.productionClockNs,
      performance.now() - this.productionClockAnchor,
    ).text;
  }
  protected jobDuration(
    job: ReturnType<typeof livingTownProductionJob>,
  ): string {
    return durationText(
      (
        (BigInt(job.ready_at_ns) - BigInt(job.start_at_ns)) /
        1000000000n
      ).toString(),
    );
  }
  protected refreshProduction(): void {
    void (async () => {
      if (this.state().pending && this.state().pending?.phase !== "prepared")
        await this.screen.controller.checkTransaction();
      else await this.screen.controller.refresh();
      if (this.tab() === "history" && !this.state().history?.nextCursor)
        await this.screen.controller.loadHistory();
      else if (this.tab() === "listings" && !this.state().market?.nextCursor)
        await this.screen.controller.loadMarket();
    })();
  }
  protected moveTab(event: KeyboardEvent, index: number): void {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % this.tabs.length
        : event.key === "ArrowLeft"
          ? (index + this.tabs.length - 1) % this.tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? this.tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    this.tab.set(this.tabs[next]!.id);
    document.getElementById(`shop-tab-${this.tabs[next]!.id}`)?.focus();
  }
  protected openManager(tab: Tab = "overview"): void {
    this.sceneDialog?.nativeElement.close();
    this.helpDialog?.nativeElement.close();
    const dialog = this.managerDialog?.nativeElement;
    this.tab.set(tab);
    if (!dialog || dialog.open) return;
    this.purchaseDialog?.nativeElement.close();
    this.managerOpener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    this.feedbackAnnouncement?.set("");
    this.managerVisible?.set(true);
  }
  protected closeManager(): void {
    this.managerDialog?.nativeElement.close();
  }
  protected managerClosed(): void {
    if (this.managerDialog?.nativeElement.open) return;
    this.feedbackAnnouncement?.set("");
    this.managerVisible?.set(false);
    this.productionReview.set(null);
    this.tab.set("overview");
    if (
      !this.purchaseDialog?.nativeElement.open &&
      !this.helpDialog?.nativeElement.open &&
      !this.sceneDialog?.nativeElement.open &&
      !this.walletDialog?.nativeElement.open &&
      this.managerOpener?.isConnected
    )
      this.managerOpener.focus();
  }
  protected closePurchase(): void {
    this.purchaseDialog?.nativeElement.close();
    this.selected.set(null);
  }
  protected purchaseClosed(): void {
    if (this.purchaseDialog?.nativeElement.open) return;
    this.selected.set(null);
    if (
      !this.managerDialog?.nativeElement.open &&
      !this.helpDialog?.nativeElement.open &&
      this.purchaseOpener?.isConnected
    )
      this.purchaseOpener.focus();
  }
  protected followNextAction(): void {
    const action = this.nextAction();
    if (action.target === "connect") this.openWalletDialog();
    else if (action.target === "refresh") void this.screen.controller.refresh();
    else if (action.target === "market") this.openLocation("rex");
    else this.openManager(action.tab);
  }
  protected async toggleFeedbackSound(): Promise<void> {
    if (this.soundEnabled()) {
      this.feedbackSound.mute();
      this.soundEnabled.set(false);
      this.soundMessage.set("");
    } else {
      const enabled = await this.feedbackSound.enable();
      this.soundEnabled.set(enabled);
      this.soundMessage.set(
        enabled
          ? ""
          : "Sound is unavailable. All feedback remains visible as text.",
      );
    }
  }
  protected openHelp(): void {
    const dialog = this.helpDialog?.nativeElement;
    if (!dialog || dialog.open) return;
    this.helpOpener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    this.helpVisible.set(true);
  }
  protected closeHelp(): void {
    this.helpDialog?.nativeElement.close();
  }
  protected helpClosed(): void {
    this.helpVisible.set(false);
    if (
      this.helpDialog?.nativeElement.open ||
      this.walletDialog?.nativeElement.open ||
      !this.helpOpener?.isConnected
    )
      return;
    const manager = this.managerDialog?.nativeElement,
      purchase = this.purchaseDialog?.nativeElement;
    if (
      (manager?.open && !manager.contains(this.helpOpener)) ||
      (purchase?.open && !purchase.contains(this.helpOpener))
    )
      return;
    this.helpOpener.focus();
  }
}
