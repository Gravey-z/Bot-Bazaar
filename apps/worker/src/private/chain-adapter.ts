import { createHash } from "node:crypto";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  PublicKey,
  SignedTransaction,
} from "near-api-js";
import type { AccessKeyView, KeyPairString } from "near-api-js";
import {
  ChainValidationError,
  MarketClient,
  createMarketCall,
  parseU64,
  verifyFinalReceipt,
} from "@bot-bazaar/chain";
import type {
  CallInput,
  CallProof,
  DeploymentIdentity,
  MerchantId,
  ReceiptStatus,
} from "@bot-bazaar/chain";
import {
  assertRuntimePermission,
  signRestrictedTransaction,
} from "./near-signer.js";

export type MerchantMethod =
  | "set_listing"
  | "propose_trade"
  | "accept_trade"
  | "cancel_trade"
  | "expire_offers";
export interface MerchantCredential {
  readonly publicKey: string;
  readonly loadSecretKey: () => Promise<KeyPairString>;
}
export interface PreparedMerchantCall<
  M extends MerchantMethod = MerchantMethod,
> extends CallProof<M> {
  readonly merchantId: MerchantId;
  readonly signedTransactionBase64: string;
}
export type Submission = {
  kind: "submitted" | "unknown";
  transactionHash: string;
};

function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ChainValidationError(message);
}
function freezeArgs<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeArgs(child);
    Object.freeze(value);
  }
  return value;
}

// This layer signs but does not allocate action IDs, journal work or run a loop.
// The caller must durably record the prepared identity/bytes before submit().
export class MerchantChainAdapter {
  private readonly identity: DeploymentIdentity;
  private readonly credentials: Readonly<
    Record<MerchantId, MerchantCredential>
  >;
  private readonly gas: string;

  constructor(
    private readonly client: MarketClient,
    identity: DeploymentIdentity,
    credentials: Readonly<Record<MerchantId, MerchantCredential>>,
    gas = "30000000000000",
  ) {
    this.identity = Object.freeze({
      ...identity,
      controllers: Object.freeze({ ...identity.controllers }),
    });
    this.credentials = Object.freeze(
      Object.fromEntries(
        (["rex", "luna", "bolt"] as const).map((id) => {
          const credential = credentials[id];
          requireState(
            credential && typeof credential.loadSecretKey === "function",
            "missing merchant credential provider",
          );
          const key = PublicKey.fromString(credential.publicKey);
          requireState(
            key.toString().startsWith("ed25519:"),
            "runtime key must be ed25519",
          );
          return [id, Object.freeze({ ...credential })];
        }),
      ) as Record<MerchantId, MerchantCredential>,
    );
    requireState(
      new Set(Object.values(this.credentials).map((row) => row.publicKey))
        .size === 3,
      "merchants require distinct runtime keys",
    );
    this.gas = parseU64(gas);
    requireState(
      BigInt(this.gas) > 0n && BigInt(this.gas) <= 300000000000000n,
      "invalid gas allowance",
    );
  }

  async prepare<M extends MerchantMethod>(
    merchantId: MerchantId,
    method: M,
    args: CallInput<M>,
  ): Promise<PreparedMerchantCall<M>> {
    requireState(
      Object.hasOwn(this.credentials, merchantId),
      "unknown merchant signer",
    );
    requireState(
      [
        "set_listing",
        "propose_trade",
        "accept_trade",
        "cancel_trade",
        "expire_offers",
      ].includes(method),
      "method outside merchant signer scope",
    );
    const call = createMarketCall(method, args);
    // Detach the caller's request before the first await, including cleanup arrays.
    const intentArgs = freezeArgs(call.args);
    const fields = intentArgs as Record<string, unknown>;
    const { reader, market } = await this.client.verifyDeployment(
      this.identity,
    );
    requireState(
      !market.data.paused ||
        method === "cancel_trade" ||
        method === "expire_offers",
      "market is paused",
    );
    const merchant = market.data.merchants.find(
      (row) => row.merchant_id === merchantId,
    );
    requireState(merchant, "merchant not found");
    if (method === "set_listing")
      requireState(
        fields["merchant_id"] === merchantId,
        "listing signer mismatch",
      );
    if (method === "propose_trade")
      requireState(
        fields["proposer"] === merchantId,
        "proposal signer mismatch",
      );
    if (method === "accept_trade" || method === "cancel_trade") {
      const lookup = await reader.getOffer(String(fields["offer_id"]));
      requireState(
        lookup.data.kind === "found",
        "offer unavailable; no signing authority",
      );
      const offer = lookup.data.offer;
      requireState(
        offer.status === "pending" &&
          BigInt(offer.expires_at_ns) > BigInt(reader.block.timestampNs),
        "offer is terminal or expired",
      );
      requireState(
        (method === "accept_trade" ? offer.counterparty : offer.proposer) ===
          merchantId,
        "stored offer role does not authorize signer",
      );
    }
    if (method !== "expire_offers")
      requireState(
        BigInt(String(fields["action_id"])) ===
          BigInt(merchant.last_action_id) + 1n,
        "action ID must be exactly next; reconcile before retrying",
      );
    const credential = this.credentials[merchantId];
    const account = this.identity.controllers[merchantId];
    const key = await reader.getAccessKey(account, credential.publicKey);
    assertRuntimePermission(key.permission, this.identity.contractId);
    const transaction = createTransaction(
      account,
      PublicKey.fromString(credential.publicKey),
      this.identity.contractId,
      BigInt(key.nonce) + 1n,
      [actions.functionCall(method, intentArgs, BigInt(this.gas), 0n)],
      baseDecode(reader.block.hash),
    );
    let signed: Awaited<ReturnType<typeof signRestrictedTransaction>>;
    try {
      // No credential is requested until deployment, role, pause and key checks pass.
      const secretKey = await credential.loadSecretKey();
      signed = await signRestrictedTransaction({
        networkId: this.identity.networkId,
        controllerId: account,
        contractId: this.identity.contractId,
        secretKey,
        accessKey: {
          nonce: BigInt(key.nonce),
          block_hash: key.block_hash,
          block_height: Number(key.block_height),
          permission: key.permission,
        } as AccessKeyView,
        transaction,
      });
    } catch {
      throw new ChainValidationError(
        "selected runtime credential could not sign",
      );
    }
    return Object.freeze({
      transactionHash: baseEncode(signed.txHash),
      signerId: account,
      publicKey: credential.publicKey,
      contractId: this.identity.contractId,
      nonce: transaction.nonce.toString(),
      gas: this.gas,
      merchantId,
      method,
      args: intentArgs,
      signedTransactionBase64: Buffer.from(
        signed.signedTransaction.encode(),
      ).toString("base64"),
    });
  }

  prepareSetListing(
    id: MerchantId,
    args: CallInput<"set_listing">,
  ): Promise<PreparedMerchantCall<"set_listing">> {
    return this.prepare(id, "set_listing", args);
  }
  prepareProposal(
    id: MerchantId,
    args: CallInput<"propose_trade">,
  ): Promise<PreparedMerchantCall<"propose_trade">> {
    return this.prepare(id, "propose_trade", args);
  }
  prepareAcceptance(
    id: MerchantId,
    args: CallInput<"accept_trade">,
  ): Promise<PreparedMerchantCall<"accept_trade">> {
    return this.prepare(id, "accept_trade", args);
  }
  prepareCancellation(
    id: MerchantId,
    args: CallInput<"cancel_trade">,
  ): Promise<PreparedMerchantCall<"cancel_trade">> {
    return this.prepare(id, "cancel_trade", args);
  }
  prepareExpiry(
    id: MerchantId,
    args: CallInput<"expire_offers">,
  ): Promise<PreparedMerchantCall<"expire_offers">> {
    return this.prepare(id, "expire_offers", args);
  }

  private inspect<M extends MerchantMethod>(
    prepared: PreparedMerchantCall<M>,
  ): PreparedMerchantCall<M> {
    prepared = { ...prepared };
    // Revalidate restored journal data as well as in-memory prepared objects.
    requireState(
      typeof prepared.signedTransactionBase64 === "string" &&
        prepared.signedTransactionBase64.length <= 65536,
      "invalid signed transaction size",
    );
    const signed = SignedTransaction.decode(
      Buffer.from(prepared.signedTransactionBase64, "base64"),
    );
    const tx = signed.transaction;
    requireState(
      Object.hasOwn(this.credentials, prepared.merchantId),
      "unknown prepared merchant",
    );
    requireState(
      tx.signerId === this.identity.controllers[prepared.merchantId] &&
        tx.signerId === prepared.signerId &&
        tx.receiverId === this.identity.contractId &&
        tx.receiverId === prepared.contractId &&
        tx.publicKey.toString() ===
          this.credentials[prepared.merchantId].publicKey &&
        tx.publicKey.toString() === prepared.publicKey,
      "prepared transaction identity mismatch",
    );
    requireState(
      baseEncode(createHash("sha256").update(tx.encode()).digest()) ===
        prepared.transactionHash && tx.nonce.toString() === prepared.nonce,
      "prepared transaction hash/nonce mismatch",
    );
    requireState(tx.actions.length === 1, "expected one prepared call");
    const call = tx.actions[0]?.functionCall;
    requireState(
      call &&
        call.methodName === prepared.method &&
        call.deposit === 0n &&
        call.gas.toString() === this.gas &&
        prepared.gas === this.gas,
      "prepared method/deposit/gas mismatch",
    );
    requireState(
      [
        "set_listing",
        "propose_trade",
        "accept_trade",
        "cancel_trade",
        "expire_offers",
      ].includes(prepared.method),
      "prepared method outside signer scope",
    );
    const actual = createMarketCall(
      prepared.method,
      JSON.parse(Buffer.from(call.args).toString("utf8")),
    ).args;
    requireState(
      JSON.stringify(actual) ===
        JSON.stringify(createMarketCall(prepared.method, prepared.args).args),
      "prepared arguments mismatch",
    );
    return Object.freeze({ ...prepared, args: freezeArgs(actual) });
  }

  async submit<M extends MerchantMethod>(
    prepared: PreparedMerchantCall<M>,
  ): Promise<Submission> {
    const checked = this.inspect(prepared);
    try {
      await this.client.transport("send_tx", {
        signed_tx_base64: checked.signedTransactionBase64,
        wait_until: "NONE",
      });
      return { kind: "submitted", transactionHash: checked.transactionHash };
    } catch {
      // An RPC error, timeout or duplicate response does not prove non-execution.
      return { kind: "unknown", transactionHash: checked.transactionHash };
    }
  }
  async status<M extends MerchantMethod>(
    prepared: PreparedMerchantCall<M>,
  ): Promise<ReceiptStatus<M>> {
    const checked = this.inspect(prepared);
    try {
      const result = await this.client.transport("tx", {
        tx_hash: checked.transactionHash,
        sender_account_id: checked.signerId,
        wait_until: "NONE",
      });
      return await verifyFinalReceipt(result, checked);
    } catch {
      return { kind: "unknown", transactionHash: checked.transactionHash };
    }
  }
}
