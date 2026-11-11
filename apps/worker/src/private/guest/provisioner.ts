import { actions, baseDecode, baseEncode, createTransaction, KeyPairSigner, PublicKey } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { ChainRpcError, LivingTownClient, canonicalLivingTownJson } from "@bot-bazaar/chain";
import type { RpcTransport } from "@bot-bazaar/chain";
import { guestCheck, guestObject } from "./config.js";
import type { GuestConfig } from "./config.js";
import { privateGuestFile } from "./vault.js";
import { GuestStore } from "./store.js";
import type { GuestRow } from "./store.js";

type Json = Record<string, unknown>;
function row(value: unknown): Json { guestCheck(value && typeof value === "object" && !Array.isArray(value), "guest_rpc_evidence_invalid"); return value as Json; }
function decimal(value: unknown): bigint { guestCheck(typeof value === "string" && /^(0|[1-9][0-9]{0,39})$/.test(value)); return BigInt(value); }
export function guestFunder(config: GuestConfig) {
  try {
  const r = guestObject(privateGuestFile(config.funderFile), ["account_id", "public_key", "private_key"]);
  guestCheck(r["account_id"] === config.parent && typeof r["public_key"] === "string" && typeof r["private_key"] === "string");
  guestCheck(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r["public_key"]) && r["private_key"].startsWith("ed25519:"));
  const signer = KeyPairSigner.fromSecretKey(r["private_key"] as KeyPairString);
  return { accountId: config.parent, publicKey: r["public_key"], signer };
  } catch { throw new Error("guest_funder_credential_invalid"); }
}
export class GuestProvisioner {
  private readonly client: LivingTownClient;
  private stopped = false;
  private running: Promise<void> | undefined;
  constructor(private readonly config: GuestConfig, private readonly store: GuestStore,
    private readonly rpc: RpcTransport, private readonly funder: ReturnType<typeof guestFunder>) {
    this.client = new LivingTownClient(config.profile.identity, rpc);
  }
  stop(): void { this.stopped = true; }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.step().finally(() => { this.running = undefined; });
    return this.running;
  }
  async settled(): Promise<void> { await this.running; }
  private async step(): Promise<void> {
    let guest = this.store.next();
    if (!guest) return;
    // Verify Testnet genesis, the selected contract code and authority before
    // any funding. No merchant credentials or shared inference authority enter.
    const reader = await this.client.finalized();
    guestCheck((await this.funder.signer.getPublicKey()).toString() === this.funder.publicKey, "guest_funder_key_mismatch");
    if (!guest.tx_hash) {
      if (this.store.fundingBlocked()) return;
      const access = await reader.getAccessKey(this.funder.accountId, this.funder.publicKey);
      guestCheck(access.permission === "FullAccess", "guest_parent_full_access_required");
      const account = row(await this.rpc("query", { request_type: "view_account", account_id: this.funder.accountId, block_id: reader.block.hash }));
      guestCheck(account["block_hash"] === reader.block.hash);
      guestCheck(decimal(account["amount"]) >= BigInt(this.config.funding) + BigInt(this.config.feeReserve), "guest_parent_insufficient_balance");
      if (this.stopped) return;
      const tx = createTransaction(this.funder.accountId, PublicKey.from(this.funder.publicKey),
        guest.account_id, BigInt(access.nonce) + 1n,
        [actions.createAccount(), actions.transfer(BigInt(this.config.funding)),
          actions.addFullAccessKey(PublicKey.from(guest.public_key))], baseDecode(reader.block.hash));
      const signed = await this.funder.signer.signTransaction(tx);
      // Persist the one original signed intent before the irreversible handoff.
      this.store.prepared(guest.id, baseEncode(signed.txHash),
        Buffer.from(signed.signedTransaction.encode()).toString("base64"), reader.block.height);
      guest = this.store.guest(guest.id)!;
    }
    if (this.stopped) return;
    if (!guest.dispatch_started) {
      if (this.store.fundingBlocked()) return;
      this.store.dispatch(guest.id);
      const signed = this.store.vault.open(guest.signed_cipher!, `${this.store.binding}:${guest.id}:provision`);
      // A crash after this marker is deliberately uncertain. Restarts query the
      // same hash, never regenerate a nonce/account or top up another address.
      try {
  await this.rpc("send_tx", {
    signed_tx_base64: signed,
    wait_until: "FINAL"
  });
} catch (error) {
  if (
    error instanceof ChainRpcError &&
    error.code === "REJECTED" &&
    error.rpcCause === "INVALID_TRANSACTION" &&
    error.transactionReason === "NotEnoughBalance"
  ) {
    this.store.rejectInsufficientBalance(
      guest.id,
      guest.tx_hash!
    );
    return;
  }

  // Unknown broadcast outcome: retain the original transaction.
  return;
}
    }
    let response: unknown;
    try { response = await this.rpc("tx", { tx_hash: guest.tx_hash, sender_account_id: this.funder.accountId, wait_until: "FINAL" }); }
    catch (error) {
  if (
    error instanceof ChainRpcError &&
    error.code === "REJECTED" &&
    error.rpcCause === "INVALID_TRANSACTION" &&
    error.transactionReason === "NotEnoughBalance"
  ) {
    this.store.rejectInsufficientBalance(
      guest.id,
      guest.tx_hash!
    );
    return;
  }

  if (error instanceof ChainRpcError) return;
  throw error;
}
    try { await this.verify(guest, response); }
    catch (error) {
      // RPC unavailability is recoverable. Malformed/conflicting finalized
      // evidence fences new funding instead of activating an unverified account.
      if (error instanceof ChainRpcError) throw error;
      this.store.block(guest.id); throw error;
    }
  }
  private async verify(guest: GuestRow, value: unknown): Promise<void> {
    const response = row(value), tx = row(response["transaction"]), status = row(response["status"]);
    guestCheck(response["final_execution_status"] === "FINAL", "guest_creation_not_final");
    guestCheck(tx["hash"] === guest.tx_hash && tx["signer_id"] === this.funder.accountId &&
      tx["public_key"] === this.funder.publicKey && tx["receiver_id"] === guest.account_id);
    // Bind the RPC transaction to the complete original action batch, including
    // funding amount and guest key, rather than merely accepting a found account.
    guestCheck(this.sameActions(tx["actions"], guest), "guest_creation_actions_mismatch");
    const transactionOutcome = row(response["transaction_outcome"]);
    guestCheck(Array.isArray(response["receipts_outcome"]) && response["receipts_outcome"].length <= 128);
    const outcomes = [transactionOutcome, ...(response["receipts_outcome"] as unknown[]).map(row)];
    const head = await this.client.block();
    let fee = 0n;
    for (const entry of outcomes) {
      const hash = entry["block_hash"]; guestCheck(typeof hash === "string");
      const block = await this.client.block(hash);
      guestCheck(BigInt(block.height) <= BigInt(head.height) && BigInt(block.height) > BigInt(guest.reference_height!));
      const outcome = row(entry["outcome"]);
      fee += decimal(outcome["tokens_burnt"]);
    }
    const failed = Object.hasOwn(status, "Failure");
    guestCheck(failed || Object.hasOwn(status, "SuccessValue"), "guest_creation_outcome_unknown");
    if (!failed) {
      for (const entry of outcomes) {
        const execution = row(row(entry["outcome"])["status"]);
        guestCheck(!Object.hasOwn(execution, "Failure") &&
          (Object.hasOwn(execution, "SuccessValue") || Object.hasOwn(execution, "SuccessReceiptId")));
      }
      const fresh = await this.client.finalized();
      const key = await fresh.getAccessKey(guest.account_id, guest.public_key);
      guestCheck(key.permission === "FullAccess", "guest_account_key_not_installed");
    }
    this.store.finish(guest.id, !failed, response, fee.toString());
  }
  private sameActions(value: unknown, guest: GuestRow): boolean {
    if (!Array.isArray(value) || value.length !== 3) return false;
    const first = value[0];
    if (first !== "CreateAccount" && canonicalLivingTownJson(first) !== "{\"CreateAccount\":{}}") return false;
    const transfer = row(row(value[1])["Transfer"]), add = row(row(value[2])["AddKey"]), access = row(add["access_key"]);
    return transfer["deposit"] === this.config.funding && add["public_key"] === guest.public_key &&
      (access["nonce"] === 0 || access["nonce"] === "0") && access["permission"] === "FullAccess";
  }
}
