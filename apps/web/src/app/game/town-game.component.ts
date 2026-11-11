import {
  Component,
  ElementRef,
  NgZone,
  ViewChild,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { AfterViewInit, OnDestroy } from "@angular/core";
import { TownGameBridge } from "./town-game.bridge";
import type { TownLocation, TownVisualSnapshot } from "./town-game.bridge";
import type { TownRendererStatus } from "./town-game.runtime";

@Component({
  selector: "app-town-game",
  templateUrl: "./town-game.component.html",
  styleUrl: "./town-game.component.css",
})
export class TownGameComponent implements AfterViewInit, OnDestroy {
  readonly snapshot = input.required<TownVisualSnapshot>();
  readonly selection = output<TownLocation>();
  protected readonly status = signal<TownRendererStatus>({
    kind: "loading",
    progress: 0,
  });
  @ViewChild("canvasHost", { static: true })
  private canvasHost!: ElementRef<HTMLDivElement>;
  private readonly zone = inject(NgZone);
  private readonly bridge = new TownGameBridge((location) =>
    this.zone.run(() => this.selection.emit(location)),
  );
  private instance: { destroy: () => void } | undefined;
  private generation = 0;
  private destroyed = false;
  constructor() {
    effect(() => this.bridge.update(this.snapshot()));
  }
  ngAfterViewInit(): void {
    void this.boot();
  }
  protected async boot(): Promise<void> {
    const generation = ++this.generation;
    this.instance?.destroy();
    this.instance = undefined;
    this.status.set({ kind: "loading", progress: 0 });
    try {
      const { startTownGame } = await import("./town-game.runtime");
      if (this.destroyed || generation !== this.generation) return;
      this.zone.runOutsideAngular(() => {
        this.instance = startTownGame(
          this.canvasHost.nativeElement,
          this.bridge,
          (status) => {
            if (!this.destroyed && generation === this.generation)
              this.zone.run(() => this.status.set(status));
          },
        );
      });
    } catch {
      if (!this.destroyed && generation === this.generation)
        this.status.set({ kind: "fallback" });
    }
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.generation++;
    this.instance?.destroy();
    this.bridge.dispose();
  }
}
