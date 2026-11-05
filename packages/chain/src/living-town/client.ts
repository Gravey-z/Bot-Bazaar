import type { RpcTransport } from "../rpc.js";
import { ChainRpcError, encodeArguments } from "../rpc.js";
import type { FinalizedBlock } from "../market-client.js";
import type { Decoder } from "../wire.js";
import {
  accountId,
  array,
  boolean,
  bounded,
  check,
  choice,
  hash32,
  nullable,
  object,
  parseU64,
  positiveU64,
  record,
  rpcU64,
} from "../wire.js";
import {
  decodeLivingTownSnapshot,
  livingTownSnapshot,
  livingTownFoundation,
  livingTownLedger,
  livingTownListing,
  livingTownOwnershipEffect,
  livingTownPlayer,
  livingTownPurchaseEffect,
  livingTownRawTrade,
  livingTownShop,
  livingTownTown,
  parseLivingTownDeployment,
} from "./wire.js";
import { decodeLivingTownBytes } from "./calls.js";
import { canonicalLivingTownJson } from "./json.js";
import { livingTownRecipeEntry } from "./recipes.js";
import { verifyLivingTownReceipt } from "./receipts.js";
import type { LivingTownReceiptStatus, LivingTownProof } from "./receipts.js";

export const parseLivingTownIdentity = object({
  deployment: parseLivingTownDeployment,
  codeHash: hash32,
  ownerId: accountId,
  operatorId: accountId,
  controllers: object({ rex: accountId, luna: accountId, bolt: accountId }),
});
export type LivingTownIdentity = ReturnType<typeof parseLivingTownIdentity>;
export class LivingTownIdentityError extends Error {}
function identityCheck(value: unknown, message: string): asserts value {
  if (!value) throw new LivingTownIdentityError(message);
}
export const livingTownPageArgs = object({
  after_id: nullable(parseU64),
  limit: bounded(1n, 50n),
  expected_market_revision: positiveU64,
});
export type LivingTownPageArgs = ReturnType<typeof livingTownPageArgs>;
const page = <T>(decode: Decoder<T>) =>
  object({
    items: array(decode, 50),
    next_after_id: nullable(parseU64),
    has_more: boolean,
    history_gap: boolean,
    pruned_through: parseU64,
  });
const listingsArgs = object({
  shop_id: nullable(positiveU64),
  item_id: nullable(
    choice([
      "crystal",
      "wood",
      "herb",
      "iron",
      "health_potion",
      "iron_tool",
    ] as const),
  ),
  active_only: boolean,
  ...{
    after_id: nullable(parseU64),
    limit: bounded(1n, 50n),
    expected_market_revision: positiveU64,
  },
});
const effect = (v: unknown) =>
  record(record(v)["outcome"])["kind"] === "raw_purchased"
    ? livingTownPurchaseEffect(v)
    : livingTownOwnershipEffect(v);
const commandLookup = (v: unknown) => {
  const kind = record(v)["kind"];
  if (kind === "found")
    return object({
      kind: choice(["found"] as const),
      high_water: positiveU64,
      method: choice([
        "register_player",
        "create_shop",
        "rename_shop",
        "buy_from_merchant",
      ] as const),
      payload_sha256: (v: unknown) => {
        check(
          typeof v === "string" && /^[0-9a-f]{64}$/.test(v),
          "invalid digest",
        );
        return v;
      },
      effect,
    })(v);
  if (kind === "pruned")
    return object({
      kind: choice(["pruned"] as const),
      high_water: positiveU64,
      sequence: positiveU64,
    })(v);
  return object({
    kind: choice(["not_applied"] as const),
    high_water: parseU64,
    next_sequence: positiveU64,
  })(v);
};
type Snapshot<T> = ReturnType<ReturnType<typeof livingTownSnapshot<T>>>;
type Page<T> = {
  items: T[];
  next_after_id: ReturnType<typeof parseU64> | null;
  has_more: boolean;
  history_gap: boolean;
  pruned_through: ReturnType<typeof parseU64>;
};
const tradeLookup = (v: unknown) =>
  record(v)["kind"] === "found"
    ? object({ kind: choice(["found"] as const), value: livingTownRawTrade })(v)
    : object({
        kind: choice(["pruned", "not_found"] as const),
        id: positiveU64,
      })(v);
export class FinalizedLivingTownReader {
  constructor(
    private readonly rpc: RpcTransport,
    readonly identity: LivingTownIdentity,
    readonly block: FinalizedBlock,
  ) {}
  async query(
    requestType: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const r = record(
      await this.rpc("query", {
        ...extra,
        request_type: requestType,
        account_id: this.identity.deployment.contract_id,
        block_id: this.block.hash,
      }),
    );
    check(
      r["block_hash"] === this.block.hash &&
        rpcU64(r["block_height"]) === this.block.height,
      "V2 query block mismatch",
    );
    return r;
  }
  private async view<T>(method: string, args: unknown, decode: Decoder<T>) {
    const r = await this.query("call_function", {
      method_name: method,
      args_base64: encodeArguments(args),
    });
    const value = decodeLivingTownBytes(r["result"]);
    identityCheck(
      canonicalLivingTownJson(record(value)["deployment"]) ===
        canonicalLivingTownJson(this.identity.deployment),
      "V2 snapshot deployment mismatch",
    );
    const result = decodeLivingTownSnapshot(
      value,
      this.identity.deployment,
      decode,
    );
    check(
      result.block_height === this.block.height &&
        result.block_timestamp_ns === this.block.timestampNs,
      "V2 snapshot block mismatch",
    );
    return result;
  }
  getTown(): Promise<Snapshot<ReturnType<typeof livingTownTown>>> {
    return this.view("get_town", {}, livingTownTown);
  }
  getFoundation(): Promise<Snapshot<ReturnType<typeof livingTownFoundation>>> {
    return this.view("get_foundation", {}, livingTownFoundation);
  }
  async getPlayer(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof livingTownPlayer> | null>> {
    const account = accountId(id),
      r = await this.view(
        "get_player",
        { account_id: account },
        nullable(livingTownPlayer),
      );
    check(
      r.data === null || r.data.account_id === account,
      "V2 player identity mismatch",
    );
    return r;
  }
  async getShop(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof livingTownShop> | null>> {
    const shop = positiveU64(id),
      r = await this.view(
        "get_shop",
        { shop_id: shop },
        nullable(livingTownShop),
      );
    check(
      r.data === null || r.data.shop_id === shop,
      "V2 shop identity mismatch",
    );
    return r;
  }
  async getShopInventory(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof livingTownLedger>>> {
    const shop = await this.getShop(id);
    check(shop.data, "V2 missing shop");
    const r = await this.view(
      "get_shop_inventory",
      { shop_id: positiveU64(id) },
      livingTownLedger,
    );
    check(
      r.market_revision === shop.market_revision &&
        canonicalLivingTownJson(r.data.actor) ===
          canonicalLivingTownJson(shop.data.owner),
      "V2 shop ledger identity mismatch",
    );
    return r;
  }
  async getPlayerShops(
    id: string,
    input: unknown,
  ): Promise<Snapshot<Page<ReturnType<typeof livingTownShop>>>> {
    const account = accountId(id),
      args = livingTownPageArgs(input),
      r = await this.view(
        "get_player_shops",
        { account_id: account, ...args },
        page(livingTownShop),
      );
    this.checkPage(r, args, (x) => x.shop_id);
    check(
      r.data.items.length <= 1 &&
        r.data.items.every(
          (s) => s.owner.kind === "player" && s.owner.account_id === account,
        ),
      "V2 owner filter mismatch",
    );
    return r;
  }
  async getListings(
    input: unknown,
  ): Promise<Snapshot<Page<ReturnType<typeof livingTownListing>>>> {
    const args = listingsArgs(input),
      r = await this.view("get_listings", args, page(livingTownListing));
    this.checkPage(r, args, (x) => x.listing_id);
    check(
      r.data.items.every(
        (l) =>
          (args.shop_id === null || l.shop_id === args.shop_id) &&
          (args.item_id === null || l.item_id === args.item_id) &&
          (!args.active_only || l.active),
      ),
      "V2 listing filter mismatch",
    );
    return r;
  }
  async getRecipes(
    input: unknown,
  ): Promise<Snapshot<Page<ReturnType<typeof livingTownRecipeEntry>>>> {
    const args = livingTownPageArgs(input),
      r = await this.view("get_recipes", args, page(livingTownRecipeEntry));
    this.checkPage(r, args, (row) => row.recipe_entry_id);
    return r;
  }
  async getTrade(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof tradeLookup>>> {
    const parsed = positiveU64(id);

    const r = await this.view("get_trade", { trade_id: parsed }, tradeLookup);
    check(
      (r.data.kind === "found" ? r.data.value.trade_id : r.data.id) === parsed,
      "V2 trade identity mismatch",
    );
    return r;
  }
  async getCommand(
    account: string,
    sequence: string,
  ): Promise<Snapshot<ReturnType<typeof commandLookup>>> {
    const principal = `account:${accountId(account)}`,
      seq = positiveU64(sequence),
      r = await this.view(
        "get_command",
        { principal, sequence: seq },
        commandLookup,
      );
    const d = r.data;
    if (d.kind === "found")
      check(
        d.high_water === seq &&
          d.effect.principal === principal &&
          d.effect.command_sequence === seq &&
          d.effect.payload_sha256 === d.payload_sha256 &&
          d.method ===
            (
              {
                player_registered: "register_player",
                shop_created: "create_shop",
                shop_renamed: "rename_shop",
                raw_purchased: "buy_from_merchant",
              } as const
            )[d.effect.outcome.kind],
        "V2 command lookup mismatch",
      );
    if (d.kind === "pruned")
      check(
        d.sequence === seq && BigInt(seq) < BigInt(d.high_water),
        "V2 pruned command mismatch",
      );
    if (d.kind === "not_applied")
      check(
        BigInt(seq) > BigInt(d.high_water) &&
          BigInt(d.next_sequence) === BigInt(d.high_water) + 1n,
        "V2 command high-water mismatch",
      );
    return r;
  }
  private checkPage<T>(
    r: {
      market_revision: string;
      data: {
        items: T[];
        next_after_id: string | null;
        has_more: boolean;
        history_gap: boolean;
        pruned_through: string;
      };
    },
    args: LivingTownPageArgs,
    id: (v: T) => string,
  ) {
    check(
      r.market_revision === args.expected_market_revision &&
        r.data.items.length <= Number(args.limit) &&
        !r.data.history_gap &&
        r.data.pruned_through === "0",
      "V2 page revision/bound mismatch",
    );
    let last: string | null = args.after_id;
    for (const row of r.data.items) {
      const next = id(row);
      check(last === null || BigInt(next) > BigInt(last), "V2 unordered page");
      last = next;
    }
    check(
      r.data.next_after_id === last &&
        (!r.data.has_more || r.data.items.length > 0),
      "V2 cursor mismatch",
    );
  }
}
export class LivingTownClient {
  readonly identity: LivingTownIdentity;
  constructor(
    identity: unknown,
    private readonly rpc: RpcTransport,
  ) {
    const i = parseLivingTownIdentity(identity);
    this.identity = Object.freeze({
      ...i,
      deployment: Object.freeze(i.deployment),
      controllers: Object.freeze(i.controllers),
    });
  }
  private async network() {
    const s = record(await this.rpc("status", {}));
    identityCheck(
      s["chain_id"] === "testnet" &&
        record(s["sync_info"])["syncing"] === false,
      "V2 network unavailable/mismatched",
    );
    const cfg = record(await this.rpc("EXPERIMENTAL_genesis_config", []));
    identityCheck(cfg["chain_id"] === "testnet", "V2 genesis network mismatch");
    const height = rpcU64(cfg["genesis_height"]);
    check(
      BigInt(height) <= BigInt(Number.MAX_SAFE_INTEGER),
      "unsafe genesis height",
    );
    const genesis = record(
      record(await this.rpc("block", { block_id: Number(height) }))["header"],
    );
    identityCheck(
      rpcU64(genesis["height"]) === height &&
        hash32(genesis["hash"]) === this.identity.deployment.genesis_hash,
      "V2 genesis mismatch",
    );
  }
  async block(hash?: string): Promise<FinalizedBlock> {
    const h = record(
      record(
        await this.rpc(
          "block",
          hash ? { block_id: hash32(hash) } : { finality: "final" },
        ),
      )["header"],
    );
    const block = Object.freeze({
      hash: hash32(h["hash"]),
      height: rpcU64(h["height"]),
      timestampNs: parseU64(h["timestamp_nanosec"]),
    });
    check(!hash || block.hash === hash, "V2 block identity mismatch");
    return block;
  }
  private async at(block: FinalizedBlock) {
    const r = new FinalizedLivingTownReader(this.rpc, this.identity, block);
    const account = await r.query("view_account");
    identityCheck(
      account["code_hash"] === this.identity.codeHash,
      "V2 deployed code mismatch",
    );
    const f = await r.getFoundation(),
      d = f.data,
      i = this.identity;
    identityCheck(
      d.owner_account_id === i.ownerId &&
        d.operator_account_id === i.operatorId &&
        canonicalLivingTownJson(d.merchant_controllers) ===
          canonicalLivingTownJson(i.controllers),
      "V2 authority mismatch",
    );
    return r;
  }
  async finalized(): Promise<FinalizedLivingTownReader> {
    await this.network();
    return this.at(await this.block());
  }
  async receipt(proof: LivingTownProof): Promise<LivingTownReceiptStatus> {
    return (await this.receiptEvidence(proof)).status;
  }
  async receiptEvidence(
    proof: LivingTownProof,
  ): Promise<{ status: LivingTownReceiptStatus; response: unknown }> {
    await this.network();
    check(
      canonicalLivingTownJson(proof.deployment) ===
        canonicalLivingTownJson(this.identity.deployment),
      "V2 receipt deployment mismatch",
    );
    let response;
    try {
      response = await this.rpc("tx", {
        tx_hash: hash32(proof.transactionHash),
        sender_account_id: accountId(proof.signerId),
        wait_until: "FINAL",
      });
    } catch (e) {
      if (e instanceof ChainRpcError && e.code === "UNKNOWN_TRANSACTION")
        return {
          status: {
            kind: "unknown" as const,
            transactionHash: proof.transactionHash,
          },
          response: null,
        };
      throw e;
    }
    const finalized = await this.block();
    const status = await verifyLivingTownReceipt(
      response,
      proof,
      async (hash) => {
        const b = await this.block(hash);
        check(
          BigInt(b.height) <= BigInt(finalized.height),
          "V2 receipt beyond finalized head",
        );
        await this.at(b);
        return b;
      },
    );
    return { status, response };
  }
}
