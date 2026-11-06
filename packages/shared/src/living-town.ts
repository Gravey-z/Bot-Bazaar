// V2 is deliberately separate from Resource and every V1 deployment/journal DTO.
export const livingTownItemIds = [
  "crystal",
  "wood",
  "herb",
  "iron",
  "health_potion",
  "iron_tool",
] as const;
export type LivingTownItem = (typeof livingTownItemIds)[number];
export const livingTownFoundationMethods = [
  "initialize_town",
  "get_foundation",
  "get_town",
  "register_player",
  "create_shop",
  "rename_shop",
  "get_player",
  "get_shop",
  "get_player_shops",
  "get_command",
  "buy_from_merchant",
  "get_listings",
  "get_trade",
  "get_shop_inventory",
  "get_recipes",
  "start_production",
  "get_production_jobs",
  "complete_production",
  "set_listing",
  "cancel_listing",
  "get_source_state",
  "get_market_events",
  "schedule_market_event",
  "allocate_raw_supply",
  "sweep_merchant_treasury",
  "fund_customer_budget",
  "settle_customer_purchase",
] as const;
export const livingTownRecipeIds = ["health_potion", "iron_tool"] as const;
export type LivingTownRecipeId = (typeof livingTownRecipeIds)[number];
export type LivingTownSix<T> = { readonly [K in LivingTownItem]: T };
export const livingTownVersions = Object.freeze({
  api_version: "2.0.0",
  state_schema: "1",
  command_schema: "1",
  config_version: "1",
} as const);
export interface LivingTownDeployment {
  readonly network_id: "testnet";
  readonly genesis_hash: string;
  readonly contract_id: string;
  readonly api_version: "2.0.0";
  readonly state_schema: "1";
  readonly command_schema: "1";
  readonly config_version: "1";
  readonly config_sha256: string;
}
export interface LivingTownInventory {
  readonly held: LivingTownSix<string>;
  readonly available: LivingTownSix<string>;
  readonly listing_reserved: LivingTownSix<string>;
  readonly trade_reserved: LivingTownSix<string>;
  readonly production_output_reserved: LivingTownSix<string>;
  readonly trade_inbound_reserved: LivingTownSix<string>;
}
