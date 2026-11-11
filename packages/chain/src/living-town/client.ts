import {
  livingTownMarketEventEffect,
  livingTownMarketEventHistory,
} from "./market-events.js";
import { livingTownOfferFoundationMethods } from "@bot-bazaar/shared";
import {
  livingTownOfferEffect,
  livingTownMerchantTrade,
  livingTownOfferLookup,
  livingTownOfferPage,
  livingTownOfferPageArgs,
  livingTownTradingRules,
  offerMerchants,
} from "./offers.js";
import {
  livingTownAssistantPolicy,
  livingTownAssistantPolicyEffect,
  livingTownAssistantRepriceEffect,
} from "./assistant-policy.js";
import { livingTownSourceEffect, livingTownSourceState } from "./sources.js";
import {
  livingTownCustomerEffect,
  livingTownCustomerTrade,
} from "./customers.js";
import { livingTownListingEffect } from "./listings.js";
import {
  livingTownProductionEffect,
  livingTownProductionJob,
} from "./production.js";
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
  publicKey,
} from "../wire.js";
import {
  decodeLivingTownSnapshot,
  livingTownSnapshot,
  livingTownFoundation,
  livingTownLedger,
  livingTownUpgrade,
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
import { verifyLivingTownCompletionReceipt } from "./completion.js";
import type {
  LivingTownCompletionProof,
  LivingTownCompletionStatus,
} from "./completion.js";
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
  [
    "trade_proposed",
    "trade_accepted",
    "trade_rejected",
    "trade_cancelled",
    "offers_expired",
  ].includes(String(record(record(v)["outcome"])["kind"]))
    ? livingTownOfferEffect(v)
    : record(record(v)["outcome"])["kind"] === "assistant_repriced"
      ? livingTownAssistantRepriceEffect(v)
      : record(record(v)["outcome"])["kind"] === "assistant_policy_set"
        ? livingTownAssistantPolicyEffect(v)
        : record(record(v)["outcome"])["kind"] === "market_event_scheduled"
          ? livingTownMarketEventEffect(v)
          : ["raw_supplied", "raw_supplies", "treasury_swept"].includes(
                String(record(record(v)["outcome"])["kind"]),
              )
            ? livingTownSourceEffect(v)
            : ["customer_funded", "customer_sale"].includes(
                  String(record(record(v)["outcome"])["kind"]),
                )
              ? livingTownCustomerEffect(v)
              : ["listing_set", "listing_cancelled"].includes(
                    String(record(record(v)["outcome"])["kind"]),
                  )
                ? livingTownListingEffect(v)
                : record(record(v)["outcome"])["kind"] === "production_started"
                  ? livingTownProductionEffect(v)
                  : record(record(v)["outcome"])["kind"] === "raw_purchased"
                    ? livingTownPurchaseEffect(v)
                    : livingTownOwnershipEffect(v);
const commandLookup = (v: unknown) => {
  const kind = record(v)["kind"];
  if (kind === "found")
    return object({
      kind: choice(["found"] as const),
      high_water: positiveU64,
      method: choice([
        "propose_trade",
        "accept_trade",
        "reject_trade",
        "cancel_trade",
        "expire_offers",
        "purchase_upgrade",
        "assistant_reprice",
        "set_assistant_permissions",
        "schedule_market_event",
        "allocate_raw_supply",
        "sweep_merchant_treasury",
        "fund_customer_budget",
        "settle_customer_purchase",
        "set_listing",
        "cancel_listing",
        "start_production",
        "register_player",
        "create_shop",
        "rename_shop",
        "buy_from_merchant",
        "merchant_purchase",
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
    ? object({
        kind: choice(["found"] as const),
        value: (v: unknown) =>
          record(v)["kind"] === "customer_sale"
            ? livingTownCustomerTrade(v)
            : record(v)["kind"] === "merchant_trade"
              ? livingTownMerchantTrade(v)
              : livingTownRawTrade(v),
      })(v)
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
  async getAccessKey(
    account: string,
    key: string,
  ): Promise<{
    nonce: string;
    permission: unknown;
    block_hash: string;
    block_height: string;
  }> {
    // query() pins contract views; access-key queries deliberately target the signer.
    const r = record(
      await this.rpc("query", {
        request_type: "view_access_key",
        account_id: accountId(account),
        public_key: publicKey(key),
        block_id: this.block.hash,
      }),
    );
    check(
      r["block_hash"] === this.block.hash &&
        rpcU64(r["block_height"]) === this.block.height,
      "V2 access-key block mismatch",
    );
    return {
      nonce: rpcU64(r["nonce"]),
      permission: r["permission"],
      block_hash: this.block.hash,
      block_height: this.block.height,
    };
  }
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
  getMarketEvents(): Promise<
    Snapshot<ReturnType<typeof livingTownMarketEventHistory>>
  > {
    return this.view("get_market_events", {}, livingTownMarketEventHistory);
  }
  getSourceState(): Promise<
    Snapshot<ReturnType<typeof livingTownSourceState>>
  > {
    return this.view("get_source_state", {}, livingTownSourceState);
  }
  getTown(): Promise<Snapshot<ReturnType<typeof livingTownTown>>> {
    return this.view("get_town", {}, livingTownTown);
  }
  async getFoundation(): Promise<
    Snapshot<ReturnType<typeof livingTownFoundation>>
  > {
    const f = await this.view("get_foundation", {}, livingTownFoundation);
    check(
      (f.data.supported_methods.join() ===
        livingTownOfferFoundationMethods.join()) ===
        (this.identity.deployment.state_schema === "2"),
      "foundation/state schema capability mismatch",
    );
    return f;
  }
  async getMerchantTradingRules(): Promise<
    Snapshot<ReturnType<typeof livingTownTradingRules>>
  > {
    const f = await this.getFoundation();
    check(
      this.identity.deployment.state_schema === "2" &&
        f.data.supported_methods.includes("get_merchant_trading_rules"),
      "merchant offers unavailable",
    );
    const result = await this.view(
      "get_merchant_trading_rules",
      {},
      livingTownTradingRules,
    );
    return result;
  }
  async getOffer(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof livingTownOfferLookup>>> {
    check(
      this.identity.deployment.state_schema === "2",
      "merchant offers unavailable",
    );
    const r = await this.view(
      "get_offer",
      { offer_id: positiveU64(id) },
      livingTownOfferLookup,
    );
    check(
      (r.data.kind === "found" ? r.data.offer.offer_id : r.data.offer_id) ===
        id,
      "offer lookup identity mismatch",
    );
    if (r.data.kind === "found")
      this.offerTime(r.data.offer, r.block_timestamp_ns);
    return r;
  }
  private offerTime(
    o: ReturnType<typeof import("./offers.js").livingTownOffer>,
    at: string,
  ) {
    check(
      BigInt(o.created_at_ns) <= BigInt(at) &&
        (o.closed_at_ns === null || BigInt(o.closed_at_ns) <= BigInt(at)) &&
        o.expired ===
          (o.status === "expired" ||
            (o.status === "pending" && BigInt(at) >= BigInt(o.expires_at_ns))),
      "offer snapshot time mismatch",
    );
  }
  async getOffers(
    input: unknown,
  ): Promise<Snapshot<ReturnType<typeof livingTownOfferPage>>> {
    check(
      this.identity.deployment.state_schema === "2",
      "merchant offers unavailable",
    );
    const args = livingTownOfferPageArgs(input),
      r = await this.view("get_offers", args, livingTownOfferPage);
    check(
      r.market_revision === args.expected_market_revision &&
        r.data.items.length <= Number(args.limit),
      "offer page revision/bound mismatch",
    );
    let last = args.after_id;
    for (const o of r.data.items) {
      check(
        last === null || BigInt(o.offer_id) > BigInt(last),
        "unordered offer page",
      );
      last = o.offer_id;
    }
    check(
      r.data.next_after_id === (r.data.items.at(-1)?.offer_id ?? null) &&
        (!r.data.has_more || r.data.items.length > 0),
      "offer page cursor mismatch",
    );
    check(
      r.data.history_gap ===
        BigInt(r.data.pruned_through) > BigInt(args.after_id ?? "0"),
      "offer gap watermark mismatch",
    );
    for (const o of r.data.items) {
      this.offerTime(o, r.block_timestamp_ns);
      check(
        (args.merchant_id === null ||
          [o.buyer, o.seller].includes(args.merchant_id)) &&
          (args.status === "all" ||
            (args.status === "pending") === (o.status === "pending")),
        "offer page filter mismatch",
      );
    }
    return r;
  }
  async getPendingMerchantOffers(): Promise<{
    town: Awaited<ReturnType<FinalizedLivingTownReader["getTown"]>>;
    rules: Awaited<
      ReturnType<FinalizedLivingTownReader["getMerchantTradingRules"]>
    >;
    offers: ReturnType<typeof import("./offers.js").livingTownOffer>[];
  }> {
    const rules = await this.getMerchantTradingRules(),
      town = await this.getTown();
    const offers: ReturnType<typeof import("./offers.js").livingTownOffer>[] =
      [];
    let after: string | null = null;
    for (let n = 0; n < 3; n++) {
      const p = await this.getOffers({
        merchant_id: null,
        status: "pending",
        after_id: after,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      check(
        p.market_revision === town.market_revision,
        "mixed offer checkpoint",
      );
      offers.push(...p.data.items);
      check(
        offers.length <= 12 &&
          new Set(offers.map((o) => o.offer_id)).size === offers.length,
        "pending offer capacity/duplicates",
      );
      if (!p.data.has_more) {
        for (const m of offerMerchants) {
          const owned = offers.filter((o) => o.buyer === m);
          const ledger = town.data.npc_ledgers[offerMerchants.indexOf(m)]!;
          check(
            offers.filter((o) => o.buyer === m || o.seller === m).length <= 8 &&
              BigInt(ledger.gold.trade_reserved) ===
                owned.reduce((s, o) => s + BigInt(o.total_price), 0n),
            "pending gold/count reconciliation mismatch",
          );
          for (const item of [
            "crystal",
            "wood",
            "herb",
            "iron",
            "health_potion",
            "iron_tool",
          ] as const)
            check(
              BigInt(ledger.inventory.trade_inbound_reserved[item]) ===
                owned
                  .filter((o) => o.item_id === item)
                  .reduce((s, o) => s + BigInt(o.quantity), 0n),
              "pending inbound reconciliation mismatch",
            );
        }
        return { town, rules, offers };
      }
      check(
        p.data.next_after_id !== null && p.data.next_after_id !== after,
        "offer cursor stalled",
      );
      after = p.data.next_after_id;
    }
    throw new Error("incomplete pending offer checkpoint");
  }
  async getUpgrade(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof livingTownUpgrade>>> {
    const shopId = positiveU64(id),
      foundation = await this.getFoundation();
    check(
      foundation.data.supported_methods.includes("get_upgrade"),
      "upgrade unsupported by this artifact",
    );
    const shop = await this.getShop(shopId),
      result = await this.view(
        "get_upgrade",
        { shop_id: shopId },
        livingTownUpgrade,
      );
    check(
      shop.data?.owner.kind === "player" &&
        result.data.shop_id === shopId &&
        result.data.shop_revision === shop.data.revision &&
        result.data.production_slots === shop.data.production_slots &&
        (!result.data.eligible ||
          (result.data.completed_both &&
            result.data.sold_both &&
            result.data.production_slots === "1")),
      "upgrade finalized identity/revision mismatch",
    );
    return result;
  }
  async getAssistantPolicy(
    id: string,
  ): Promise<Snapshot<ReturnType<typeof livingTownAssistantPolicy>>> {
    const shopId = positiveU64(id),
      foundation = await this.getFoundation();
    check(
      foundation.data.supported_methods.includes("get_assistant_policy"),
      "assistant policy unsupported by this artifact",
    );
    const shop = await this.getShop(shopId),
      policy = await this.view(
        "get_assistant_policy",
        { shop_id: shopId },
        livingTownAssistantPolicy,
      );
    check(
      shop.data?.owner.kind === "player" &&
        policy.data.shop_id === shopId &&
        policy.data.revision === shop.data.policy_revision &&
        (policy.data.mode !== "auto_reprice" ||
          policy.data.operator_account_id ===
            foundation.data.operator_account_id),
      "assistant policy finalized identity/revision mismatch",
    );
    return policy;
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
  async getProductionJobs(
    input: unknown,
  ): Promise<Snapshot<Page<ReturnType<typeof livingTownProductionJob>>>> {
    const args = object({
      shop_id: positiveU64,
      status: choice(["all", "running", "completed"] as const),
      ...{
        after_id: nullable(parseU64),
        limit: bounded(1n, 50n),
        expected_market_revision: positiveU64,
      },
    })(input);
    const r = await this.view(
      "get_production_jobs",
      args,
      page(livingTownProductionJob),
    );
    this.checkPage(r, args, (j) => j.job_id, true);
    check(
      r.data.history_gap === BigInt(r.data.pruned_through) > 0n,
      "Production history gap mismatch",
    );
    check(
      r.data.items.every(
        (j) =>
          j.shop_id === args.shop_id &&
          (args.status === "all" || j.status === args.status),
      ),
      "Production filter mismatch",
    );
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
    const principal = account.startsWith("merchant:")
        ? choice(["merchant:rex", "merchant:luna", "merchant:bolt"] as const)(
            account,
          )
        : `account:${accountId(account)}`,
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
                trade_proposed: "propose_trade",
                trade_accepted: "accept_trade",
                trade_rejected: "reject_trade",
                trade_cancelled: "cancel_trade",
                offers_expired: "expire_offers",
                player_registered: "register_player",
                upgrade_purchased: "purchase_upgrade",
                assistant_policy_set: "set_assistant_permissions",
                assistant_repriced: "assistant_reprice",
                shop_created: "create_shop",
                shop_renamed: "rename_shop",
                raw_purchased:
                  d.effect.outcome.kind === "raw_purchased" &&
                  d.effect.outcome.trade.buyer.kind === "merchant"
                    ? "merchant_purchase"
                    : "buy_from_merchant",
                production_started: "start_production",
                listing_set: "set_listing",
                market_event_scheduled: "schedule_market_event",
                raw_supplied: "allocate_raw_supply",
                raw_supplies: "allocate_raw_supply",
                treasury_swept: "sweep_merchant_treasury",
                customer_funded: "fund_customer_budget",
                customer_sale: "settle_customer_purchase",
                listing_cancelled: "cancel_listing",
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
    allowHistoryGap = false,
  ) {
    check(
      r.market_revision === args.expected_market_revision &&
        r.data.items.length <= Number(args.limit) &&
        (allowHistoryGap ||
          (!r.data.history_gap && r.data.pruned_through === "0")),
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
    // Both reads are pinned to this exact finalized block. Finish all identity
    // checks before exposing the reader to a caller.
    const identityReads = await Promise.allSettled([
      r.query("view_account"), r.getFoundation(),
    ] as const);
    const identityFailure = identityReads.find(result => result.status === "rejected");
    if (identityFailure?.status === "rejected") throw identityFailure.reason;
    const [accountRead, foundationRead] = identityReads;
    check(accountRead.status === "fulfilled" && foundationRead.status === "fulfilled",
      "incomplete finalized identity reads");
    const account = accountRead.value;
    identityCheck(
      account["code_hash"] === this.identity.codeHash,
      "V2 deployed code mismatch",
    );
    const f = foundationRead.value,
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
  /** Historical receipt replay still checks finalized height, code and authority. */
  async verifiedHistoricalBlock(hash: string): Promise<FinalizedBlock> {
    await this.network();
    const head = await this.block(),
      block = await this.block(hash);
    check(
      BigInt(block.height) <= BigInt(head.height),
      "historical block beyond finalized head",
    );
    await this.at(block);
    return block;
  }
  async receipt(proof: LivingTownProof): Promise<LivingTownReceiptStatus> {
    return (await this.receiptEvidence(proof)).status;
  }
  async completionReceipt(
    proof: LivingTownCompletionProof,
  ): Promise<LivingTownCompletionStatus> {
    return (await this.completionReceiptEvidence(proof)).status;
  }
  async completionReceiptEvidence(
    proof: LivingTownCompletionProof,
  ): Promise<{ status: LivingTownCompletionStatus; response: unknown }> {
    await this.network();
    check(
      canonicalLivingTownJson(proof.deployment) ===
        canonicalLivingTownJson(this.identity.deployment),
      "Completion deployment mismatch",
    );
    let response;
    try {
      response = await this.rpc("tx", {
        tx_hash: hash32(proof.transactionHash),
        sender_account_id: accountId(proof.signerId),
        // Poll the current milestone; the receipt verifier still requires FINAL.
        wait_until: "NONE",
      });
    } catch (error) {
      if (
        error instanceof ChainRpcError &&
        error.code === "UNKNOWN_TRANSACTION"
      )
        return {
          status: { kind: "unknown", transactionHash: proof.transactionHash },
          response: null,
        };
      throw error;
    }
    const head = await this.block();
    const status = await verifyLivingTownCompletionReceipt(
      response,
      proof,
      async (hash) => {
        const b = await this.block(hash);
        check(
          BigInt(b.height) <= BigInt(head.height),
          "Completion beyond finalized head",
        );
        await this.at(b);
        return b;
      },
    );
    return { status, response };
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
        // Avoid waiting for an unknown hash until the transport times out.
        wait_until: "NONE",
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
