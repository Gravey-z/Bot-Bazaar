export const townLocations = [
  {
    id: "rex",
    label: "Rex · Crystals",
    x: 977,
    y: 397,
    width: 268,
    height: 190,
  },
  {
    id: "luna",
    label: "Luna · Herbs",
    x: 650,
    y: 390,
    width: 202,
    height: 190,
  },
  {
    id: "bolt",
    label: "Bolt · Wood & iron",
    x: 377,
    y: 397,
    width: 235,
    height: 230,
  },
  {
    id: "notice",
    label: "Town notice",
    x: 590,
    y: 577,
    width: 180,
    height: 100,
  },
  { id: "shop", label: "Your shop", x: 161, y: 592, width: 178, height: 115 },
  {
    id: "production",
    label: "Workbench",
    x: 400,
    y: 634,
    width: 168,
    height: 58,
  },
  {
    id: "listings",
    label: "Your shelves",
    x: 1033,
    y: 625,
    width: 190,
    height: 70,
  },
] as const;
export type TownLocation = (typeof townLocations)[number]["id"];
/** One transform for artwork and hotspots: fill the viewport without stretching. */
export function townCoverTransform(
  width: number,
  height: number,
): { x: number; y: number; scale: number } {
  const scale = Math.max(Math.max(width, 1) / 1280, Math.max(height, 1) / 720);
  return {
    scale,
    x: (width - 1280 * scale) / 2,
    y: (height - 720 * scale) / 2,
  };
}
export interface TownVisualSnapshot {
  selected: TownLocation | null;
  blocked: boolean;
  shopLabel: string;
}
/** Navigation only: no controller, balances, transaction parameters or polling. */
export class TownGameBridge {
  private snapshot: TownVisualSnapshot = {
    selected: null,
    blocked: false,
    shopLabel: "Your shop",
  };
  private listeners = new Set<(value: Readonly<TownVisualSnapshot>) => void>();
  private disposed = false;
  constructor(private readonly select: (location: TownLocation) => void) {}
  update(value: TownVisualSnapshot): void {
    if (this.disposed) return;
    this.snapshot = { ...value };
    for (const listener of this.listeners) listener({ ...this.snapshot });
  }
  subscribe(
    listener: (value: Readonly<TownVisualSnapshot>) => void,
  ): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener({ ...this.snapshot });
    return () => this.listeners.delete(listener);
  }
  choose(location: unknown): void {
    if (
      !this.disposed &&
      !this.snapshot.blocked &&
      townLocations.some((l) => l.id === location)
    )
      this.select(location as TownLocation);
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
