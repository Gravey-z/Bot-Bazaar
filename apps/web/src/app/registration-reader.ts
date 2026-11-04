import {
  MarketClient,
  createRpcTransport,
  parseU64,
  verifyFinalReceipt,
} from "@bot-bazaar/chain";
import type { MarketState, Player, Snapshot } from "@bot-bazaar/chain";
import type { PublicConfig } from "@bot-bazaar/shared";
import type { WalletContext } from "./wallet-context";
import type { PlayerMethod } from "./wallet-context";

export const registrationGas = "30000000000000";
export const purchaseGas = "30000000000000";
export class PurchaseNotOpenedError extends Error {
  constructor() {
    super("Purchase wallet request was not opened.");
  }
}
export class RegistrationNotOpenedError extends Error {
  constructor() {
    super("Registration wallet request was not opened.");
  }
}
export interface RegistrationObservation {
  readonly accountId: string;
  readonly market: Snapshot<MarketState>;
  readonly player: Snapshot<Player | null>;
  readonly receivedAt: number;
}
export type RegistrationReceipt =
  | { kind: "pending" | "unknown" | "succeeded" }
  | { kind: "failed"; code: string };
export interface RegistrationReads {
  read(accountId: string): Promise<RegistrationObservation>;
  receipt(context: WalletContext): Promise<RegistrationReceipt>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid registration evidence");
  return value as Record<string, unknown>;
}
export function walletTransactionHash(value: unknown): string | null {
  try {
    const hash = record(record(value)["transaction"])["hash"];
    return typeof hash === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)
      ? hash
      : null;
  } catch {
    return null;
  }
}
export function createRegistrationReads(
  config: PublicConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): RegistrationReads {
  return createPlayerReads(config, fetcher, now, "register_player");
}
export function createPurchaseReads(
  config: PublicConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): RegistrationReads {
  return createPlayerReads(config, fetcher, now, "buy_from_merchant");
}
function createPlayerReads(
  config: PublicConfig,
  fetcher: typeof fetch,
  now: () => number,
  method: PlayerMethod,
): RegistrationReads {
  const rpc = createRpcTransport(config.rpcUrl, fetcher);
  const client = new MarketClient(config.contractId, rpc);
  return {
    async read(accountId) {
      const reader = await client.finalized();
      const [market, player] = await Promise.all([
        reader.getMarketState(),
        reader.getPlayer(accountId),
      ]);
      if (market.market_revision !== player.market_revision)
        throw new Error("Inconsistent registration views");
      return { accountId, market, player, receivedAt: now() };
    },
    async receipt(context) {
      if (
        !context.transactionHash ||
        context.accountId === null ||
        context.contractId !== config.contractId ||
        context.networkId !== "testnet" ||
        context.call?.method !== method
      )
        return { kind: "unknown" };
      await client.finalized();
      const response = record(
        await rpc("tx", {
          tx_hash: context.transactionHash,
          sender_account_id: context.accountId,
          wait_until: "FINAL",
        }),
      );
      const tx = record(response["transaction"]);
      if (typeof tx["public_key"] !== "string")
        throw new Error("Missing transaction identity");
      const nonce =
        typeof tx["nonce"] === "number" && Number.isSafeInteger(tx["nonce"])
          ? String(tx["nonce"])
          : tx["nonce"];
      const status = await verifyFinalReceipt(response, {
        transactionHash: context.transactionHash,
        signerId: context.accountId,
        publicKey: tx["public_key"],
        nonce: parseU64(nonce),
        contractId: config.contractId,
        gas: method === "register_player" ? registrationGas : purchaseGas,
        method,
        args: context.call.args,
      });
      const recovered =
        context.transactionSource === "manual" ||
        context.transactionSource === "return";
      if (recovered && !context.referenceBlockHeight)
        return { kind: "unknown" };
      if (
        status.kind === "succeeded" &&
        context.referenceBlockHeight &&
        BigInt(status.result.block_height) <=
          BigInt(context.referenceBlockHeight)
      )
        throw new Error("Transaction predates the saved intent");
      // Untrusted failures can belong to another failed call with identical terms.
      if (status.kind === "failed" && recovered) return { kind: "unknown" };
      if (status.kind === "failed" && context.referenceBlockHeight) {
        const hash = record(response["transaction_outcome"])["block_hash"];
        if (typeof hash !== "string")
          throw new Error("Missing transaction block");
        const header = record(
          record(await rpc("block", { block_id: hash }))["header"],
        );
        const height =
          typeof header["height"] === "number" &&
          Number.isSafeInteger(header["height"])
            ? String(header["height"])
            : header["height"];
        if (
          header["hash"] !== hash ||
          BigInt(parseU64(height)) <= BigInt(context.referenceBlockHeight)
        )
          throw new Error("Transaction block mismatch");
      }
      if (status.kind !== "failed") return { kind: status.kind };
      // Only extract known codes after full final-receipt provenance checking.
      const failure = JSON.stringify(response["status"]);
      const code =
        [
          "E_ALREADY_REGISTERED",
          "E_PLAYER_CAPACITY",
          "E_MARKET_PAUSED",
          "E_RESERVED_ACCOUNT",
          "E_STALE_LISTING",
          "E_LISTING_INACTIVE",
          "E_INSUFFICIENT_STOCK",
          "E_INSUFFICIENT_GOLD",
          "E_NOT_REGISTERED",
          "E_INSUFFICIENT_LISTED_QUANTITY",
          "E_BALANCE_CAP",
        ].find((item) => failure.includes(`BB:${item}`)) ?? "EXECUTION_FAILED";
      return { kind: "failed", code };
    },
  };
}
