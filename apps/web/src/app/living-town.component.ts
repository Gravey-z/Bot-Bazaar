import { townActivityText } from "./living-town-live";
import { describeLivingTownMarketEvent } from "@bot-bazaar/chain";
import { LivingTownSalesComponent } from "./living-town-sales.component";
import { LivingTownAssistantComponent } from "./living-town-assistant.component";
import { TownArtComponent } from "./town-art.component";
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
import { createLivingTownPort, townTransactionUrl } from "./living-town-port";
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
  readonly controller = new LivingTownController(
    this.setup.kind === "ready"
      ? createLivingTownPort(this.setup.profile, {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => localStorage.setItem(key, value),
          removeItem: (key) => localStorage.removeItem(key),
        })
      : null,
    (state) => this.state.set(state),
  );
}
type Tab = TownManagerTab;
type Listing = ReturnType<typeof livingTownListing>;
@Component({
  selector: "app-root",
  providers: [LivingTownScreen],
  imports: [
    DatePipe,
    LivingTownSalesComponent,
    LivingTownAssistantComponent,
    TownArtComponent,
  ],
  templateUrl: "./living-town.component.html",
  styleUrl: "./living-town.component.css",
})
export class LivingTownComponent implements OnInit, OnDestroy {
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
  protected readonly explorer =
    this.screen.setup.kind === "ready"
      ? this.screen.setup.profile.public.explorerUrl
      : "";
  protected readonly tab = signal<Tab>("overview");
  protected readonly shopName = signal("");
  protected readonly renameName = signal("");
  protected readonly recoveryHash = signal("");
  protected readonly quantity = signal("1");
  protected readonly selected = signal<Listing | null>(null);
  protected readonly batchQuantity = signal("1");
  protected readonly productionReview = signal<ProductionReview | null>(null);
  protected readonly elapsedMs = signal(0);
  private observationAnchor = performance.now();
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
  protected readonly tabs = shopManagerTabs;
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
    return pending ? describeTownAttempt(pending) : "";
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
        feedbackRows = [...feedbackRows, ...events].slice(-12);
        this.feedback.set(feedbackRows);
        this.feedbackAnnouncement.set(
          events.map((event) => event.text).join(" "),
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
      }
    });
    let pendingId: string | undefined;
    effect(() => {
      const id = this.state().pending?.id;
      if (id && id !== pendingId)
        queueMicrotask(() => {
          if (this.state().pending?.id === id) this.openManager();
        });
      pendingId = id;
    });
    let previousObservation: TownState["observation"] | undefined;
    effect(() => {
      const observation = this.state().observation;
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
      this.refreshProduction();
    }, 15000);
    this.countdownTimer = setInterval(
      () => this.elapsedMs.set(performance.now() - this.observationAnchor),
      1000,
    );
  }
  ngOnDestroy(): void {
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
    this.managerDialog?.nativeElement.close();
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
    if (!l || !q || !this.canAfford() || l.owner.kind !== "merchant") return;
    void this.screen.controller.act("buy_from_merchant", {
      merchant_id: l.owner.merchant_id,
      item_id: l.item_id,
      quantity: q.quantity,
      expected_listing_revision: l.revision,
      max_total_price: q.total,
    });
    this.closePurchase();
    this.openManager("inventory");
  }
  protected register(): void {
    void this.screen.controller.act("register_player", {});
  }
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
    return productionCountdown(
      job,
      this.state().observation?.chainTimestampNs,
      this.elapsedMs(),
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
      if (this.state().pending?.transactionHash)
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
    if (action.target === "connect") void this.screen.controller.connect();
    else if (action.target === "refresh") void this.screen.controller.refresh();
    else if (action.target === "market")
      document
        .getElementById("marketplace")
        ?.scrollIntoView({ block: "start" });
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
  }
  protected closeHelp(): void {
    this.helpDialog?.nativeElement.close();
  }
  protected helpClosed(): void {
    if (this.helpDialog?.nativeElement.open || !this.helpOpener?.isConnected)
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
