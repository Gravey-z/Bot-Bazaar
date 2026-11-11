import { Component, input, output } from "@angular/core";
import { DatePipe } from "@angular/common";
import type { GuestActivityEntry } from "@bot-bazaar/chain";
import type { GuestUiState } from "./guest-town-port";
import type { TownState } from "./living-town-controller";
import type { TownManagerTab } from "./living-town-layout";
import { townTransactionUrl } from "./living-town-port";

@Component({
  selector: "app-guest-activity",
  imports: [DatePipe],
  template: `
    <section class="guest-history" aria-label="Your activity">
      <header>
        <h2>Your activity</h2>
        <button type="button" [disabled]="guest().activityLoading" (click)="refresh.emit()">
          {{ guest().activityLoading ? 'Updating…' : 'Refresh' }}
        </button>
      </header>
      @if (guest().activityError) { <p class="muted" role="status">{{ guest().activityError }}</p> }
      @if (guest().activity; as page) {
        <ol class="entries" aria-live="polite">
          @for (entry of page.items; track entry.requestId) {
            <li>
              <div class="entry-heading">
                <strong>{{ entry.title }}</strong>
                <time [attr.datetime]="timestamp(entry) | date:'yyyy-MM-ddTHH:mm:ss'">
                  {{ timestamp(entry) | date:'dd MMM, HH:mm' }}
                </time>
              </div>
              <div class="entry-detail">
                <span class="description">
                  @if (entry.itemId) {
                    @if (entry.quantity) { {{ entry.quantity }} }
                    {{ name(entry.itemId) }}
                    @if (entry.merchantId) { · {{ merchantName(entry.merchantId) }} }
                  }
                  <span class="status" [class.failed]="entry.status === 'failed'">
                    {{ entry.status === 'confirmed' ? 'Confirmed' : entry.status === 'failed' ? 'Failed' : 'Waiting for confirmation' }}
                  </span>
                </span>
                @if (link(entry.transactionHash); as url) {
                  <a [href]="url" target="_blank" rel="noopener noreferrer" aria-label="View transaction">tx ↗</a>
                }
              </div>
            </li>
          } @empty { <li class="muted">Your purchases, crafting and shop updates will appear here.</li> }
        </ol>
        @if (page.nextBefore) {
          <button type="button" [disabled]="guest().activityLoading" (click)="more.emit()">Load older activity</button>
        }
      } @else {
        <p class="muted" role="status">{{ guest().activityLoading ? 'Loading your activity…' : 'Activity is temporarily unavailable.' }}</p>
      }
    </section>
  `,
  styles: [`
    :host{display:block}.guest-history{margin:1rem 0;padding:1rem 0;border-bottom:1px solid #d0bb91;color:#4f3522}
    header,.entry-heading,.entry-detail{display:flex;justify-content:space-between;gap:1rem;align-items:baseline}
    header{align-items:center;flex-wrap:wrap}h2{margin:0;font-size:1rem}
    .entries{list-style:none;padding:0;margin:.6rem 0}.entries li{padding:.75rem 0;border-bottom:1px solid #dfc9a5}.entries li:last-child{border:0}
    .entry-heading strong{font-size:.85rem}.entry-heading time{flex:none;color:#887b6b;font-size:.7rem}
    .entry-detail{margin-top:.3rem;gap:.75rem;font-size:.8rem}.description{min-width:0;overflow-wrap:anywhere}
    .status{display:inline-block;margin-left:.5rem;color:#887b6b;font-size:.7rem}.status.failed{color:#9b4932}
    a{flex:none;color:#714322;text-decoration:none;font-size:.75rem;white-space:nowrap}a:hover{text-decoration:underline}
    button{cursor:pointer;border:1px solid #b69a68;background:transparent;color:inherit;border-radius:.3rem;padding:.35rem .6rem;font:inherit;font-size:.75rem}
    button:disabled{cursor:default;opacity:.6}.muted{color:#887b6b;font-size:.8rem;line-height:1.5}
    a:focus-visible,button:focus-visible{outline:2px solid #96632e;outline-offset:3px}
    @media(max-width:480px){.entry-heading{flex-wrap:wrap;gap:.25rem}}
  `],
})
export class GuestActivityComponent {
  readonly guest = input.required<GuestUiState>();
  readonly town = input.required<TownState>();
  readonly explorer = input.required<string>();
  readonly refresh = output<void>();
  readonly more = output<void>();
  readonly openMerchant = output<"rex" | "luna" | "bolt">();
  readonly openManager = output<TownManagerTab>();
  protected name(item: string): string { return item.replaceAll("_", " "); }
  protected merchantName(id: string): string { return id[0]!.toUpperCase() + id.slice(1); }
  protected timestamp(entry: GuestActivityEntry): number { return Number(entry.createdAtMs); }
  protected link(hash: string | null): string | null { return hash ? townTransactionUrl(this.explorer(), hash) : null; }
}
