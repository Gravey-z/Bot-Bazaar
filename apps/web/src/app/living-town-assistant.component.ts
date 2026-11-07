import {
  Component,
  computed,
  effect,
  input,
  signal,
  untracked,
} from "@angular/core";
import type { OnDestroy } from "@angular/core";
import { AssistantPanel } from "./assistant-panel";
import type { AssistantPanelState } from "./assistant-panel";
import type { TownState, LivingTownController } from "./living-town-controller";
@Component({
  selector: "app-town-assistant",
  templateUrl: "./living-town-assistant.component.html",
  styleUrl: "./living-town-assistant.component.css",
})
export class LivingTownAssistantComponent implements OnDestroy {
  readonly state = input.required<TownState>();
  readonly controller = input.required<LivingTownController>();
  readonly elapsedMs = input(0);
  protected readonly view = signal<AssistantPanelState>({
    signedIn: false,
    busy: false,
    mode: "off",
    stale: true,
    message: "",
    proposals: [],
    review: null,
    restock: null,
    revision: null,
  });
  private readonly scopeOwner = signal<string | null>(null);
  protected readonly panel = new AssistantPanel(
    () => this.controller().assistant,
    (r) => this.controller().acceptAssistantReview(r),
    (v) => this.view.set(v),
  );
  protected readonly ownerReady = computed(() => {
    const s = this.state();
    return (
      s.phase === "ready" &&
      !!s.accountId &&
      this.scopeOwner() === s.accountId &&
      s.observation?.shop?.owner.kind === "player" &&
      s.observation.shop.owner.account_id === s.accountId &&
      !s.observation.stale
    );
  });
  protected readonly canAccept = computed(() => {
    this.elapsedMs();
    const s = this.state(),
      o = s.observation,
      r = this.view().review;
    if (
      !r ||
      !this.ownerReady() ||
      s.busy ||
      s.pending ||
      !s.transactionAvailable ||
      !o?.ledger ||
      !o.shop ||
      !o.chainTimestampNs ||
      o.town.paused
    )
      return false;
    const age = Date.now() - o.receivedAt;
    if (age < 0 || age > 30000) return false;
    return (
      r.proposal.owner_account_id === s.accountId &&
      r.proposal.expected_shop_revision === o.shop.revision &&
      r.proposal.expected_ledger_revision === o.ledger.revision &&
      r.proposal.expected_policy_revision === o.shop.policy_revision &&
      BigInt(o.chainTimestampNs) + BigInt(age) * 1000000n <
        BigInt(r.proposal.expires_at_ns)
    );
  });
  constructor() {
    effect(() => {
      const s = this.state(),
        o = s.observation;
      // A focus-triggered wallet check temporarily hides owner facts. Keep the panel
      // mounted, conceal its data, and let the wallet port invalidate real switches.
      if (s.phase === "loading" && (!s.accountId || !o?.shop)) return;
      const account = s.accountId,
        shop =
          o?.shop?.owner.kind === "player" &&
          o.shop.owner.account_id === account
            ? o.shop.shop_id
            : null;
      untracked(() => {
        this.panel.setScope(account, shop);
        this.scopeOwner.set(shop ? account : null);
      });
    });
  }
  protected name(item: string): string {
    return item.replaceAll("_", " ");
  }
  protected saveRestock(
    budget: string,
    reserve: string,
    tick: string,
    day: string,
    crystal: boolean,
    wood: boolean,
    herb: boolean,
    iron: boolean,
  ): Promise<void> {
    return this.panel.configureRestock({
      recommendation_budget: budget,
      min_cash_reserve: reserve,
      per_tick_limit: tick,
      per_day_limit: day,
      allowed_items: [
        crystal ? "crystal" : null,
        wood ? "wood" : null,
        herb ? "herb" : null,
        iron ? "iron" : null,
      ].filter((v) => v !== null),
    });
  }
  ngOnDestroy(): void {
    this.panel.close();
  }
}
