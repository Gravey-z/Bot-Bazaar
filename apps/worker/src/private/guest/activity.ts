import { canonicalLivingTownJson, guestActionRequest, guestActionMethod, playerReceiptProof,
  guestActivityEntry, livingTownLedger, guestEconomyProgress } from "@bot-bazaar/chain";
import type { GuestConfig } from "./config.js";
import type { GuestActionRow, GuestRow } from "./store.js";

type Row = GuestActionRow & { cursor: string | number; created: number };
type Json = Record<string, unknown>;
const record = (v: unknown): Json | null => v && typeof v === "object" && !Array.isArray(v) ? v as Json : null;
export function guestActivity(row: Row, guest: GuestRow, config: GuestConfig) {
  const request = guestActionRequest(JSON.parse(row.request_json)), p = request.parameters;
  let verified = false, blockHeight: string | null = null, goldAfter: string | null = null;
  let inventoryAfter: ReturnType<typeof livingTownLedger>["inventory"]["held"] | null = null;
  let outcome: Json | null = null;
  try {
    const proof = playerReceiptProof(JSON.parse(row.proof_json!));
    const status = record(JSON.parse(row.result_json!));
    const expected = row.status === "confirmed" ? "succeeded" : row.status === "failed" ? "failed" : null;
    const terms: Record<string, unknown> = { ...proof.call.args }; delete terms["command"];
    verified = !!expected && status?.["kind"] === expected && status["transactionHash"] === row.tx_hash &&
      proof.transactionHash === row.tx_hash && proof.signerId === guest.account_id &&
      canonicalLivingTownJson(proof.deployment) === canonicalLivingTownJson(config.profile.identity.deployment) &&
      proof.call.method === guestActionMethod(request.action) && canonicalLivingTownJson(terms) === canonicalLivingTownJson(p);
    if (verified) {
      blockHeight = String(record(status?.["block"])?.["height"]);
      outcome = record(record(record(status?.["result"])?.["data"])?.["outcome"]);
      if (status?.["kind"] === "succeeded" && outcome) {
        try {
          const ledger = livingTownLedger(outcome["buyer"] ?? outcome["ledger"] ?? record(outcome["player"])?.["ledger"]);
          if (ledger.actor.kind === "player" && ledger.actor.account_id === guest.account_id) {
            goldAfter = ledger.gold.available; inventoryAfter = ledger.inventory.held;
          }
        } catch { /* Shop-only effects do not carry a post-action inventory. */ }
      }
    }
  } catch { /* A record lacking verified evidence cannot become a confirmed receipt. */ }
  const names: Record<string, string> = { register_player: "Register guest player", create_shop: "Create your shop",
    rename_shop: "Rename your shop", buy_item: "Buy materials", start_production: "Start production",
    complete_production: "Claim completed production", set_listing: "List products for sale",
    cancel_listing: "Cancel your listing", purchase_upgrade: "Upgrade your shop" };
  const merchantId = request.action === "buy_item" ? p["merchant_id"] : null;
  const job = record(outcome?.["job"]);
  const itemId = p["item_id"] ?? p["recipe_id"] ?? job?.["output_item"] ?? null;
  const failedBeforeSubmission = row.status === "failed" && row.tx_hash === null;
  const registrationExpired = row.status === "failed" && request.action === "register_player" && row.error_code === "guest_registration_expired";
  const status = verified ? row.status === "confirmed" ? "confirmed" : "failed" : failedBeforeSubmission || registrationExpired ? "failed" : "pending";
  return guestActivityEntry({ cursor: String(row.cursor), requestId: row.request_id, accountId: guest.account_id,
    action: request.action, title: names[request.action], merchantId, itemId, quantity: p["quantity"] ?? job?.["output_quantity"] ?? null,
    status, stage: row.status, verified, transactionHash: row.tx_hash, blockHeight,
    goldAfter, inventoryAfter, published: !!row.published,
    failureReason: status === "failed" ? verified ? "The original transaction failed on chain."
      : registrationExpired ? "The registration deadline passed without applying the command. Guest setup can prepare a fresh registration."
      : row.error_code === "guest_review_expired" ? "The review expired before signing. No transaction was sent."
      : "The action could not be submitted. Refresh and review the current terms." : null,
    createdAtMs: String(row.created) });
}
export function guestProgress(rows: ReturnType<typeof guestActivity>[]) {
  const merchantPurchases = { rex: "0", luna: "0", bolt: "0" };
  const products = { health_potion: { started: false, claimed: false, listed: false }, iron_tool: { started: false, claimed: false, listed: false } };
  for (const row of rows) {
    if (!row.verified || row.status !== "confirmed") continue;
    if (row.action === "buy_item" && row.merchantId) merchantPurchases[row.merchantId] = String(Number(merchantPurchases[row.merchantId]) + 1);
    if (row.itemId === "health_potion" || row.itemId === "iron_tool") {
      if (row.action === "start_production") products[row.itemId].started = true;
      if (row.action === "complete_production") products[row.itemId].claimed = true;
      if (row.action === "set_listing" && BigInt(row.quantity ?? "0") > 0n) products[row.itemId].listed = true;
    }
  }
  return guestEconomyProgress({ merchantPurchases, products });
}
