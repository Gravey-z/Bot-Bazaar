import { object, choice, nullable, accountId, hash32, parseU64, positiveU64, boolean, bounded, array, check } from "../wire.js";
import { livingTownSix } from "./wire.js";

const product = object({ started: boolean, claimed: boolean, listed: boolean });
export const guestEconomyProgress = object({
  merchantPurchases: object({ rex: bounded(0n, 100n), luna: bounded(0n, 100n), bolt: bounded(0n, 100n) }),
  products: object({ health_potion: product, iron_tool: product }),
});
const text = (v: unknown): string => { check(typeof v === "string" && v.length <= 200, "guest activity text invalid"); return v; };
const uuid = (v: unknown): string => { check(typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v), "guest request ID invalid"); return v; };
export const guestActivityEntry = object({
  cursor: positiveU64, requestId: uuid, accountId,
  action: choice(["register_player", "create_shop", "rename_shop", "buy_item", "start_production", "complete_production", "set_listing", "cancel_listing", "purchase_upgrade"] as const),
  title: text, merchantId: nullable(choice(["rex", "luna", "bolt"] as const)),
  itemId: nullable(choice(["crystal", "wood", "herb", "iron", "health_potion", "iron_tool"] as const)),
  quantity: nullable(parseU64), status: choice(["pending", "confirmed", "failed"] as const),
  stage: choice(["queued", "signed", "unknown", "confirmed", "failed"] as const),
  verified: boolean, transactionHash: nullable(hash32), blockHeight: nullable(positiveU64),
  goldAfter: nullable(parseU64), inventoryAfter: nullable(livingTownSix(parseU64)),
  published: boolean, failureReason: nullable(text), createdAtMs: positiveU64,
});
export const guestActivityPage = object({
  accountId, items: array(guestActivityEntry, 10), nextBefore: nullable(positiveU64),
  progress: guestEconomyProgress, provisioningTransactionHash: nullable(hash32), observedAtMs: positiveU64,
});
export type GuestActivityEntry = ReturnType<typeof guestActivityEntry>;
export type GuestActivityPage = ReturnType<typeof guestActivityPage>;
