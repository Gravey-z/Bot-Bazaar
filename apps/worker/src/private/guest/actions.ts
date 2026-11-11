import { mkdir, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { actions, baseDecode, baseEncode, createTransaction, KeyPairSigner, PublicKey } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { LivingTownClient, createLivingTownCall, createLivingTownCompletionCall, guestActionRequest,
  guestActionMethod, playerReceiptProof, planLivingTownProduction, ChainRpcError } from "@bot-bazaar/chain";
import type { RpcTransport, GuestActionRequest, FinalizedLivingTownReader } from "@bot-bazaar/chain";
import { GuestError, GuestStore } from "./store.js";
import type { GuestActionRow, GuestRow } from "./store.js";
import type { GuestConfig } from "./config.js";
import { guestCheck } from "./config.js";
import { atomicRuntimeJson } from "../living-town/runtime-outbox.js";

type Call = ReturnType<typeof createLivingTownCall> | ReturnType<typeof createLivingTownCompletionCall>;
// NEP-642 buys receipt gas at >= 10^9 yocto/gas, even at a lower burn price.
// 30 Tgas fits the existing 0.05 NEAR grant and the reviewed receipt gas allowlist.
const guestGas = "30000000000000";
function isNotEnoughBalance(error: unknown): boolean {
  return error instanceof ChainRpcError &&
    error.code === "REJECTED" &&
    error.rpcCause === "INVALID_TRANSACTION" &&
    error.transactionReason === "NotEnoughBalance";
}
export class GuestActions {
  private readonly client: LivingTownClient;
  private stopped = false;
  constructor(private readonly config: GuestConfig, private readonly store: GuestStore, private readonly rpc: RpcTransport) {
    this.client = new LivingTownClient(config.profile.identity, rpc);
  }
  stop(): void { this.stopped = true; }
  async poll(): Promise<void> {
    if (this.stopped) return;
    await this.publish();
    {
      const guest = this.store.registrationGuest();
      if (guest) {
      const reader = await this.client.finalized();
      if ((await reader.getPlayer(guest.account_id)).data) this.store.registrationObserved(guest.id);
      else {
      if (this.stopped) return;
      this.store.enqueueAction(guest.id, guestActionRequest({ requestId: randomUUID(), action: "register_player",
        parameters: {}, validUntilNs: (BigInt(reader.block.timestampNs) + 300_000_000_000n).toString() }));
      }
      }
    }
    const action = this.store.nextAction();
    if (!action) return;
    try { await this.execute(action); }
    catch (error) {
      const current = this.store.action(action.guest_id, action.request_id)!;
      if (current.status === "queued" && (error instanceof GuestError || (error instanceof Error && error.name === "ChainValidationError")))
        this.store.finishAction(action.guest_id, action.request_id, "failed", null,
          error instanceof GuestError ? error.code : "guest_action_invalid");
      else throw error; // Preserve signed/unknown originals; dependency failure is not execution failure.
    }
  }
  private async execute(action: GuestActionRow): Promise<void> {
    const guest = this.store.guest(action.guest_id)!;
    if (guest.status !== "active") return;
    if (action.status === "queued") {
      const request = guestActionRequest(JSON.parse(action.request_json)), reader = await this.client.finalized();
      const call = await this.compile(reader, guest, request);
      const access = await reader.getAccessKey(guest.account_id, guest.public_key);
      guestCheck(access.permission === "FullAccess", "guest_signing_key_changed");
      if (this.stopped) return;
      const secret = this.store.vault.open(guest.encrypted_key, `${this.store.binding}:${guest.id}:key`);
      const signer = KeyPairSigner.fromSecretKey(secret as KeyPairString);
      guestCheck((await signer.getPublicKey()).toString() === guest.public_key);
      const transaction = createTransaction(guest.account_id, PublicKey.from(guest.public_key),
        this.config.profile.public.contractId, BigInt(access.nonce) + 1n,
        [actions.functionCall(call.method, call.args, BigInt(guestGas), 0n)], baseDecode(reader.block.hash));
      const signed = await signer.signTransaction(transaction);
      const proof = playerReceiptProof({ transactionHash: baseEncode(signed.txHash), signerId: guest.account_id,
        deployment: this.config.profile.identity.deployment, call, gas: guestGas, referenceBlockHeight: reader.block.height });
      this.store.signAction(guest.id, action.request_id, proof,
        Buffer.from(signed.signedTransaction.encode()).toString("base64"), proof.transactionHash);
      action = this.store.action(guest.id, action.request_id)!;
    }
    if (this.stopped) return;
    if (!action.dispatch_started) {
      this.store.dispatchAction(guest.id, action.request_id);
      const signed = this.store.vault.open(action.signed_cipher!, `${this.store.binding}:${guest.id}:${action.request_id}:action`);
      try {
  await this.rpc("send_tx", {
    signed_tx_base64: signed,
    wait_until: "INCLUDED"
  });
} catch (error) {
  if (isNotEnoughBalance(error)) {
    this.store.finishAction(
      guest.id,
      action.request_id,
      "failed",
      {
        kind: "rpc_rejection",
        transactionHash: action.tx_hash,
        reason: "NotEnoughBalance"
      },
      "guest_insufficient_balance"
    );
    return;
  }

  throw error;
}
    }
    await this.publish();
    const proof = playerReceiptProof(JSON.parse(action.proof_json!));
    const evidence = proof.call.method === "complete_production"
      ? await this.client.completionReceiptEvidence({ ...proof, call: proof.call })
      : await this.client.receiptEvidence({ ...proof, call: proof.call });
    if (evidence.status.kind === "unknown" && evidence.response === null && !this.stopped) {
      if (proof.call.method === "register_player") {
        const reader = await this.client.finalized();
        if (BigInt(reader.block.timestampNs) > BigInt(proof.call.args.command.valid_until_ns)) {
          const player = await reader.getPlayer(guest.account_id);
          const command = await reader.getCommand(guest.account_id, proof.call.args.command.sequence);
          if (!player.data && command.data.kind === "not_applied" &&
            command.data.next_sequence === proof.call.args.command.sequence) {
            // The finalized chain has passed the command deadline without
            // applying it. Future execution cannot register this player.
            // Keep the original proof; only automatic registration may renew.
            this.store.finishAction(guest.id, action.request_id, "failed", null, "guest_registration_expired");
            return;
          }
        }
      }
      // UNKNOWN_TRANSACTION can follow a lost first broadcast. Re-send only
      // the persisted signed bytes: the signer, nonce, hash and terms stay fixed.
      // Never compile/sign a replacement or assign a new request ID here.
      const signed = this.store.vault.open(action.signed_cipher!, `${this.store.binding}:${guest.id}:${action.request_id}:action`);
      try {
  await this.rpc("send_tx", {
    signed_tx_base64: signed,
    wait_until: "INCLUDED"
  });
} catch (error) {
  if (isNotEnoughBalance(error)) {
    this.store.finishAction(
      guest.id,
      action.request_id,
      "failed",
      {
        kind: "rpc_rejection",
        transactionHash: action.tx_hash,
        reason: "NotEnoughBalance"
      },
      "guest_insufficient_balance"
    );
    return;
  }

  throw error;
}
      return;
    }
    if (evidence.status.kind === "succeeded" || evidence.status.kind === "failed") {
      this.store.finishAction(guest.id, action.request_id, evidence.status.kind === "succeeded" ? "confirmed" : "failed",
        evidence.status, evidence.status.kind === "failed" ? "EXECUTION_FAILED" : null);
      if (evidence.status.kind === "succeeded" && proof.call.method === "register_player") this.store.registrationObserved(guest.id);
    }
  }
  private async compile(reader: FinalizedLivingTownReader, guest: GuestRow, request: GuestActionRequest): Promise<Call> {
    const method = guestActionMethod(request.action), args = request.parameters, now = BigInt(reader.block.timestampNs);
    const deny = (condition: unknown, code: string): void => { if (!condition) throw new GuestError(409, code); };
    deny(BigInt(request.validUntilNs) > now && BigInt(request.validUntilNs) <= now + 600_000_000_000n, "guest_review_expired");
    const town = await reader.getTown(), player = (await reader.getPlayer(guest.account_id)).data;
    deny(!town.data.paused || method === "cancel_listing" || method === "complete_production", "town_paused");
    const command = await reader.getCommand(guest.account_id, "18446744073709551615");
    if (command.data.kind !== "not_applied")
      throw new GuestError(409, "guest_command_sequence_unavailable");
    const call = method === "complete_production" ? createLivingTownCompletionCall(args)
      : createLivingTownCall(method, { ...args, command: { sequence: command.data.next_sequence,
        config_version: this.config.profile.identity.deployment.config_version, valid_until_ns: request.validUntilNs } });
    if (method === "register_player") { deny(!player, "already_registered"); return call; }
    deny(player, "guest_registration_required");
    if (method === "create_shop") { deny(!player!.shop_id, "shop_already_exists"); return call; }
    if (method === "buy_from_merchant") {
      const merchant = String(args["merchant_id"]), shopId = String(["rex", "luna", "bolt"].indexOf(merchant) + 1);
      const listings = await reader.getListings({ shop_id: shopId, item_id: args["item_id"], active_only: true,
        after_id: null, limit: "50", expected_market_revision: town.market_revision });
      const listing = listings.data.items.find(l => l.item_id === args["item_id"] && l.active);
      deny(listing && listing.revision === args["expected_listing_revision"], "guest_listing_changed");
      const quantity = BigInt(String(args["quantity"])), total = BigInt(listing!.unit_price) * quantity;
      deny(quantity <= BigInt(listing!.remaining_quantity), "insufficient_stock");
      deny(total <= BigInt(String(args["max_total_price"])) && total <= BigInt(player!.ledger.gold.available), "guest_price_or_gold_changed");
      const item = args["item_id"] as "crystal" | "wood" | "herb" | "iron";
      deny(BigInt(player!.ledger.inventory.held[item]) + BigInt(player!.ledger.inventory.production_output_reserved[item]) +
        BigInt(player!.ledger.inventory.trade_inbound_reserved[item]) + quantity <= 1000n, "guest_inventory_capacity");
      return call;
    }
    deny(player!.shop_id, "guest_shop_required");
    const shop = (await reader.getShop(player!.shop_id!)).data;
    deny(shop?.owner.kind === "player" && shop.owner.account_id === guest.account_id, "guest_not_shop_owner");
    if (["rename_shop", "start_production", "set_listing", "purchase_upgrade"].includes(method))
      deny(args["shop_id"] === shop!.shop_id, "guest_not_shop_owner");
    if (method === "rename_shop" || method === "start_production")
      deny(args["expected_shop_revision"] === shop!.revision, "guest_shop_changed");
    if (method === "start_production" || method === "complete_production") {
      const jobs = await reader.getProductionJobs({ shop_id: shop!.shop_id, status: "running", after_id: null,
        limit: "50", expected_market_revision: town.market_revision });
      deny(!jobs.data.has_more, "guest_production_page_unavailable");
      if (method === "complete_production") {
        const job = jobs.data.items.find(j => j.job_id === args["job_id"]);
        deny(job?.owner.kind === "player" && job.owner.account_id === guest.account_id && BigInt(job.ready_at_ns) <= now, "guest_job_not_ready");
      } else {
        deny(jobs.data.items.length < Number(shop!.production_slots), "guest_production_slots_full");
        const recipes = await reader.getRecipes({ after_id: null, limit: "50", expected_market_revision: town.market_revision });
        const recipe = recipes.data.items.find(r => r.recipe.recipe_id === args["recipe_id"] && r.recipe.version === args["recipe_version"]);
        deny(recipe, "guest_recipe_unavailable");
        const terms = planLivingTownProduction(recipe!.recipe, this.config.profile.identity.deployment.config_version, args["quantity"], reader.block.timestampNs);
        for (const [item, amount] of Object.entries(terms.inputs_consumed))
          deny(BigInt(player!.ledger.inventory.available[item as keyof typeof terms.inputs_consumed]) >= BigInt(amount), "guest_ingredients_unavailable");
        const item = terms.output_item;
        deny(BigInt(player!.ledger.inventory.held[item]) + BigInt(player!.ledger.inventory.production_output_reserved[item]) +
          BigInt(player!.ledger.inventory.trade_inbound_reserved[item]) + BigInt(terms.output_quantity) <= 1000n, "guest_inventory_capacity");
      }
    }
    if (method === "set_listing" || method === "cancel_listing") {
      const listings = await reader.getListings({ shop_id: shop!.shop_id, item_id: null, active_only: false,
        after_id: null, limit: "50", expected_market_revision: town.market_revision });
      deny(!listings.data.has_more, "guest_listing_page_unavailable");
      const listing = listings.data.items.find(l => method === "set_listing" ? l.item_id === args["item_id"] : l.listing_id === args["listing_id"]);
      deny((listing?.revision ?? null) === args["expected_listing_revision"], "guest_listing_changed");
      if (method === "cancel_listing") deny(listing?.active && listing.owner.kind === "player" && listing.owner.account_id === guest.account_id, "guest_listing_not_owned");
      else {
        deny(["health_potion", "iron_tool"].includes(String(args["item_id"])), "guest_product_listing_required");
        const item = args["item_id"] as "health_potion" | "iron_tool";
        deny(BigInt(String(args["quantity"])) <= BigInt(player!.ledger.inventory.available[item]) + BigInt(listing?.remaining_quantity ?? "0"), "guest_listing_stock_changed");
      }
    }
    if (method === "purchase_upgrade") {
      const upgrade = (await reader.getUpgrade(shop!.shop_id)).data;
      deny(upgrade.eligible, "guest_upgrade_unavailable");
    }
    return call;
  }
  private async publish(): Promise<void> {
    for (const action of this.store.unpublishedActions()) {
      const proof = playerReceiptProof(JSON.parse(action.proof_json!));
      await mkdir(this.config.outbox, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.config.outbox); guestCheck(stat.isDirectory() && !stat.isSymbolicLink());
      guestCheck((await readdir(this.config.outbox)).filter(name => name.endsWith(".json")).length < 1000, "guest_receipt_outbox_backpressure");
      await atomicRuntimeJson(join(this.config.outbox, `${proof.transactionHash}.json`), {
        schema: "living-town-receipt-inbox-v1", requests: [{ transaction_hash: proof.transactionHash,
          signer_id: proof.signerId, method: proof.call.method, args: proof.call.args, reference_block_height: proof.referenceBlockHeight,
          ...(proof.gas ? { gas: proof.gas } : {}) }],
      });
      this.store.markPublished(action.guest_id, action.request_id);
    }
  }
}
