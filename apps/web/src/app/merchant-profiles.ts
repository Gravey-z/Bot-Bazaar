import { merchantNames } from "@bot-bazaar/shared";

// Presentation only. Spending authority stays in the independently enforced worker policy.
export const merchantProfiles = [
  {
    id: "rex",
    name: merchantNames.rex,
    portrait: "art/rex.png",
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
    portrait: "art/luna.png",
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
    portrait: "art/bolt.png",
    role: "The bargain hunter",
    description:
      "Keeps an eye on wood and iron deals. Happy to wait when the price or reserves aren’t right.",
    specialty: "Wood & iron",
    color: "peach",
    goal: "Look for discounted wood and iron. Keep reserves intact when a deal is not worthwhile.",
  },
] as const;

export const marketResources = [
  {
    id: "crystal",
    name: "Crystals",
    icon: "art/resources.png",
    color: "crystal",
  },
  { id: "wood", name: "Wood", icon: "art/resources.png", color: "wood" },
  { id: "herb", name: "Herbs", icon: "art/resources.png", color: "herb" },
  { id: "iron", name: "Iron", icon: "art/resources.png", color: "iron" },
] as const;
