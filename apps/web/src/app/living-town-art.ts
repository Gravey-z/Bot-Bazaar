import { itemSymbol } from "./living-town-production-ui";
export const townArtwork = {
  storefront: { file: "storefront.svg", fallback: "⌂", width: 80, height: 64 },
  health_potion: {
    file: "health-potion.svg",
    fallback: "⚗",
    width: 32,
    height: 32,
  },
  iron_tool: { file: "iron-tool.svg", fallback: "⚒", width: 32, height: 32 },
  workbench: { file: "workbench.svg", fallback: "▰", width: 48, height: 32 },
  progress: { file: "progress.svg", fallback: "◷", width: 24, height: 24 },
  upgrade: { file: "upgrade.svg", fallback: "Ⅱ", width: 24, height: 24 },
  customer: { file: "customer.svg", fallback: "♟", width: 24, height: 24 },
  assistant: { file: "assistant.svg", fallback: "✦", width: 24, height: 24 },
} as const;
export interface TownArtwork {
  id: string;
  src: string;
  fallback: string;
  width: number;
  height: number;
}
/** Only fixed local assets can become image URLs. Item names are never URL paths. */
export function townArt(kind: string): TownArtwork | null {
  if (!Object.hasOwn(townArtwork, kind)) return null;
  const art = townArtwork[kind as keyof typeof townArtwork];
  return {
    id: kind,
    src: `art/living-town/${art.file}`,
    fallback: art.fallback,
    width: art.width,
    height: art.height,
  };
}
export function townArtFallback(kind: string): string {
  return (
    townArt(kind)?.fallback ??
    (["crystal", "wood", "herb", "iron"].includes(kind)
      ? itemSymbol(kind)
      : "◇")
  );
}
