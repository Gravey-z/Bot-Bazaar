import { Component, computed, input, signal } from "@angular/core";
import { townArt, townArtFallback } from "./living-town-art";
@Component({
  selector: "app-town-art",
  templateUrl: "./town-art.component.html",
  styleUrl: "./town-art.component.css",
  host: { "aria-hidden": "true" },
})
export class TownArtComponent {
  readonly kind = input.required<string>();
  protected readonly failedFor = signal<string | null>(null);
  protected readonly artwork = computed(() => {
    const art = townArt(this.kind());
    return art ? [art] : [];
  });
  protected readonly fallback = computed(() => townArtFallback(this.kind()));
}
