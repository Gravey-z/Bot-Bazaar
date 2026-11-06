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
      ? ["allocate_raw_supply", "sweep_merchant_treasury"]
      : ["set_listing", "start_production", "complete_production"];
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
  async prepare(
    call: TownCall,
    beforeSign: () => Promise<void>,
  ): Promise<PreparedTownCall> {
    call = townCall(call.method, call.args, this.lane);
    const reader = await this.client.finalized();
    const key = await reader.getAccessKey(
      this.signerId,
      this.credential.publicKey,
    );
    assertRuntimePermission(
      key.permission,
      this.identity.deployment.contract_id,
      this.lane === "operator" ? "town_source" : "town_merchant",
    );
    const tx = createTransaction(
      this.signerId,
      PublicKey.fromString(this.credential.publicKey),
      this.identity.deployment.contract_id,
      BigInt(key.nonce) + 1n,
      [actions.functionCall(call.method, call.args, 100000000000000n, 0n)],
      baseDecode(reader.block.hash),
    );
    const secretKey = await this.credential.loadSecretKey();
    await beforeSign();
    const latest = await this.client.finalized();
    const freshKey = await latest.getAccessKey(
      this.signerId,
      this.credential.publicKey,
    );
    assertRuntimePermission(
      freshKey.permission,
      this.identity.deployment.contract_id,
      this.lane === "operator" ? "town_source" : "town_merchant",
    );
    requireStorage(
      freshKey.nonce === key.nonce,
      "town key nonce changed before signing",
    );
    const signed = await signRestrictedTransaction({
      scope: this.lane === "operator" ? "town_source" : "town_merchant",
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
      gas: "100000000000000",
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
        wait_until: "NONE",
      });
      const returned = response as { transaction?: { hash?: unknown } };
      requireStorage(
        returned?.transaction?.hash === p.transactionHash,
        "town broadcast hash mismatch",
      );
      return { kind: "submitted", transactionHash: p.transactionHash };
    } catch {
      return { kind: "unknown", transactionHash: p.transactionHash };
    }
  }
}
