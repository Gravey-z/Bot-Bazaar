// Merchant policy v1: docs/merchant-policies.md and docs/economy.md.
// Shared parameters for prompt guidance and independent P3.9 enforcement.
export const profiles = {
  rex: {
    name: "Rex",
    personality:
      "Brisk, enthusiastic crystal restocker. Prioritize a crystal shortage without pretending future resale or profit is guaranteed.",
    goldFloor: "80",
    stockFloors: { crystal: "0", wood: "2", herb: "2", iron: "4" },
    stockTargets: { crystal: "7", wood: "4", herb: "2", iron: "10" },
    buys: {
      crystal: { below: "5", target: "7", price: ["4", "6"], maxQuantity: "4" },
    },
    sells: {
      crystal: ["4", "8"],
      wood: ["1", "4"],
      herb: ["4", "5"],
      iron: ["3", "7"],
    },
    maxSaleQuantity: "4",
  },
  luna: {
    name: "Luna",
    personality:
      "Measured, cautious supplier. Prefer worthwhile incoming sales while preserving stock. Buy herbs only when low; do not chase crystal purchases to participate.",
    goldFloor: "120",
    stockFloors: { crystal: "4", wood: "2", herb: "8", iron: "2" },
    stockTargets: { crystal: "12", wood: "3", herb: "20", iron: "2" },
    buys: {
      herb: { below: "12", target: "20", price: ["1", "2"], maxQuantity: "2" },
    },
    sells: {
      crystal: ["6", "8"],
      wood: ["3", "4"],
      herb: ["3", "5"],
      iron: ["6", "7"],
    },
    maxSaleQuantity: "4",
  },
  bolt: {
    name: "Bolt",
    personality:
      "Concise, price-conscious wood and iron bargain trader. Compare both eligible discounts; hold is normal. Never invent a buyer or spend on speculative resources.",
    goldFloor: "60",
    stockFloors: { crystal: "2", wood: "8", herb: "2", iron: "6" },
    stockTargets: { crystal: "2", wood: "18", herb: "4", iron: "12" },
    buys: {
      wood: { below: "18", target: "18", price: ["1", "1"], maxQuantity: "3" },
      iron: { below: "12", target: "12", price: ["1", "3"], maxQuantity: "3" },
    },
    sells: {
      crystal: ["7", "8"],
      wood: ["2", "3"],
      herb: ["2", "5"],
      iron: ["5", "6"],
    },
    maxSaleQuantity: "3",
  },
} as const;
