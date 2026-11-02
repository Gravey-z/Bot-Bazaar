import { merchantNames } from "@bot-bazaar/shared";

// Presentation only. Spending authority stays in the independently enforced worker policy.
export const merchantProfiles = [
  {
    id: "rex",
    name: merchantNames.rex,
    initial: "R",
    role: "The crystal restocker",
    description:
      "Quick to spot a crystal shortage. Looks to replenish stock while keeping gold in reserve.",
    specialty: "Crystals",
    color: "sage",
    goal: "Replenish crystals when stock runs low, without spending his gold reserve.",
  },
  {
    id: "luna",
    name: merchantNames.luna,
    initial: "L",
    role: "The careful supplier",
    description:
      "A measured trader. Supplies crystals and protects the resources she needs to keep her stall running.",
    specialty: "Crystals & herbs",
    color: "lavender",
    goal: "Supply worthwhile crystal trades, protect stock floors and replenish herbs only when low.",
  },
  {
    id: "bolt",
    name: merchantNames.bolt,
    initial: "B",
    role: "The bargain hunter",
    description:
      "Keeps an eye on wood and iron deals. Happy to wait when the price or reserves aren’t right.",
    specialty: "Wood & iron",
    color: "peach",
    goal: "Look for discounted wood and iron. Keep reserves intact when a deal is not worthwhile.",
  },
] as const;

export const marketResources = [
  { id: "crystal", name: "Crystals", icon: "◆", color: "crystal" },
  { id: "wood", name: "Wood", icon: "▰", color: "wood" },
  { id: "herb", name: "Herbs", icon: "✿", color: "herb" },
  { id: "iron", name: "Iron", icon: "⬡", color: "iron" },
] as const;
