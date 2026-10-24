import { merchantNames, resourceIds } from "@bot-bazaar/shared";
import type { MerchantId, Resource } from "@bot-bazaar/shared";

export interface ListingActionArgs {
  merchant_id: MerchantId;
  resource: Resource;
  unit_price: string;
  quantity: string;
  active: boolean;
  expected_version: string;
  action_id: string;
}

export function canonicalListingAction(args: ListingActionArgs): string {
  const keys = [
    "action_id",
    "active",
    "expected_version",
    "merchant_id",
    "quantity",
    "resource",
    "unit_price",
  ];
  if (
    Object.keys(args).length !== keys.length ||
    !Object.keys(args).every((key) => keys.includes(key)) ||
    !Object.hasOwn(merchantNames, args.merchant_id) ||
    !resourceIds.includes(args.resource) ||
    typeof args.active !== "boolean"
  ) {
    throw new Error("Invalid listing action arguments");
  }
  for (const value of [
    args.unit_price,
    args.quantity,
    args.expected_version,
    args.action_id,
  ]) {
    if (
      typeof value !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      BigInt(value) > 18446744073709551615n
    ) {
      throw new Error("Listing action numbers must be canonical u64 strings");
    }
  }
  return JSON.stringify({
    args: {
      action_id: args.action_id,
      active: args.active,
      expected_version: args.expected_version,
      merchant_id: args.merchant_id,
      quantity: args.quantity,
      resource: args.resource,
      unit_price: args.unit_price,
    },
    method: "set_listing",
  });
}

export async function listingActionDigest(
  args: ListingActionArgs,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalListingAction(args));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
