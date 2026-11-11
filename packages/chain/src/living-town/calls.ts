import {
  livingTownSourceEffect,
  rawSourceItem,
  sourceMerchant,
} from "./sources.js";
import { array } from "../wire.js";
import {
  livingTownOfferEffect,
  offerMerchant,
  offerItem,
  isLivingTownOfferMethod,
  offerMaterialRules,
} from "./offers.js";
import { livingTownMarketEventEffect } from "./market-events.js";
import {
  livingTownAssistantPolicyEffect,
  livingTownAssistantPolicyInput,
  livingTownAssistantRepriceEffect,
} from "./assistant-policy.js";
import { livingTownRecipeId } from "./recipes.js";
import { livingTownProductionEffect } from "./production.js";
import { livingTownListingEffect } from "./listings.js";
import { livingTownCustomerEffect } from "./customers.js";
import {
  accountId,
  bounded,
  check,
  choice,
  object,
  literal,
  positiveU64,
  nullable,
  parseU64,
  record,
} from "../wire.js";
import {
  livingTownSnapshot,
  livingTownCommand,
  livingTownOwnershipEffect,
  livingTownPurchaseEffect,
  livingTownItem,
  parseLivingTownDeployment,
  decodeLivingTownSnapshot,
} from "./wire.js";
import {
  canonicalLivingTownJson,
  livingTownJsonDigest,
  parseLivingTownJson,
} from "./json.js";

const name = (v: unknown): string => {
  check(
    typeof v === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.exec(v)?.[0] === v,
    "invalid V2 shop name",
  );
  return v;
};
export const livingTownCallArguments = {
  propose_trade: object({
    buyer_merchant_id: offerMerchant,
    seller_merchant_id: offerMerchant,
    item_id: offerItem,
    quantity: bounded(1n, 2n),
    unit_price: bounded(1n, 6n),
    expires_at_ns: positiveU64,
    expected_buyer_ledger_revision: positiveU64,
    expected_seller_ledger_revision: positiveU64,
    command: livingTownCommand,
  }),
  accept_trade: object({
    merchant_id: offerMerchant,
    offer_id: positiveU64,
    expected_offer_revision: bounded(1n, 1n),
    expected_buyer_ledger_revision: positiveU64,
    expected_seller_ledger_revision: positiveU64,
    command: livingTownCommand,
  }),
  reject_trade: object({
    merchant_id: offerMerchant,
    offer_id: positiveU64,
    expected_offer_revision: bounded(1n, 1n),
    command: livingTownCommand,
  }),
  cancel_trade: object({
    merchant_id: offerMerchant,
    offer_id: positiveU64,
    expected_offer_revision: bounded(1n, 1n),
    command: livingTownCommand,
  }),
  expire_offers: object({
    merchant_id: offerMerchant,
    offer_ids: array(positiveU64, 24),
    command: livingTownCommand,
  }),
  merchant_purchase: object({
    buyer_merchant_id: choice(["rex", "luna", "bolt"] as const),
    merchant_id: choice(["rex", "luna", "bolt"] as const),
    item_id: rawSourceItem,
    quantity: bounded(1n, 2n),
    expected_listing_revision: positiveU64,
    max_total_price: bounded(1n, 10000n),
    command: livingTownCommand,
  }),
  purchase_upgrade: object({
    shop_id: positiveU64,
    upgrade_id: literal("second_slot"),
    expected_shop_revision: positiveU64,
    command: livingTownCommand,
  }),
  assistant_reprice: object({
    listing_id: positiveU64,
    expected_listing_revision: positiveU64,
    expected_policy_revision: positiveU64,
    unit_price: bounded(1n, 100n),
    command: livingTownCommand,
  }),
  set_assistant_permissions: object({
    shop_id: bounded(4n, 1003n),
    expected_policy_revision: positiveU64,
    policy: livingTownAssistantPolicyInput,
    command: livingTownCommand,
  }),
  schedule_market_event: object({
    event_id: positiveU64,
    definition_id: literal("herb_shortage_v1"),
    start_epoch: positiveU64,
    command: livingTownCommand,
  }),
  allocate_raw_supply: (value: unknown) => "all_eligible" in record(value)
    ? object({ item_id: rawSourceItem, epoch: parseU64, command: livingTownCommand,
        all_eligible: (v: unknown) => { check(v === true, "batch supply flag must be true"); return true as const; } })(value)
    : object({ item_id: rawSourceItem, epoch: parseU64, command: livingTownCommand })(value),
  sweep_merchant_treasury: object({
    merchant_id: sourceMerchant,
    epoch: parseU64,
    command: livingTownCommand,
  }),
  fund_customer_budget: object({ epoch: parseU64, command: livingTownCommand }),
  settle_customer_purchase: object({
    listing_id: positiveU64,
    expected_listing_revision: positiveU64,
    epoch: parseU64,
    max_total_price: bounded(1n, 10000n),
    command: livingTownCommand,
  }),
  set_listing: object({
    shop_id: positiveU64,
    item_id: livingTownItem,
    quantity: bounded(0n, 100n),
    unit_price: bounded(1n, 100n),
    expected_listing_revision: nullable(positiveU64),
    command: livingTownCommand,
  }),
  cancel_listing: object({
    listing_id: positiveU64,
    expected_listing_revision: positiveU64,
    command: livingTownCommand,
  }),
  start_production: object({
    shop_id: positiveU64,
    recipe_id: livingTownRecipeId,
    recipe_version: bounded(1n, 1n),
    quantity: bounded(1n, 10n),
    expected_shop_revision: positiveU64,
    command: livingTownCommand,
  }),
  register_player: object({ command: livingTownCommand }),
  create_shop: object({ name, command: livingTownCommand }),
  rename_shop: object({
    shop_id: positiveU64,
    expected_shop_revision: positiveU64,
    name,
    command: livingTownCommand,
  }),
  buy_from_merchant: object({
    merchant_id: choice(["rex", "luna", "bolt"] as const),
    item_id: choice(["crystal", "wood", "herb", "iron"] as const),
    quantity: bounded(1n, 100n),
    expected_listing_revision: positiveU64,
    max_total_price: bounded(1n, 10000n),
    command: livingTownCommand,
  }),
};
export type LivingTownMethod = keyof typeof livingTownCallArguments;
export const livingTownGas = "100000000000000";
export function createLivingTownCall(
  method: LivingTownMethod,
  input: unknown,
): LivingTownCall {
  check(
    Object.hasOwn(livingTownCallArguments, method),
    "unsupported V2 mutation",
  );
  const args = livingTownCallArguments[method](input);
  if (method === "propose_trade") {
    const a = livingTownCallArguments.propose_trade(args),
      cfg = offerMaterialRules[a.item_id];
    check(
      a.buyer_merchant_id !== a.seller_merchant_id &&
        (a.buyer_merchant_id === cfg.supplier) !==
          (a.seller_merchant_id === cfg.supplier) &&
        BigInt(a.unit_price) >= BigInt(cfg.min_price) &&
        BigInt(a.unit_price) <= BigInt(cfg.max_price),
      "invalid proposal direction/price",
    );
  }
  if (method === "expire_offers") {
    const a = livingTownCallArguments.expire_offers(args);
    check(
      a.offer_ids.length > 0 &&
        new Set(a.offer_ids).size === a.offer_ids.length,
      "invalid expiry batch",
    );
  }
  // Return a detached deeply frozen public request, never a mutable caller object.
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
  };
  freeze(args);
  return Object.freeze({
    method,
    args,
    gas: livingTownGas,
    deposit: "0" as const,
  });
}
export type LivingTownCall = Readonly<{
  method: LivingTownMethod;
  args: ReturnType<(typeof livingTownCallArguments)[LivingTownMethod]>;
  gas: typeof livingTownGas;
  deposit: "0";
}>;
export type LivingTownResult = ReturnType<
  ReturnType<
    typeof livingTownSnapshot<
      | ReturnType<typeof livingTownOwnershipEffect>
      | ReturnType<typeof livingTownPurchaseEffect>
      | ReturnType<typeof livingTownProductionEffect>
      | ReturnType<typeof livingTownListingEffect>
      | ReturnType<typeof livingTownCustomerEffect>
      | ReturnType<typeof livingTownSourceEffect>
      | ReturnType<typeof livingTownMarketEventEffect>
      | ReturnType<typeof livingTownAssistantPolicyEffect>
      | ReturnType<typeof livingTownAssistantRepriceEffect>
      | ReturnType<typeof livingTownOfferEffect>
    >
  >
>;
export interface LivingTownWalletRequest {
  network: "testnet";
  signerId: string;
  receiverId: string;
  actions: {
    type: "FunctionCall";
    params: {
      methodName: LivingTownMethod;
      args: LivingTownCall["args"];
      gas: typeof livingTownGas;
      deposit: "0";
    };
  }[];
}
export async function livingTownCommandDigest(
  deployment: unknown,
  predecessor: string,
  call: LivingTownCall,
  // NPC cancellation has only a listing ID in its arguments. Resolve its
  // merchant lane from a verified listing read; this is never a contract arg.
  cancelPrincipal?: string,
): Promise<string> {
  const d = parseLivingTownDeployment(deployment),
    actor = accountId(predecessor),
    c = createLivingTownCall(call.method, call.args);
  check(
    !isLivingTownOfferMethod(c.method) || d.state_schema === "2",
    "offer commands require schema 2",
  );
  return livingTownJsonDigest({
    domain: "bot-bazaar:living-town:command:1",
    network_id: d.network_id,
    genesis_hash: d.genesis_hash,
    contract_id: d.contract_id,
    api_version: d.api_version,
    principal: livingTownCallPrincipal(actor, c, cancelPrincipal),
    predecessor_account_id: actor,
    method: c.method,
    args: c.args,
  });
}
export function livingTownWalletRequest(
  contractId: string,
  signerId: string,
  input: LivingTownCall,
): LivingTownWalletRequest {
  const c = createLivingTownCall(input.method, input.args);
  return {
    network: "testnet" as const,
    signerId: accountId(signerId),
    receiverId: accountId(contractId),
    actions: [
      {
        type: "FunctionCall" as const,
        params: {
          methodName: c.method,
          args: c.args,
          gas: c.gas,
          deposit: c.deposit,
        },
      },
    ],
  };
}
export function decodeLivingTownBytes(value: unknown): unknown {
  check(
    Array.isArray(value) &&
      value.length <= 262144 &&
      value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
    "invalid V2 view bytes",
  );
  return parseLivingTownJson(
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value)),
  );
}
export function decodeLivingTownBase64(value: unknown): unknown {
  check(
    typeof value === "string" &&
      value.length <= 350000 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
    "invalid V2 base64",
  );
  return parseLivingTownJson(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value), (v) => v.charCodeAt(0)),
    ),
  );
}
export function decodeLivingTownResult(
  method: LivingTownMethod,
  value: unknown,
  deployment: unknown,
): LivingTownResult {
  return decodeLivingTownSnapshot(value, deployment, (v) =>
    isLivingTownOfferMethod(method)
      ? livingTownOfferEffect(v)
      : method === "assistant_reprice"
        ? livingTownAssistantRepriceEffect(v)
        : method === "set_assistant_permissions"
          ? livingTownAssistantPolicyEffect(v)
          : method === "schedule_market_event"
            ? livingTownMarketEventEffect(v)
            : method === "allocate_raw_supply" ||
                method === "sweep_merchant_treasury"
              ? livingTownSourceEffect(v)
              : method === "fund_customer_budget" ||
                  method === "settle_customer_purchase"
                ? livingTownCustomerEffect(v)
                : method === "set_listing" || method === "cancel_listing"
                  ? livingTownListingEffect(v)
                  : method === "start_production"
                    ? livingTownProductionEffect(v)
                    : method === "buy_from_merchant" ||
                        method === "merchant_purchase"
                      ? livingTownPurchaseEffect(v)
                      : livingTownOwnershipEffect(v),
  );
}
export async function verifyLivingTownEffect(
  value: unknown,
  deployment: unknown,
  signer: string,
  input: LivingTownCall,
): Promise<LivingTownResult> {
  const call = createLivingTownCall(input.method, input.args),
    result = decodeLivingTownResult(call.method, value, deployment),
    effect = result.data;
  const args = call.args as Record<string, unknown>,
    command = call.args.command;
  const cancelPrincipal =
    call.method === "cancel_listing" ? effect.principal : undefined;
  check(
    effect.principal ===
      livingTownCallPrincipal(accountId(signer), call, cancelPrincipal) &&
      effect.command_sequence === command.sequence &&
      effect.payload_sha256 ===
        (await livingTownCommandDigest(
          deployment,
          signer,
          call,
          cancelPrincipal,
        )),
    "V2 command effect binding mismatch",
  );
  const outcome = effect.outcome;
  if (isLivingTownOfferMethod(call.method)) {
    check(
      parseLivingTownDeployment(deployment).state_schema === "2",
      "offer effect requires schema 2",
    );
    const o = livingTownOfferEffect(effect).outcome;
    const expected = {
      propose_trade: "trade_proposed",
      accept_trade: "trade_accepted",
      reject_trade: "trade_rejected",
      cancel_trade: "trade_cancelled",
      expire_offers: "offers_expired",
    } as const;
    check(o.kind === expected[call.method], "offer method/outcome mismatch");
    if (o.kind !== "offers_expired") {
      const v = o.offer;
      if (call.method === "propose_trade")
        check(
          v.buyer === args["buyer_merchant_id"] &&
            v.seller === args["seller_merchant_id"] &&
            v.item_id === args["item_id"] &&
            v.quantity === args["quantity"] &&
            v.unit_price === args["unit_price"] &&
            v.expires_at_ns === args["expires_at_ns"] &&
            BigInt(o.buyer.revision) ===
              BigInt(String(args["expected_buyer_ledger_revision"])) + 1n,
          "proposal reviewed terms mismatch",
        );
      else
        check(
          v.offer_id === args["offer_id"] &&
            BigInt(v.revision) ===
              BigInt(String(args["expected_offer_revision"])) + 1n,
          "closed offer identity/revision mismatch",
        );
      if (o.kind === "trade_accepted")
        check(
          BigInt(o.buyer.revision) ===
            BigInt(String(args["expected_buyer_ledger_revision"])) + 1n &&
            BigInt(o.seller.revision) ===
              BigInt(String(args["expected_seller_ledger_revision"])) + 1n,
          "settlement ledger revision mismatch",
        );
      if (!effect.replayed)
        check(
          (o.kind === "trade_proposed" ? v.created_at_ns : v.closed_at_ns) ===
            result.block_timestamp_ns,
          "offer effect time mismatch",
        );
    } else {
      const ids = [
        ...o.offers.map((v) => v.offer_id),
        ...o.skipped_offer_ids,
      ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      check(
        ids.join() ===
          (args["offer_ids"] as string[])
            .slice()
            .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
            .join(),
        "expiry batch terms mismatch",
      );
      if (!effect.replayed)
        check(
          o.offers.every((v) => v.closed_at_ns === result.block_timestamp_ns),
          "expiry effect time mismatch",
        );
    }
  }
  if (call.method === "purchase_upgrade")
    check(
      outcome.kind === "upgrade_purchased" &&
        outcome.shop.shop_id === args["shop_id"] &&
        BigInt(outcome.shop.revision) ===
          BigInt(String(args["expected_shop_revision"])) + 1n,
      "upgrade reviewed terms mismatch",
    );
  if (call.method === "assistant_reprice") {
    check(
      outcome.kind === "assistant_repriced" &&
        outcome.listing.listing_id === args["listing_id"] &&
        outcome.listing.unit_price === args["unit_price"] &&
        outcome.policy_revision === args["expected_policy_revision"] &&
        BigInt(outcome.listing.revision) ===
          BigInt(String(args["expected_listing_revision"])) + 1n,
      "assistant repricing terms mismatch",
    );
  }
  if (call.method === "set_assistant_permissions") {
    check(
      outcome.kind === "assistant_policy_set",
      "assistant policy effect required",
    );
    const policy = livingTownAssistantPolicyInput(args["policy"]);
    check(
      outcome.shop.owner.kind === "player" &&
        outcome.shop.owner.account_id === signer &&
        outcome.policy.shop_id === args["shop_id"] &&
        BigInt(outcome.policy.revision) ===
          BigInt(String(args["expected_policy_revision"])) + 1n &&
        canonicalLivingTownJson({
          ...policy,
          allowed_items: [...policy.allowed_items].sort(),
          shop_id: args["shop_id"],
          revision: outcome.policy.revision,
        }) === canonicalLivingTownJson(outcome.policy),
      "assistant policy reviewed terms mismatch",
    );
    if (!effect.replayed && policy.expires_at_ns !== null)
      check(
        BigInt(policy.expires_at_ns) > BigInt(result.block_timestamp_ns),
        "assistant policy expiry mismatch",
      );
  }
  if (call.method === "schedule_market_event")
    check(
      outcome.kind === "market_event_scheduled" &&
        outcome.event.event_id === args["event_id"] &&
        outcome.event.start_epoch === args["start_epoch"],
      "market event reviewed terms mismatch",
    );
  if (call.method === "allocate_raw_supply")
    check(
      (outcome.kind === "raw_supplies" || outcome.kind === "raw_supplied") &&
      (args["all_eligible"] === true
        ? outcome.kind === "raw_supplies" && outcome.trigger_item_id === args["item_id"]
        : outcome.kind === "raw_supplied" && outcome.item_id === args["item_id"]) &&
        outcome.epoch === args["epoch"],
      "raw supply reviewed terms mismatch",
    );
  if (call.method === "sweep_merchant_treasury")
    check(
      outcome.kind === "treasury_swept" &&
        outcome.merchant_id === args["merchant_id"] &&
        outcome.epoch === args["epoch"],
      "treasury reviewed terms mismatch",
    );
  if (call.method === "fund_customer_budget")
    check(
      outcome.kind === "customer_funded" && outcome.epoch === args["epoch"],
      "Customer funding terms mismatch",
    );
  if (call.method === "settle_customer_purchase") {
    check(outcome.kind === "customer_sale", "Customer sale required");
    check(
      outcome.trade.listing_id === args["listing_id"] &&
        outcome.pool.epoch === args["epoch"] &&
        BigInt(outcome.trade.total_price) <=
          BigInt(String(args["max_total_price"])) &&
        BigInt(outcome.listing.revision) ===
          BigInt(String(args["expected_listing_revision"])) + 1n &&
        BigInt(outcome.trade.settled_at_ns) <=
          BigInt(result.block_timestamp_ns),
      "Customer sale reviewed terms mismatch",
    );
  }
  if (call.method === "set_listing" || call.method === "cancel_listing") {
    check(
      outcome.kind ===
        (call.method === "set_listing" ? "listing_set" : "listing_cancelled"),
      "Listing outcome mismatch",
    );
    const l = outcome.listing;
    check(
      l.owner.kind !== "player" || l.owner.account_id === signer,
      "Listing signer owner mismatch",
    );
    check(
      l.revision ===
        (call.method === "set_listing" &&
        args["expected_listing_revision"] === null
          ? "1"
          : (
              BigInt(String(args["expected_listing_revision"])) + 1n
            ).toString()),
      "Listing revision mismatch",
    );
    check(
      call.method === "set_listing"
        ? l.shop_id === args["shop_id"] &&
            l.item_id === args["item_id"] &&
            l.remaining_quantity === args["quantity"] &&
            l.unit_price === args["unit_price"]
        : l.listing_id === args["listing_id"] && l.remaining_quantity === "0",
      "Listing reviewed terms mismatch",
    );
  }
  if (call.method === "register_player")
    check(
      outcome.kind === "player_registered" &&
        outcome.player.shop_id === null &&
        outcome.player.ledger.gold.held === "100" &&
        Object.values(outcome.player.ledger.inventory.held).every(
          (v) => v === "0",
        ),
      "V2 registration effect mismatch",
    );
  if (call.method === "create_shop" || call.method === "rename_shop") {
    check(
      outcome.kind ===
        (call.method === "create_shop" ? "shop_created" : "shop_renamed"),
      "V2 shop effect mismatch",
    );
    check(
      "shop" in outcome &&
        outcome.shop.name === args["name"] &&
        (call.method === "create_shop"
          ? outcome.shop.revision === "1"
          : outcome.shop.shop_id === args["shop_id"] &&
            BigInt(outcome.shop.revision) ===
              BigInt(String(args["expected_shop_revision"])) + 1n),
      "V2 shop terms mismatch",
    );
  }
  if (
    call.method === "buy_from_merchant" ||
    call.method === "merchant_purchase"
  ) {
    check(outcome.kind === "raw_purchased", "V2 purchase effect mismatch");
    check(
      call.method === "merchant_purchase"
        ? outcome.trade.buyer.kind === "merchant" &&
            outcome.trade.buyer.merchant_id === args["buyer_merchant_id"]
        : outcome.trade.buyer.kind === "player" &&
            outcome.trade.buyer.account_id === signer,
      "V2 purchase buyer mismatch",
    );
    check(
      outcome.trade.seller.merchant_id === args["merchant_id"] &&
        outcome.trade.item_id === args["item_id"] &&
        outcome.trade.quantity === args["quantity"] &&
        BigInt(outcome.trade.total_price) <=
          BigInt(String(args["max_total_price"])) &&
        BigInt(outcome.listing.revision) ===
          BigInt(String(args["expected_listing_revision"])) + 1n,
      "V2 purchase terms mismatch",
    );
  }
  if (call.method === "start_production") {
    check(outcome.kind === "production_started", "Production outcome mismatch");
    check(
      outcome.job.shop_id === args["shop_id"] &&
        outcome.job.recipe_id === args["recipe_id"] &&
        outcome.job.recipe_version === args["recipe_version"] &&
        outcome.job.quantity === args["quantity"] &&
        outcome.job.config_version === command.config_version,
      "Production reviewed terms mismatch",
    );
    if (!effect.replayed)
      check(
        outcome.job.start_at_ns === result.block_timestamp_ns,
        "Production chain time mismatch",
      );
  }
  check(
    BigInt(effect.effect_revision) <= BigInt(result.market_revision),
    "V2 future original effect",
  );
  if (!effect.replayed)
    check(
      effect.effect_revision === result.market_revision,
      "V2 first-effect revision mismatch",
    );
  return result;
}
export { canonicalLivingTownJson };

export function livingTownCallPrincipal(
  signer: string,
  call: LivingTownCall,
  cancelPrincipal?: string,
): string {
  if (call.method === "cancel_listing" && cancelPrincipal !== undefined) {
    check(
      cancelPrincipal === `account:${accountId(signer)}` ||
        ["merchant:rex", "merchant:luna", "merchant:bolt"].includes(
          cancelPrincipal,
        ),
      "Invalid resolved cancellation principal",
    );
    return cancelPrincipal;
  }
  const args = call.args as Record<string, unknown>;
  if (isLivingTownOfferMethod(call.method))
    return `merchant:${args[call.method === "propose_trade" ? "buyer_merchant_id" : "merchant_id"]}`;
  if (call.method === "merchant_purchase")
    return `merchant:${args["buyer_merchant_id"]}`;
  const id = BigInt(String(args["shop_id"] ?? "0"));
  return (call.method === "start_production" ||
    call.method === "set_listing") &&
    id >= 1n &&
    id <= 3n
    ? `merchant:${["rex", "luna", "bolt"][Number(id - 1n)]}`
    : `account:${accountId(signer)}`;
}
