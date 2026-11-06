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
  canonicalLivingTownJson,
  parseU64,
} from "@bot-bazaar/chain";
import type {
  LivingTownIdentity,
  LivingTownProof,
  LivingTownCall,
  RpcTransport,
} from "@bot-bazaar/chain";
import type { MerchantCredential, Submission } from "../chain-adapter.js";
import {
  assertRuntimePermission,
  signRestrictedTransaction,
} from "../near-signer.js";
import { requireStorage, sha256 } from "../storage/validation.js";

export type CustomerCall = LivingTownCall & {
  method: "fund_customer_budget" | "settle_customer_purchase";
};
export interface PreparedCustomerCall extends LivingTownProof {
  call: CustomerCall;
  publicKey: string;
  nonce: string;
  gas: string;
  signedTransactionBase64: string;
}
export function customerCall(method: string, args: unknown): CustomerCall {
  requireStorage(
    method === "fund_customer_budget" || method === "settle_customer_purchase",
    "customer method outside scope",
  );
  return { ...createLivingTownCall(method, args), method };
}
export function readCustomerPrepared(
  text: string,
  identity: LivingTownIdentity,
): PreparedCustomerCall {
  requireStorage(
    Buffer.byteLength(text) <= 65536,
    "oversized signed customer transaction",
  );
  const p = JSON.parse(text) as PreparedCustomerCall;
  const call = customerCall(p.call.method, p.call.args);
  const tx = SignedTransaction.decode(
    Buffer.from(p.signedTransactionBase64, "base64"),
  ).transaction;
  const action = tx.actions[0]?.functionCall;
  requireStorage(
    canonicalLivingTownJson(p.deployment) ===
      canonicalLivingTownJson(identity.deployment) &&
      p.signerId === identity.operatorId &&
      tx.signerId === p.signerId &&
      tx.receiverId === identity.deployment.contract_id &&
      tx.publicKey.toString() === p.publicKey &&
      p.publicKey.startsWith("ed25519:") &&
      tx.nonce.toString() === parseU64(p.nonce) &&
      p.transactionHash === baseEncode(Buffer.from(sha256(tx.encode()), "hex")),
    "customer signed identity mismatch",
  );
  requireStorage(
    tx.actions.length === 1 &&
      action?.methodName === call.method &&
      action.deposit === 0n &&
      action.gas.toString() === parseU64(p.gas) &&
      action.gas > 0n &&
      action.gas <= 300000000000000n &&
      canonicalLivingTownJson(
        customerCall(
          call.method,
          JSON.parse(Buffer.from(action.args).toString("utf8")),
        ).args,
      ) === canonicalLivingTownJson(call.args) &&
      parseU64(p.referenceBlockHeight) !== "0",
    "customer signed terms mismatch",
  );
  return { ...p, call };
}

/** Restricted adapter; invocation belongs exclusively to the shared journal processor. */
export class CustomerChainAdapter {
  readonly client: LivingTownClient;
  readonly identity: LivingTownIdentity;
  private readonly credential: MerchantCredential;
  constructor(
    identity: unknown,
    private readonly rpc: RpcTransport,
    credential: MerchantCredential,
  ) {
    this.client = new LivingTownClient(identity, rpc);
    this.identity = this.client.identity;
    requireStorage(
      PublicKey.fromString(credential.publicKey)
        .toString()
        .startsWith("ed25519:"),
      "customer runtime key must be ed25519",
    );
    this.credential = Object.freeze({ ...credential });
  }
  async prepare(
    call: CustomerCall,
    beforeSign: () => Promise<void>,
  ): Promise<PreparedCustomerCall> {
    call = customerCall(call.method, call.args);
    const reader = await this.client.finalized();
    const key = await reader.getAccessKey(
      this.identity.operatorId,
      this.credential.publicKey,
    );
    assertRuntimePermission(
      key.permission,
      this.identity.deployment.contract_id,
      "customer",
    );
    const tx = createTransaction(
      this.identity.operatorId,
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
      this.identity.operatorId,
      this.credential.publicKey,
    );
    assertRuntimePermission(
      freshKey.permission,
      this.identity.deployment.contract_id,
      "customer",
    );
    requireStorage(
      freshKey.nonce === key.nonce,
      "customer key nonce changed before signing",
    );
    const signed = await signRestrictedTransaction({
      scope: "customer",
      networkId: "testnet",
      controllerId: this.identity.operatorId,
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
      signerId: this.identity.operatorId,
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
  async submit(value: PreparedCustomerCall): Promise<Submission> {
    const p = readCustomerPrepared(JSON.stringify(value), this.identity);
    try {
      const response = await this.rpc("send_tx", {
        signed_tx_base64: p.signedTransactionBase64,
        wait_until: "NONE",
      });
      const returned = response as { transaction?: { hash?: unknown } };
      requireStorage(
        returned?.transaction?.hash === p.transactionHash,
        "customer broadcast hash mismatch",
      );
      return { kind: "submitted", transactionHash: p.transactionHash };
    } catch {
      return { kind: "unknown", transactionHash: p.transactionHash };
    }
  }
}
