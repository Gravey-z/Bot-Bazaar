import {
  Component,
  Injectable,
  inject,
  signal,
  computed,
  effect,
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
type Tab = "overview" | "inventory" | "production" | "history" | "assistant";
type Listing = ReturnType<typeof livingTownListing>;
@Component({
  selector: "app-root",
  providers: [LivingTownScreen],
  imports: [DatePipe],
  templateUrl: "./living-town.component.html",
  styleUrl: "./living-town.component.css",
})
export class LivingTownComponent implements OnInit, OnDestroy {
  protected readonly productionPolicy =
    "Inputs are consumed when production starts. Batches cannot be cancelled or refunded. The full batch becomes claimable together when its production time has elapsed on the network. A town pause blocks new starts; ready batches can still be claimed.";
  protected readonly screen = inject(LivingTownScreen);
  protected readonly state = this.screen.state;
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
  protected readonly tabs = [
    { id: "overview", name: "Overview" },
    { id: "inventory", name: "Inventory" },
    { id: "production", name: "Production" },
    { id: "history", name: "History" },
    { id: "assistant", name: "Assistant" },
  ] as const;
  protected readonly items = computed(() => {
    const ledger = this.state().observation?.ledger;
    return ledger ? inventoryRows(ledger) : [];
  });
  protected readonly shop = computed(
    () => this.state().observation?.shop ?? null,
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
      }
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
    document.getElementById("purchase-review")?.focus();
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
  }
  protected register(): void {
    void this.screen.controller.act("register_player", {});
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
    if (this.state().pending?.transactionHash)
      void this.screen.controller.checkTransaction();
    else void this.screen.controller.refresh();
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
}
