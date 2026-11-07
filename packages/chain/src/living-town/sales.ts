import {
  array,
  boolean,
  bounded,
  check,
  choice,
  hash32,
  nullable,
  object,
  parseU64,
  positiveU64,
} from "../wire.js";
import {
  livingTownItem,
  livingTownListing,
  parseLivingTownU128,
} from "./wire.js";

const signedCost = (v: unknown): string => {
  check(
    typeof v === "string" && /^-?(0|[1-9][0-9]*)$/.test(v) && v !== "-0",
    "invalid signed cost",
  );
  parseLivingTownU128(v.startsWith("-") ? v.slice(1) : v);
  return v;
};
const cursor = (v: unknown): string => {
  check(
    typeof v === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(v),
    "invalid sales cursor",
  );
  return v;
};
const historyShape = object({
  event_sequence: positiveU64,
  kind: choice([
    "material_purchase",
    "upgrade_purchase",
    "material_sale",
    "customer_sale",
    "player_grant",
    "production_started",
    "production_completed",
  ] as const),
  item_id: nullable(livingTownItem),
  quantity: nullable(bounded(1n, 1000n)),
  gold_amount: parseLivingTownU128,
  cogs: nullable(parseLivingTownU128),
  profit: nullable(signedCost),
  production_cost: nullable(parseLivingTownU128),
  cost_status: choice(["known", "unknown", "not_applicable"] as const),
  transaction_hash: hash32,
  receipt_id: hash32,
  log_index: parseU64,
  block_hash: hash32,
  block_height: positiveU64,
  block_timestamp_ns: parseU64,
  proof_available: boolean,
});
export function livingTownHistoryEntry(
  value: unknown,
): ReturnType<typeof historyShape> {
  const r = historyShape(value);
  if (r.kind === "player_grant" || r.kind === "upgrade_purchase")
    check(
      r.item_id === null &&
        r.quantity === null &&
        r.cost_status === "not_applicable" &&
        r.cogs === null &&
        r.profit === null &&
        r.production_cost === null,
      "grant is not trading revenue/profit",
    );
  else
    check(
      r.item_id !== null && r.quantity !== null,
      "history item/quantity required",
    );
  if (r.kind === "upgrade_purchase")
    check(r.gold_amount === "150", "upgrade sink mismatch");
  if (r.kind === "material_purchase")
    check(
      r.cost_status === "known" &&
        r.cogs === null &&
        r.profit === null &&
        r.production_cost === null,
      "acquisition cost is not realized profit",
    );
  if (r.kind === "customer_sale" || r.kind === "material_sale") {
    check(
      r.cost_status === "known"
        ? r.cogs !== null &&
            r.profit !== null &&
            BigInt(r.profit) === BigInt(r.gold_amount) - BigInt(r.cogs)
        : r.cost_status === "unknown" && r.cogs === null && r.profit === null,
      "sale cost/profit mismatch",
    );
  }
  if (r.kind === "production_started" || r.kind === "production_completed")
    check(
      r.cost_status !== "not_applicable" &&
        r.gold_amount === "0" &&
        r.cogs === null &&
        r.profit === null &&
        (r.cost_status === "known") === (r.production_cost !== null),
      "production cost mismatch",
    );
  return r;
}
const costSummary = object({
  recorded_grants: parseLivingTownU128,
  recorded_material_spending: parseLivingTownU128,
  recorded_sales_revenue: parseLivingTownU128,
  recorded_upgrade_spending: parseLivingTownU128,
  recorded_cogs: nullable(parseLivingTownU128),
  recorded_profit: nullable(signedCost),
  recorded_cash_change: signedCost,
  unsold_inventory_cost: nullable(parseLivingTownU128),
  work_in_progress_cost: nullable(parseLivingTownU128),
  recorded_native_fees_yocto: nullable(parseLivingTownU128),
  native_fee_history_complete: boolean,
  cost_history_complete: boolean,
  through_event_sequence: parseU64,
  gap_from_sequence: nullable(positiveU64),
});
export function livingTownCostSummary(
  value: unknown,
): ReturnType<typeof costSummary> {
  const r = costSummary(value);
  check(
    BigInt(r.recorded_cash_change) ===
      BigInt(r.recorded_grants) +
        BigInt(r.recorded_sales_revenue) -
        BigInt(r.recorded_material_spending) -
        BigInt(r.recorded_upgrade_spending),
    "recorded cash flow mismatch",
  );
  check(
    r.native_fee_history_complete === (r.recorded_native_fees_yocto !== null),
    "unknown native fee history must remain unknown",
  );
  check(
    r.cost_history_complete ||
      (r.unsold_inventory_cost === null && r.work_in_progress_cost === null),
    "incomplete inventory costs must remain unknown",
  );
  check(
    r.cost_history_complete
      ? r.gap_from_sequence === null
      : r.gap_from_sequence !== null &&
          r.recorded_cogs === null &&
          r.recorded_profit === null,
    "incomplete cost history must remain unknown",
  );
  check(
    (r.recorded_cogs === null) === (r.recorded_profit === null) &&
      (r.recorded_cogs === null ||
        BigInt(r.recorded_profit!) ===
          BigInt(r.recorded_sales_revenue) - BigInt(r.recorded_cogs)),
    "summary cost/profit mismatch",
  );
  return r;
}
export const livingTownSalesHistoryRead = object({
  shop_id: positiveU64,
  items: array(livingTownHistoryEntry, 50),
  next_cursor: nullable(cursor),
  has_more: boolean,
  costs: livingTownCostSummary,
});
export const livingTownMarketListingsRead = object({
  items: array(livingTownListing, 50),
  next_cursor: nullable(cursor),
  has_more: boolean,
});
