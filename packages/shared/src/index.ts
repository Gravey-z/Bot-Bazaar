export const merchantNames = {
  rex: "Rex",
  luna: "Luna",
  bolt: "Bolt",
} as const;

export type MerchantId = keyof typeof merchantNames;

export const resourceIds = ["crystal", "wood", "herb", "iron"] as const;

export type Resource = (typeof resourceIds)[number];
