import { merchantNames, resourceIds } from "@bot-bazaar/shared";
import type { MerchantId, Resource } from "@bot-bazaar/shared";
import { canonicalListingAction } from "./listing-action.js";
import type { ListingActionArgs } from "./listing-action.js";

export interface ProposalActionArgs {
  proposer: MerchantId;
  buyer: MerchantId;
  seller: MerchantId;
  resource: Resource;
  quantity: string;
  total_price: string;
  expires_at_ns: string;
  action_id: string;
}

export interface OfferActionArgs {
  offer_id: string;
  action_id: string;
}

export type MerchantAction =
  | { method: "set_listing"; args: ListingActionArgs }
  | { method: "propose_trade"; args: ProposalActionArgs }
  | { method: "accept_trade" | "cancel_trade"; args: OfferActionArgs };

export function canonicalMerchantAction(action: MerchantAction): string {
  if (action.method === "set_listing") {
    return canonicalListingAction(action.args);
  }
  if (
    !["propose_trade", "accept_trade", "cancel_trade"].includes(action.method)
  ) {
    throw new Error("Invalid merchant action method");
  }
  const fields = action.args as unknown as Record<string, unknown>;
  const proposal = action.method === "propose_trade";
  const keys = proposal
    ? [
        "action_id",
        "buyer",
        "expires_at_ns",
        "proposer",
        "quantity",
        "resource",
        "seller",
        "total_price",
      ]
    : ["action_id", "offer_id"];
  if (
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    Object.keys(fields).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(fields, key))
  ) {
    throw new Error("Invalid merchant action arguments");
  }
  if (
    proposal &&
    (![fields.proposer, fields.buyer, fields.seller].every(
      (merchant) =>
        typeof merchant === "string" && Object.hasOwn(merchantNames, merchant),
    ) ||
      typeof fields.resource !== "string" ||
      !resourceIds.includes(fields.resource as Resource))
  ) {
    throw new Error("Invalid merchant action identity");
  }
  const numbers = proposal
    ? ["action_id", "expires_at_ns", "quantity", "total_price"]
    : keys;
  for (const key of numbers) {
    const value = fields[key];
    if (
      typeof value !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      BigInt(value) > 18446744073709551615n
    ) {
      throw new Error("Merchant action numbers must be canonical u64 strings");
    }
  }
  return JSON.stringify({
    args: Object.fromEntries(keys.map((key) => [key, fields[key]])),
    method: action.method,
  });
}

export async function merchantActionDigest(
  action: MerchantAction,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalMerchantAction(action));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
