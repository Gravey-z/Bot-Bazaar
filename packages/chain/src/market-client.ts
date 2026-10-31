import type { MerchantId } from "@bot-bazaar/shared";
import { decodeBytes, encodeArguments } from "./rpc.js";
import type { RpcTransport } from "./rpc.js";
import {
  accountId,
  bounded,
  check,
  choice,
  hash32,
  market,
  merchant,
  nullable,
  object,
  offer,
  offerLookup,
  page,
  parseU64,
  player,
  positiveU64,
  publicKey,
  record,
  rpcU64,
  snapshot,
  trade,
} from "./wire.js";
import type {
  Decoder,
  MarketState,
  Snapshot,
  U64,
  Page,
  Offer,
  Trade,
} from "./wire.js";

export interface FinalizedBlock {
  readonly hash: string;
  readonly height: U64;
  readonly timestampNs: U64;
}
export interface DeploymentIdentity {
  readonly networkId: "testnet";
  readonly contractId: string;
  readonly ownerId: string;
  readonly codeHash: string;
  readonly controllers: Readonly<Record<MerchantId, string>>;
}
export interface PageArgs {
  after_id: string | null;
  limit: string;
  expected_revision: string | null;
}
const pageArgs = object({
  after_id: nullable(parseU64),
  limit: bounded(1n, 50n),
  expected_revision: nullable(parseU64),
});

export class FinalizedMarketReader {
  constructor(
    readonly transport: RpcTransport,
    readonly contractId: string,
    readonly block: FinalizedBlock,
  ) {}

  async query(
    requestType: string,
    account: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    accountId(account);
    const result = record(
      await this.transport("query", {
        ...extra,
        request_type: requestType,
        account_id: account,
        block_id: this.block.hash,
      }),
    );
    check(
      result["block_hash"] === this.block.hash &&
        rpcU64(result["block_height"]) === this.block.height,
      "query block mismatch",
    );
    return result;
  }

  private async view<T>(
    method: string,
    args: unknown,
    decode: Decoder<T>,
  ): Promise<Snapshot<T>> {
    const response = await this.query("call_function", this.contractId, {
      method_name: method,
      args_base64: encodeArguments(args),
    });
    const result = snapshot(decode)(decodeBytes(response["result"]));
    check(
      result.block_height === this.block.height &&
        result.block_timestamp_ns === this.block.timestampNs,
      "view snapshot block mismatch",
    );
    return result;
  }

  async getMarketState(): Promise<Snapshot<MarketState>> {
    const result = await this.view("get_market_state", {}, market);
    check(
      result.data.contract_account_id === this.contractId &&
        result.data.merchants.length === 3 &&
        result.data.merchants.every(
          (row, index) => row.merchant_id === ["rex", "luna", "bolt"][index],
        ),
      "market identity/order mismatch",
    );
    return result;
  }
  async getPlayer(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof player> | null>> {
    const result = await this.view(
      "get_player",
      { account_id: accountId(id) },
      nullable(player),
    );
    check(
      result.data === null || result.data.account_id === id,
      "player identity mismatch",
    );
    return result;
  }
  async getMerchant(
    id: MerchantId,
  ): Promise<Snapshot<ReturnType<typeof merchant>>> {
    const parsed = choice(["rex", "luna", "bolt"] as const)(id);
    const result = await this.view(
      "get_merchant",
      { merchant_id: parsed },
      merchant,
    );
    check(result.data.merchant_id === parsed, "merchant identity mismatch");
    return result;
  }
  async getOffer(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof offerLookup>>> {
    const parsed = positiveU64(id);
    const result = await this.view(
      "get_offer",
      { offer_id: parsed },
      offerLookup,
    );
    check(
      (result.data.kind === "found"
        ? result.data.offer.offer_id
        : result.data.offer_id) === parsed,
      "offer identity mismatch",
    );
    return result;
  }
  async getOffersForMerchant(
    id: MerchantId,
    status: "all" | "pending" | "terminal",
    args: PageArgs,
  ): Promise<Snapshot<Page<Offer>>> {
    const merchantId = choice(["rex", "luna", "bolt"] as const)(id);
    const filter = choice(["all", "pending", "terminal"] as const)(status);
    const request = pageArgs(args);
    const result = await this.view(
      "get_offers_for_merchant",
      { merchant_id: merchantId, status: filter, ...request },
      page(offer),
    );
    this.checkPage(result, request, (row) => row.offer_id);
    check(
      result.data.items.every(
        (row) =>
          [row.buyer, row.seller].includes(merchantId) &&
          (filter === "all" ||
            (filter === "pending"
              ? row.status === "pending"
              : row.status !== "pending")),
      ),
      "offer filter mismatch",
    );
    return result;
  }
  async getRecentTrades(args: PageArgs): Promise<Snapshot<Page<Trade>>> {
    const request = pageArgs(args);
    const result = await this.view("get_recent_trades", request, page(trade));
    this.checkPage(result, request, (row) => row.trade_id);
    return result;
  }
  private checkPage<T>(
    result: Snapshot<{
      items: T[];
      next_after_id: U64 | null;
      has_more: boolean;
    }>,
    args: PageArgs,
    getId: (row: T) => U64,
  ): void {
    check(
      args.expected_revision === null ||
        result.market_revision === args.expected_revision,
      "page revision mismatch",
    );
    check(
      result.data.items.length <= Number(args.limit),
      "page exceeds requested limit",
    );
    let previous = args.after_id;
    for (const row of result.data.items) {
      const id = getId(row);
      check(
        previous === null || BigInt(id) > BigInt(previous),
        "unordered page",
      );
      previous = id;
    }
    check(
      result.data.next_after_id === previous &&
        (!result.data.has_more || result.data.items.length > 0),
      "page cursor mismatch",
    );
  }
  async getAccessKey(
    account: string,
    key: string,
  ): Promise<{
    nonce: U64;
    permission: unknown;
    block_hash: string;
    block_height: U64;
  }> {
    const result = await this.query("view_access_key", account, {
      public_key: publicKey(key),
    });
    return {
      nonce: rpcU64(result["nonce"]),
      permission: result["permission"],
      block_hash: this.block.hash,
      block_height: this.block.height,
    };
  }
}

export class MarketClient {
  constructor(
    readonly contractId: string,
    readonly transport: RpcTransport,
  ) {
    accountId(contractId);
    check(contractId.endsWith(".testnet"), "contract must be on Testnet");
  }
  async finalized(): Promise<FinalizedMarketReader> {
    const status = record(await this.transport("status", {}));
    check(
      status["chain_id"] === "testnet" &&
        record(status["sync_info"])["syncing"] === false,
      "network unavailable or mismatched",
    );
    const header = record(
      record(await this.transport("block", { finality: "final" }))["header"],
    );
    const block = Object.freeze({
      hash: hash32(header["hash"]),
      height: rpcU64(header["height"]),
      timestampNs: parseU64(header["timestamp_nanosec"]),
    });
    return new FinalizedMarketReader(this.transport, this.contractId, block);
  }
  async verifyDeployment(
    identity: DeploymentIdentity,
  ): Promise<{ reader: FinalizedMarketReader; market: Snapshot<MarketState> }> {
    check(
      identity.networkId === "testnet" &&
        identity.contractId === this.contractId,
      "deployment network/contract mismatch",
    );
    hash32(identity.codeHash);
    accountId(identity.ownerId);
    const controllers = ["rex", "luna", "bolt"].map((id) =>
      accountId(identity.controllers[id as MerchantId]),
    );
    check(
      new Set(controllers).size === 3 &&
        controllers.every(
          (id) => id !== identity.ownerId && id !== identity.contractId,
        ),
      "invalid controller mapping",
    );
    const reader = await this.finalized();
    const account = await reader.query("view_account", this.contractId);
    check(account["code_hash"] === identity.codeHash, "deployed code mismatch");
    const market = await reader.getMarketState();
    check(
      market.data.owner_account_id === identity.ownerId &&
        market.data.merchants.every(
          (row, index) => row.controller_account_id === controllers[index],
        ),
      "deployment owner/controller mismatch",
    );
    return { reader, market };
  }
}
