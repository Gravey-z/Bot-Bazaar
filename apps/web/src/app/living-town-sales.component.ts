import {
  Component,
  computed,
  effect,
  input,
  signal,
  untracked,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { TownArtComponent } from "./town-art.component";
import type { LivingTownController, TownState } from "./living-town-controller";
import {
  listingQuote,
  listingReviewMatches,
  productDemandText,
  historyLabel,
  nativeFeeText,
  historyGoldAmount,
} from "./living-town-sales-ui";
import type {
  ListingReview,
  TownListing,
  TownHistoryEntry,
} from "./living-town-sales-ui";
import { townTransactionUrl } from "./living-town-port";

@Component({
  selector: "app-town-sales",
  imports: [DatePipe, TownArtComponent],
  templateUrl: "./living-town-sales.component.html",
  styleUrl: "./living-town-sales.component.css",
})
export class LivingTownSalesComponent {
  readonly state = input.required<TownState>();
  readonly controller = input.required<LivingTownController>();
  readonly mode = input<"listings" | "history">("listings");
  readonly explorer = input("");
  readonly elapsedMs = input(0);
  readonly canEdit = input(false);
  readonly canCancel = input(false);
  protected readonly product = signal("health_potion");
  protected readonly quantity = signal("1");
  protected readonly price = signal("18");
  protected readonly review = signal<ListingReview | null>(null);
  protected readonly cancellation = signal<TownListing | null>(null);
  protected readonly products = [
    { id: "health_potion", name: "Health potions" },
    { id: "iron_tool", name: "Iron tools" },
  ];
  protected readonly quote = computed(() =>
    listingQuote(
      this.state().observation,
      this.product(),
      this.quantity(),
      this.price(),
    ),
  );
  protected readonly reviewCurrent = computed(() => {
    const r = this.review();
    return !!r && listingReviewMatches(r, this.state().observation);
  });
  protected readonly cancelCurrent = computed(() => {
    const r = this.cancellation();
    return (
      !!r &&
      this.state().observation?.ownListings?.some(
        (l) =>
          l.listing_id === r.listing_id &&
          l.active &&
          l.revision === r.revision,
      ) === true
    );
  });
  protected readonly comparables = computed(() =>
    (this.state().market?.items ?? [])
      .filter(
        (l) =>
          l.active && l.owner.kind === "player" && l.item_id === this.product(),
      )
      .sort((a, b) =>
        BigInt(a.unit_price) < BigInt(b.unit_price)
          ? -1
          : BigInt(a.unit_price) > BigInt(b.unit_price)
            ? 1
            : BigInt(a.shop_id) < BigInt(b.shop_id)
              ? -1
              : 1,
      ),
  );
  protected readonly demandText = productDemandText;
  protected readonly label = historyLabel;
  protected readonly nativeFee = nativeFeeText;
  protected readonly amount = historyGoldAmount;
  constructor() {
    let scope = "";
    effect(() => {
      const state = this.state(),
        key = `${state.accountId}:${state.observation?.shop?.shop_id}:${this.mode()}`;
      if (key === scope) return;
      scope = key;
      untracked(() => {
        this.review.set(null);
        this.cancellation.set(null);
        this.quantity.set("1");
        this.price.set("18");
        this.product.set("health_potion");
        if (this.mode() === "listings") void this.controller().loadMarket();
        else void this.controller().loadHistory();
      });
    });
  }
  protected old(page: { stale: boolean; receivedAt: number }): boolean {
    this.elapsedMs();
    return (
      page.stale ||
      Date.now() < page.receivedAt ||
      Date.now() - page.receivedAt > 30000
    );
  }
  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  protected name(item: string): string {
    return item === "health_potion" ? "Health potions" : "Iron tools";
  }
  protected owned(item: string): TownListing | null {
    return (
      this.state().observation?.ownListings?.find((l) => l.item_id === item) ??
      null
    );
  }
  protected stock(
    item: string,
    field: "held" | "available" | "listing_reserved",
  ): string {
    return (
      this.state().observation?.ledger?.inventory[field][
        item as "health_potion" | "iron_tool"
      ] ?? "Unavailable"
    );
  }
  protected edit(item: string): void {
    const current = this.owned(item);
    this.product.set(item);
    this.quantity.set(current?.active ? current.remaining_quantity : "1");
    this.price.set(
      current?.unit_price ?? (item === "health_potion" ? "18" : "24"),
    );
    this.review.set(null);
    this.cancellation.set(null);
  }
  protected reviewListing(): void {
    const q = this.quote();
    if (this.canEdit() && q.review && !q.reason) {
      this.review.set(q.review);
      this.cancellation.set(null);
    }
  }
  protected saveListing(): void {
    const r = this.review();
    if (!r || !this.canEdit() || !this.reviewCurrent()) return;
    this.review.set(null);
    void this.controller().act("set_listing", {
      shop_id: r.shopId,
      item_id: r.itemId,
      quantity: r.quantity,
      unit_price: r.price,
      expected_listing_revision: r.revision,
    });
  }
  protected reviewCancellation(listing: TownListing): void {
    if (this.canCancel() && listing.active) {
      this.cancellation.set({ ...listing });
      this.review.set(null);
    }
  }
  protected cancelListing(): void {
    const r = this.cancellation();
    if (!r || !this.canCancel() || !this.cancelCurrent()) return;
    this.cancellation.set(null);
    void this.controller().act("cancel_listing", {
      listing_id: r.listing_id,
      expected_listing_revision: r.revision,
    });
  }
  protected url(row: TownHistoryEntry): string | null {
    return this.explorer()
      ? townTransactionUrl(this.explorer(), row.transaction_hash)
      : null;
  }
  protected cost(row: TownHistoryEntry): string {
    if (row.kind === "player_grant" || row.kind === "upgrade_purchase")
      return "Not applicable";
    if (row.kind === "material_purchase")
      return `${row.gold_amount} acquisition cost`;
    const value =
      row.kind === "production_started" || row.kind === "production_completed"
        ? row.production_cost
        : row.cogs;
    return value === null ? "Unknown" : `${value} gold`;
  }
}
