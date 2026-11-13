import type { TownLane } from "./execution-store.js";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  PublicKey,
  SignedTransaction,
} from "near-api-js";
import {
  LivingTownClient,
  createLivingTownCall,
  createLivingTownCompletionCall,
  canonicalLivingTownJson,
  parseU64,
  isLivingTownOfferMethod,
} from "@bot-bazaar/chain";
import type {
  LivingTownIdentity,
  LivingTownProof,
  LivingTownCall,
  LivingTownCompletionCall,
  RpcTransport,
} from "@bot-bazaar/chain";
import type { MerchantCredential, Submission } from "../chain-adapter.js";
import {
  assertRuntimePermission,
  signRestrictedTransaction,
} from "../near-signer.js";
import { requireStorage, sha256 } from "../storage/validation.js";

export type TownCall = LivingTownCall | LivingTownCompletionCall;
export async function validateTownOfferCall(
  reader: import("@bot-bazaar/chain").FinalizedLivingTownReader,
  call: TownCall,
): Promise<void> {
  if (!isLivingTownOfferMethod(call.method)) return;
  const { town, offers } = await reader.getPendingMerchantOffers(),
    a = call.args as Record<string, unknown>,
    at = BigInt(town.block_timestamp_ns);
  if (call.method === "propose_trade") {
    requireStorage(
      !offers.some((o) =>
        [o.buyer, o.seller].some(
          (m) => m === a["buyer_merchant_id"] || m === a["seller_merchant_id"],
        ),
      ),
      "participant has an unresolved chain offer",
    );
    requireStorage(
      BigInt(String(a["expires_at_ns"])) >= at + 60000000000n &&
        BigInt(String(a["expires_at_ns"])) <= at + 600000000000n,
      "proposal lifetime no longer valid",
    );
  } else {
    const ids =
      call.method === "expire_offers"
        ? (a["offer_ids"] as string[])
        : [String(a["offer_id"])];
    for (const id of ids) {
      const lookup = await reader.getOffer(id);
      if (call.method === "expire_offers") {
        requireStorage(
          lookup.data.kind !== "not_found",
          "unallocated offer cleanup",
        );
        if (lookup.data.kind === "found")
          requireStorage(
            [lookup.data.offer.buyer, lookup.data.offer.seller].includes(
              a["merchant_id"] as "rex" | "luna" | "bolt",
            ) &&
              (lookup.data.offer.status !== "pending" ||
                BigInt(lookup.data.offer.expires_at_ns) <= at),
            "cleanup participant/deadline mismatch",
          );
      } else {
        requireStorage(
          lookup.data.kind === "found" &&
            lookup.data.offer.status === "pending",
          "pending offer required",
        );
        const o = lookup.data.offer;
        requireStorage(
          o.revision === a["expected_offer_revision"] &&
            (call.method === "cancel_trade" ? o.buyer : o.seller) ===
              a["merchant_id"] &&
            BigInt(o.expires_at_ns) > at,
          "offer revision/actor/expiry changed",
        );
      }
    }
  }
  if (call.method === "propose_trade" || call.method === "accept_trade") {
    const o =
      call.method === "accept_trade"
        ? offers.find((o) => o.offer_id === a["offer_id"])
        : null;
    const b =
        call.method === "propose_trade" ? a["buyer_merchant_id"] : o?.buyer,
      s = call.method === "propose_trade" ? a["seller_merchant_id"] : o?.seller;
    requireStorage(
      town.data.npc_ledgers.find(
        (l) => l.actor.kind === "merchant" && l.actor.merchant_id === b,
      )?.revision === a["expected_buyer_ledger_revision"] &&
        town.data.npc_ledgers.find(
          (l) => l.actor.kind === "merchant" && l.actor.merchant_id === s,
        )?.revision === a["expected_seller_ledger_revision"],
      "offer ledger revision changed",
    );
  }
}
export interface PreparedTownCall extends Omit<LivingTownProof, "call"> {
  call: TownCall;
  publicKey: string;
  nonce: string;
  gas: string;
  signedTransactionBase64: string;
}
export function townCall(
  method: string,
  args: unknown,
  lane: TownLane,
): TownCall {
  const allowed =
    lane === "operator"
      ? ["allocate_raw_supply", "sweep_merchant_treasury", "assistant_reprice"]
      : [
          "set_listing",
          "batch_set_listings",
          "start_production",
          "complete_production",
          "merchant_purchase",
          "propose_trade",
          "accept_trade",
          "reject_trade",
          "cancel_trade",
          "expire_offers",
        ];
  requireStorage(allowed.includes(method), "method outside town lane scope");
  const call =
    method === "complete_production"
      ? createLivingTownCompletionCall(args)
      : createLivingTownCall(method as LivingTownCall["method"], args);
  if (lane !== "operator" && "shop_id" in call.args)
    requireStorage(
      call.args.shop_id === String(["rex", "luna", "bolt"].indexOf(lane) + 1),
      "NPC shop outside selected lane",
    );
  if (call.method === "batch_set_listings")
    requireStorage(
      "updates" in call.args &&
        call.args.updates.every(
          (u) =>
            u.shop_id ===
            String(
              ["rex", "luna", "bolt"].indexOf(lane as "rex" | "luna" | "bolt") +
                1,
            ),
        ),
      "Batch shop outside selected lane",
    );
  if (call.method === "merchant_purchase")
    requireStorage(
      "buyer_merchant_id" in call.args && call.args.buyer_merchant_id === lane,
      "merchant buyer outside selected lane",
    );
  if (isLivingTownOfferMethod(call.method)) {
    const a = call.args as Record<string, unknown>;
    requireStorage(
      a[
        call.method === "propose_trade" ? "buyer_merchant_id" : "merchant_id"
      ] === lane,
      "offer actor outside selected lane",
    );
  }
  return call;
}
export function readTownPrepared(
  text: string,
  identity: LivingTownIdentity,
  lane: TownLane,
): PreparedTownCall {
  requireStorage(
    Buffer.byteLength(text) <= 65536,
    "oversized signed town transaction",
  );
  const p = JSON.parse(text) as PreparedTownCall;
  const call = townCall(p.call.method, p.call.args, lane);
  requireStorage(
    identity.deployment.state_schema !== "2" ||
      call.method !== "merchant_purchase",
    "direct merchant purchase is not a schema-2 capability",
  );
  const tx = SignedTransaction.decode(
    Buffer.from(p.signedTransactionBase64, "base64"),
  ).transaction;
  const action = tx.actions[0]?.functionCall;
  requireStorage(
    canonicalLivingTownJson(p.deployment) ===
      canonicalLivingTownJson(identity.deployment) &&
      p.signerId ===
        (lane === "operator"
          ? identity.operatorId
          : identity.controllers[lane]) &&
      tx.signerId === p.signerId &&
      canonicalLivingTownJson(p.deployment) ===
        canonicalLivingTownJson(identity.deployment) &&
      tx.receiverId === identity.deployment.contract_id &&
      tx.publicKey.toString() === p.publicKey &&
      p.publicKey.startsWith("ed25519:") &&
      tx.nonce.toString() === parseU64(p.nonce) &&
      p.transactionHash === baseEncode(Buffer.from(sha256(tx.encode()), "hex")),
    "town signed identity mismatch",
  );
  requireStorage(
    tx.actions.length === 1 &&
      action?.methodName === call.method &&
      action.deposit === 0n &&
      action.gas.toString() === parseU64(p.gas) &&
      action.gas > 0n &&
      action.gas <= 300000000000000n &&
      canonicalLivingTownJson(
        townCall(
          call.method,
          JSON.parse(Buffer.from(action.args).toString("utf8")),
          lane,
        ).args,
      ) === canonicalLivingTownJson(call.args) &&
      parseU64(p.referenceBlockHeight) !== "0",
    "town signed terms mismatch",
  );
  return { ...p, call };
}

/** Restricted adapter; invocation belongs exclusively to the shared journal processor. */
export class TownChainAdapter {
  readonly client: LivingTownClient;
  readonly identity: LivingTownIdentity;
  readonly signerId: string;
  private readonly credential: MerchantCredential;
  constructor(
    identity: unknown,
    private readonly rpc: RpcTransport,
    credential: MerchantCredential,
    readonly lane: TownLane,
    readonly operatorScope: "town_source" | "town_operator" = "town_source",
  ) {
    this.client = new LivingTownClient(identity, rpc);
    this.identity = this.client.identity;
    this.signerId =
      lane === "operator"
        ? this.identity.operatorId
        : this.identity.controllers[lane];
    requireStorage(
      PublicKey.fromString(credential.publicKey)
        .toString()
        .startsWith("ed25519:"),
      "town runtime key must be ed25519",
    );
    this.credential = Object.freeze({ ...credential });
  }
  /** Read-only pre-inference capability check; prepare repeats it before signing. */
  async verifyNegotiationScope(
    reader: import("@bot-bazaar/chain").FinalizedLivingTownReader,
  ): Promise<void> {
    requireStorage(
      this.lane !== "operator" &&
        this.identity.deployment.state_schema === "2" &&
        canonicalLivingTownJson(reader.identity) ===
          canonicalLivingTownJson(this.identity),
      "negotiation reader/lane mismatch",
    );
    const foundation = await reader.getFoundation();
    requireStorage(
      (
        [
          "propose_trade",
          "accept_trade",
          "reject_trade",
          "cancel_trade",
          "expire_offers",
          "get_offer",
          "get_offers",
          "get_merchant_trading_rules",
        ] as const
      ).every((m) => foundation.data.supported_methods.includes(m)),
      "negotiated contract capability missing",
    );
    const key = await reader.getAccessKey(
      this.signerId,
      this.credential.publicKey,
    );
    assertRuntimePermission(
      key.permission,
      this.identity.deployment.contract_id,
      (
        key.permission as { FunctionCall?: { method_names?: string[] } }
      )?.FunctionCall?.method_names?.includes("batch_set_listings")
        ? "town_batch_negotiating_merchant"
        : "town_negotiating_merchant",
    );
  }
  async supportsListingBatch(
    reader: import("@bot-bazaar/chain").FinalizedLivingTownReader,
  ): Promise<boolean> {
    if (
      this.lane === "operator" ||
      !(await reader.getFoundation()).data.supported_methods.includes(
        "batch_set_listings",
      )
    )
      return false;
    const key = await reader.getAccessKey(
      this.signerId,
      this.credential.publicKey,
    );
    const names = (
      key.permission as { FunctionCall?: { method_names?: string[] } }
    )?.FunctionCall?.method_names;
    if (!names?.includes("batch_set_listings")) return false;
    assertRuntimePermission(
      key.permission,
      this.identity.deployment.contract_id,
      names.includes("propose_trade")
        ? "town_batch_negotiating_merchant"
        : "town_batch_merchant",
    );
    return true;
  }
  async prepare(
    call: TownCall,
    beforeSign: (reader: import("@bot-bazaar/chain").FinalizedLivingTownReader) => Promise<void>,
  ): Promise<PreparedTownCall> {
    call = townCall(call.method, call.args, this.lane);
    requireStorage(
      call.method !== "assistant_reprice" ||
        this.operatorScope === "town_operator",
      "assistant requires explicit operator key scope",
    );
    const reader = await this.client.finalized();
    const key = await reader.getAccessKey(
      this.signerId,
      this.credential.publicKey,
    );
    const keyMethods = (
      key.permission as { FunctionCall?: { method_names?: unknown } } | null
    )?.FunctionCall?.method_names;
    const signingScope =
      this.lane === "operator"
        ? this.operatorScope
        : Array.isArray(keyMethods) && keyMethods.includes("batch_set_listings")
          ? keyMethods.includes("propose_trade")
            ? "town_batch_negotiating_merchant"
            : "town_batch_merchant"
          : this.identity.deployment.state_schema === "2" &&
              Array.isArray(keyMethods) &&
              keyMethods.includes("propose_trade")
            ? "town_negotiating_merchant"
            : Array.isArray(keyMethods) &&
                keyMethods.includes("merchant_purchase")
              ? "town_trading_merchant"
              : "town_merchant";
    requireStorage(
      call.method !== "merchant_purchase" ||
        signingScope === "town_trading_merchant",
      "merchant trading requires an explicitly authorized trading key",
    );
    requireStorage(
      !isLivingTownOfferMethod(call.method) ||
        (this.identity.deployment.state_schema === "2" &&
          (signingScope === "town_negotiating_merchant" ||
            signingScope === "town_batch_negotiating_merchant")),
      "offers require schema 2 and exact negotiated key scope",
    );
    requireStorage(
      call.method !== "merchant_purchase" ||
        this.identity.deployment.state_schema === "1",
      "direct merchant purchase is not a schema-2 capability",
    );
    assertRuntimePermission(
      key.permission,
      this.identity.deployment.contract_id,
      signingScope,
    );
    requireStorage(
      call.method !== "batch_set_listings" ||
        (await this.supportsListingBatch(reader)),
      "batch listings require deployed capability and an explicitly authorized key",
    );
    if (isLivingTownOfferMethod(call.method))
      await validateTownOfferCall(reader, call);
    const tx = createTransaction(
      this.signerId,
      PublicKey.fromString(this.credential.publicKey),
      this.identity.deployment.contract_id,
      BigInt(key.nonce) + 1n,
      [actions.functionCall(call.method, call.args, 30000000000000n, 0n)],
      baseDecode(reader.block.hash),
    );
    const secretKey = await this.credential.loadSecretKey();
    const latest = await this.client.finalized();
    const freshKey = await latest.getAccessKey(
      this.signerId,
      this.credential.publicKey,
    );
    assertRuntimePermission(
      freshKey.permission,
      this.identity.deployment.contract_id,
      signingScope,
    );
    requireStorage(
      freshKey.nonce === key.nonce,
      "town key nonce changed before signing",
    );
    requireStorage(
      call.method !== "batch_set_listings" ||
        (await this.supportsListingBatch(latest)),
      "batch listings require deployed capability and an explicitly authorized key",
    );
    if (isLivingTownOfferMethod(call.method))
      await validateTownOfferCall(latest, call);
    await beforeSign(latest);
    const signed = await signRestrictedTransaction({
      scope: signingScope,
      networkId: "testnet",
      controllerId: this.signerId,
      contractId: this.identity.deployment.contract_id,
      secretKey,
      accessKey: {
        nonce: BigInt(key.nonce),
        block_hash: key.block_hash,
        block_height: Number(key.block_height),
        permission: key.permission,
      } as Parameters<typeof signRestrictedTransaction>[0]["accessKey"],
      transaction: tx,
    });
    return {
      transactionHash: baseEncode(signed.txHash),
      signerId: this.signerId,
      deployment: this.identity.deployment,
      call,
      referenceBlockHeight: reader.block.height,
      publicKey: this.credential.publicKey,
      nonce: tx.nonce.toString(),
      gas: "30000000000000",
      signedTransactionBase64: Buffer.from(
        signed.signedTransaction.encode(),
      ).toString("base64"),
    };
  }
  async submit(value: PreparedTownCall): Promise<Submission> {
    const p = readTownPrepared(JSON.stringify(value), this.identity, this.lane);
    try {
      const response = await this.rpc("send_tx", {
        signed_tx_base64: p.signedTransactionBase64,
        wait_until: "INCLUDED",
      });
      const returned = response as { transaction?: { hash?: unknown } };
      requireStorage(
        returned?.transaction?.hash === p.transactionHash,
        "town broadcast hash mismatch",
      );
      return { kind: "submitted", transactionHash: p.transactionHash };
    
} catch (error) {
  const rpcError = error as {
    code?: string;
    rpcCause?: string;
    transactionReason?: string;
  };

  console.error(JSON.stringify({
    role: "economic_runtime",
    event: "town_transaction_broadcast_failed",
    merchant: this.lane,
    method: p.call.method,
    transactionHash: p.transactionHash,
    signerId: p.signerId,
    nonce: p.nonce,
    errorCode: rpcError.code ?? "UNKNOWN",
    rpcCause: rpcError.rpcCause ?? null,
    transactionReason: rpcError.transactionReason ?? null,
  }));

  return {
    kind: "unknown",
    transactionHash: p.transactionHash,
  };
}

  }
}
