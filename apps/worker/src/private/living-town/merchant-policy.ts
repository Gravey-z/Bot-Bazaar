import {
  canonicalLivingTownJson,
  createLivingTownCall,
  createLivingTownCompletionCall,
  livingTownSnapshot,
  livingTownTown,
  livingTownShop,
  livingTownListing,
  livingTownProductionJob,
  livingTownRawTrade,
  livingTownCustomerTrade,
  livingTownMerchantTrade,
  parseLivingTownIdentity,
  parseU64,
} from "@bot-bazaar/chain";
import type { FinalizedLivingTownReader } from "@bot-bazaar/chain";
import { sha256, requireStorage } from "../storage/validation.js";
import {
  buildStockSharingPlan,
  selectStockSharingTerms,
} from "./stock-sharing.js";
import type {
  StockSharingPlan,
  StockSharingReaction,
  StockSharingChoice,
} from "./stock-sharing.js";

const names = ["rex", "luna", "bolt"] as const;
type Merchant = (typeof names)[number];
const raw = ["crystal", "wood", "herb", "iron"] as const;
type Raw = (typeof raw)[number];
const min = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b));
const positive = (v: bigint) => (v > 0n ? v : 0n);
export const townMerchantProfiles = Object.freeze({
  policy: "living-town-merchants-v1",
  windowEpochs: "5",
  rex: Object.freeze({
    goldFloor: "80",
    saleBatch: "4",
    crystalPriceFloor: "4",
    demandTrigger: "3",
  }),
  luna: Object.freeze({
    goldFloor: "120",
    saleBatch: "4",
    herbReserve: "4",
    demandTrigger: "4",
  }),
  bolt: Object.freeze({
    goldFloor: "60",
    saleBatch: "3",
    toolTarget: "1",
    minimumToolMargin: "4",
  }),
});
export interface MerchantPolicyInput {
  /** Trusted confirmed listing history from the execution journal. */
  pricingHistory?: readonly { merchant: Merchant; item: Raw; unitPrice: string; changedAtNs: string }[];
  activityCheckpoint?: {
    block_hash: string;
    block_height: string;
    block_timestamp_ns: string;
    market_revision: string;
    event_sequence: string;
  };
  /** Durable finalized player-purchase inbox, distinct from the rolling demand window. */
  externalPurchases?: readonly unknown[];
  /** Trusted host evidence, populated only after journal and pinned key checks. */
  negotiationAuthority?: {
    journal: "ready";
    signerScopes: Record<Merchant, "town_negotiating_merchant">;
  };
  stockSharingReaction?: StockSharingReaction;
  negotiatedTrading?: boolean;
  pendingOffers?: readonly unknown[];
  merchantTrading?: boolean;
  town: unknown;
  merchants: readonly {
    shop: unknown;
    listings: readonly unknown[];
    job: unknown | null;
  }[];
  /** Decoded confirmed trades collected by the verified receipt/history path, not proposals. */
  trades: readonly unknown[];
  fresh: boolean;
  historyComplete: boolean;
}
export type MerchantAction =
  | { kind: "wait"; reason: string }
  | {
      kind: "set_listing";
      reason: string;
      item: Raw;
      quantity: string;
      price: string;
      expectedRevision: string | null;
    }
  | {
      kind: "merchant_purchase";
      reason: string;
      seller: Merchant;
      item: Raw;
      quantity: string;
      maxTotal: string;
      expectedRevision: string;
    }
  | {
      kind: "start_production";
      reason: string;
      recipe: "iron_tool";
      quantity: "1";
      expectedShopRevision: string;
    }
  | { kind: "complete_production"; reason: string; jobId: string };
export interface MerchantPolicyResult {
  pricing: { merchant: Merchant; item: Raw; basePrice: string; minPrice: string; maxPrice: string;
    suggestedPrice: string | null; reason: string; cooldownUntilNs: string | null }[];
  stockSharing?: StockSharingPlan;
  policy: string;
  epoch: string;
  fresh: boolean;
  historyComplete: boolean;
  checkpoint: { height: string; revision: string };
  windowStartNs: string;
  windowEndNs: string;
  volume: Record<string, string | null>;
  scarcity: {
    item: Raw;
    supplier: Merchant;
    held: string;
    reserved: string;
    tradeReserved: string;
    available: string;
    floor: string;
    target: string;
    saleable: string;
    restock: string;
    scarcityBps: string;
    headroom: string;
    confirmedDemand: string | null;
    suggestedPrice: string | null;
  }[];
  decisions: { merchant: Merchant; action: MerchantAction }[];
}
export type CompiledMerchantStep = {
  merchant: Merchant;
  signer: string;
  call:
    | ReturnType<typeof createLivingTownCall>
    | ReturnType<typeof createLivingTownCompletionCall>;
} | null;

/** Pure V2 profiles; V1 price bands and resource policies are intentionally versioned separately. */
export class LivingTownMerchantPolicy {
  private readonly digest: string;
  private readonly materials: Record<
    Raw,
    {
      supplier: Merchant;
      floor: bigint;
      target: bigint;
      price: bigint;
      lo: bigint;
      hi: bigint;
    }
  >;
  constructor(config: unknown) {
    this.digest = sha256(canonicalLivingTownJson(config));
    const cfg = config as {
      version: string;
      economy: {
        materials: Record<Raw, Record<string, string>>;
        recipes: {
          iron_tool: {
            inputs: { wood: string; iron: string };
            salePrice: string;
          };
        };
      };
    };
    requireStorage(cfg.version === "1", "unreviewed economy version");
    const reviewed = {
      crystal: ["rex", "2", "12", "4", "3", "6"],
      wood: ["bolt", "2", "12", "2", "1", "3"],
      herb: ["luna", "4", "12", "3", "2", "4"],
      iron: ["bolt", "4", "12", "5", "3", "6"],
    };
    for (const item of raw)
      requireStorage(
        ["supplier", "floor", "target", "price", "minPrice", "maxPrice"]
          .map((k) => cfg.economy.materials[item][k])
          .join() === reviewed[item].join(),
        "unreviewed merchant material profile",
      );
    this.materials = Object.fromEntries(
      raw.map((item) => {
        const r = cfg.economy.materials[item];
        ["floor", "target", "price", "minPrice", "maxPrice"].forEach((k) =>
          parseU64(r[k]),
        );
        requireStorage(
          names.includes(r["supplier"] as Merchant) &&
            BigInt(r["floor"]!) < BigInt(r["target"]!) &&
            BigInt(r["minPrice"]!) > 0n &&
            BigInt(r["minPrice"]!) <= BigInt(r["price"]!) &&
            BigInt(r["price"]!) <= BigInt(r["maxPrice"]!),
          "invalid V2 material policy",
        );
        return [
          item,
          {
            supplier: r["supplier"] as Merchant,
            floor: BigInt(r["floor"]!),
            target: BigInt(r["target"]!),
            price: BigInt(r["price"]!),
            lo: BigInt(r["minPrice"]!),
            hi: BigInt(r["maxPrice"]!),
          },
        ];
      }),
    ) as typeof this.materials;
    requireStorage(
      this.materials.herb.floor === 4n &&
        cfg.economy.recipes.iron_tool.inputs.wood === "1" &&
        cfg.economy.recipes.iron_tool.inputs.iron === "2" &&
        cfg.economy.recipes.iron_tool.salePrice === "24",
      "unreviewed V2 merchant recipe/reserve",
    );
  }
  evaluate(input: MerchantPolicyInput): MerchantPolicyResult {
    const town = livingTownSnapshot(livingTownTown)(input.town),
      epoch = BigInt(town.data.epoch),
      now = BigInt(town.block_timestamp_ns),
      genesis = BigInt(town.data.genesis_time_ns);
    requireStorage(
      town.deployment.config_sha256 === this.digest &&
        now >= genesis &&
        (now - genesis) / 60000000000n === epoch,
      "merchant policy configuration/epoch mismatch",
    );
    requireStorage(
      input.merchants.length === 3 && input.trades.length <= 2000,
      "bounded complete merchant facts required",
    );
    const same = (s: {
      deployment: unknown;
      block_height: string;
      block_timestamp_ns: string;
      market_revision: string;
      event_sequence: string;
    }) =>
      canonicalLivingTownJson(s.deployment) ===
        canonicalLivingTownJson(town.deployment) &&
      s.block_height === town.block_height &&
      s.block_timestamp_ns === town.block_timestamp_ns &&
      s.market_revision === town.market_revision &&
      s.event_sequence === town.event_sequence;
    const rows = input.merchants.map((r) => {
      const shop = livingTownSnapshot(livingTownShop)(r.shop);
      requireStorage(
        same(shop) && shop.data.owner.kind === "merchant",
        "mixed merchant checkpoint/owner",
      );
      const name = shop.data.owner.merchant_id;
      requireStorage(
        shop.data.shop_id === String(names.indexOf(name) + 1) &&
          r.listings.length <= 6,
        "merchant shop/listing scope mismatch",
      );
      const ledger = town.data.npc_ledgers.find(
        (l) => l.actor.kind === "merchant" && l.actor.merchant_id === name,
      )!;
      const listings = r.listings.map(livingTownListing);
      requireStorage(
        new Set(listings.map((l) => l.item_id)).size === listings.length &&
          listings.every(
            (l) =>
              l.shop_id === shop.data.shop_id &&
              l.owner.kind === "merchant" &&
              l.owner.merchant_id === name,
          ),
        "conflicting merchant listings",
      );
      for (const [item, reserved] of Object.entries(
        ledger.inventory.listing_reserved,
      ))
        requireStorage(
          reserved ===
            (listings.find((l) => l.item_id === item)?.remaining_quantity ??
              "0"),
          "incomplete listing reservations",
        );
      const job = r.job === null ? null : livingTownProductionJob(r.job);
      requireStorage(
        !job ||
          (job.status === "running" &&
            BigInt(job.start_at_ns) <= now &&
            job.shop_id === shop.data.shop_id &&
            job.owner.kind === "merchant" &&
            job.owner.merchant_id === name),
        "invalid merchant production slot",
      );
      for (const [item, promised] of Object.entries(
        ledger.inventory.production_output_reserved,
      ))
        requireStorage(
          promised === (job?.output_item === item ? job.output_quantity : "0"),
          "production promise/slot mismatch",
        );
      return { name, shop: shop.data, ledger, listings, job };
    });
    requireStorage(
      new Set(rows.map((r) => r.name)).size === 3,
      "duplicate merchant facts",
    );
    const volume: Record<string, bigint> = {
      crystal: 0n,
      wood: 0n,
      herb: 0n,
      iron: 0n,
      health_potion: 0n,
      iron_tool: 0n,
    };
    const seen = new Map<string, string>();
    const retailSales = new Map<string, bigint>();
    const start = genesis + positive(epoch - 4n) * 60000000000n;
    for (const value of input.trades) {
      const kind = (value as { kind?: string })?.kind;
      const trade =
        kind === "customer_sale"
          ? livingTownCustomerTrade(value)
          : kind === "merchant_trade"
            ? livingTownMerchantTrade(value)
            : livingTownRawTrade(value);
      requireStorage(
        BigInt(trade.event_sequence) <= BigInt(town.event_sequence) &&
          BigInt(trade.settled_at_ns) <= now &&
          BigInt(trade.settled_at_ns) >= genesis,
        "future/out-of-deployment confirmed trade",
      );
      const key = trade.trade_id,
        encoded = canonicalLivingTownJson(trade);
      requireStorage(
        !seen.has(key) || seen.get(key) === encoded,
        "conflicting confirmed trade",
      );
      if (seen.has(key)) continue;
      seen.set(key, encoded);
      if (
        BigInt(trade.settled_at_ns) >= start &&
        trade.kind !== "merchant_trade" &&
        !(trade.kind === "raw_purchase" && trade.buyer.kind === "merchant")
      ) {
        volume[trade.item_id]! += BigInt(trade.quantity);
        if (trade.kind === "raw_purchase") {
          const key = `${trade.seller.merchant_id}:${trade.item_id}`;
          retailSales.set(key, (retailSales.get(key) ?? 0n) + BigInt(trade.quantity));
        }
      }
    }
    const scarcity = raw.map((item) => {
      const cfg = this.materials[item],
        row = rows.find((r) => r.name === cfg.supplier)!,
        inv = row.ledger.inventory;
      const held = BigInt(inv.held[item]),
        trade = BigInt(inv.trade_reserved[item]);
      const scarce = min(
          10000n,
          (positive(cfg.target - held) * 10000n) / (cfg.target - cfg.floor),
        ),
        demand = volume[item]!;
      const price = cfg.price;
      return {
        item,
        supplier: cfg.supplier,
        held: held.toString(),
        reserved: inv.listing_reserved[item],
        tradeReserved: trade.toString(),
        available: inv.available[item],
        floor: cfg.floor.toString(),
        target: cfg.target.toString(),
        saleable: positive(held - trade).toString(),
        restock: positive(cfg.target - held).toString(),
        scarcityBps: scarce.toString(),
        headroom: (
          1000n -
          held -
          BigInt(inv.production_output_reserved[item]) -
          BigInt(inv.trade_inbound_reserved[item])
        ).toString(),
        confirmedDemand: input.historyComplete ? demand.toString() : null,
        suggestedPrice:
          input.fresh && input.historyComplete ? price.toString() : null,
      };
    });
    const pricing = names.flatMap(merchant => raw.map(item => {
      const cfg = this.materials[item], row = rows.find(r => r.name === merchant)!;
      const listing = row.listings.find(l => l.item_id === item);
      const primary = cfg.supplier === merchant;
      const own = positive(BigInt(row.ledger.inventory.held[item]) -
        BigInt(row.ledger.inventory.trade_reserved[item]));
      const peerSupply = rows.filter(r => r.name !== merchant).reduce((sum, peer) =>
        sum + BigInt(peer.listings.find(l => l.item_id === item && l.active)?.remaining_quantity ?? "0"), 0n);
      const scarcePeers = peerSupply <= 2n;
      const strongDemand = volume[item]! >= (item === "herb" ? 4n : 3n);
      const overstock = BigInt(row.ledger.inventory.held[item]) > (primary ? cfg.target : 7n);
      const slowSales = epoch >= 5n && own >= 4n && (retailSales.get(`${merchant}:${item}`) ?? 0n) === 0n;
      const minimum = merchant === "rex" && item === "crystal" ? 4n
        : merchant === "luna" && item === "herb" ? 3n : cfg.lo;
      // Always anchor the target to the material's base price. Never follow
      // the cheapest competitor down or compound another discount each tick.
      const premium = scarcePeers || (own <= 2n && own > 0n) || strongDemand;
      const discount = !premium && !strongDemand && (overstock || slowSales);
      let target = cfg.price + (premium ? (scarcePeers && strongDemand ? 2n : 1n) : discount ? -1n : 0n);
      target = min(cfg.hi, target < minimum ? minimum : target);
      const current = BigInt(listing?.unit_price ?? cfg.price.toString());
      const history = input.pricingHistory?.find(p => p.merchant === merchant && p.item === item);
      const until = history ? BigInt(history.changedAtNs) + 180_000_000_000n : null;
      const cooling = until !== null && now < until;
      const next = cooling || own === 0n ? current : current < target ? min(target, current + 1n)
        : current > target ? (current - 1n < target ? target : current - 1n) : current;
      return { merchant, item, basePrice: cfg.price.toString(), minPrice: minimum.toString(), maxPrice: cfg.hi.toString(),
        suggestedPrice: input.fresh && input.historyComplete ? next.toString() : null,
        reason: cooling ? "price_cooldown" : premium ? "scarcity_or_confirmed_demand"
          : discount ? "slow_sales_or_surplus" : "stable_base_price",
        cooldownUntilNs: until?.toString() ?? null };
    }));
    for (const signal of scarcity)
      signal.suggestedPrice = pricing.find(p => p.merchant === signal.supplier && p.item === signal.item)!.suggestedPrice;
    const decisions = names.map((name) => {
      const r = rows.find((row) => row.name === name)!,
        inv = r.ledger.inventory;
      const wait = (reason: string): MerchantAction => ({
        kind: "wait",
        reason,
      });
      let action: MerchantAction = wait("stock_and_prices_within_policy");
      if (!input.fresh || !input.historyComplete)
        action = wait("confirmed_facts_unavailable");
      else if (r.job)
        action =
          BigInt(r.job.ready_at_ns) <= now
            ? {
                kind: "complete_production",
                reason: "confirmed_job_ready",
                jobId: r.job.job_id,
              }
            : wait("production_running");
      else if (town.data.paused) action = wait("paused");
      else if (
        name === "bolt" &&
        BigInt(inv.held.iron_tool) +
          BigInt(inv.production_output_reserved.iron_tool) <
          1n
      ) {
        const cost = this.materials.wood.price + 2n * this.materials.iron.price;
        if (BigInt(r.ledger.gold.available) < 60n)
          action = wait("gold_reserve");
        else if (24n - cost < 4n)
          action = wait("replacement_value_margin_too_low");
        else if (
          BigInt(inv.held.iron_tool) +
            BigInt(inv.production_output_reserved.iron_tool) +
            BigInt(inv.trade_inbound_reserved.iron_tool) >=
          1000n
        )
          action = wait("output_capacity");
        else {
          const inputs = [
            ["wood", 1n],
            ["iron", 2n],
          ] as const;
          if (
            inputs.some(
              ([item, n]) =>
                BigInt(inv.held[item]) - BigInt(inv.trade_reserved[item]) - n <
                this.materials[item].floor,
            )
          )
            action = wait("supplier_allocation_required");
          else {
            const release = inputs.find(
              ([item, n]) => BigInt(inv.available[item]) < n,
            );
            if (release) {
              const [item, n] = release,
                l = r.listings.find((l) => l.item_id === item);
              if (
                !l ||
                BigInt(l.remaining_quantity) < n - BigInt(inv.available[item])
              )
                action = wait("trade_reserved_inputs");
              else
                action = {
                  kind: "set_listing",
                  reason: "release_inputs_before_crafting",
                  item,
                  quantity: min(
                    BigInt(l.remaining_quantity) -
                      (n - BigInt(inv.available[item])),
                    positive(
                      BigInt(inv.held[item]) -
                        BigInt(inv.trade_reserved[item]) -
                        this.materials[item].floor,
                    ),
                  ).toString(),
                  price: l.unit_price,
                  expectedRevision: l.revision,
                };
            } else
              action = {
                kind: "start_production",
                reason: "bounded_tool_stock_target",
                recipe: "iron_tool",
                quantity: "1",
                expectedShopRevision: r.shop.revision,
              };
          }
        }
      } else {
        for (const signal of scarcity.filter((s) => s.supplier === name)) {
          const listing = r.listings.find((l) => l.item_id === signal.item);
          requireStorage(listing, "supplier listing identity required");
          const scarce = BigInt(signal.scarcityBps),
            price = BigInt(signal.suggestedPrice!);
          const quantity = min(
            BigInt(signal.saleable),
            100n,
          ).toString();
          if (
            listing.unit_price !== price.toString() ||
            listing.remaining_quantity !== quantity
          ) {
            action = {
              kind: "set_listing",
              reason:
                scarce >= 5000n
                  ? "scarcity_price_and_reserve"
                  : "bounded_sale_stock",
              item: signal.item,
              quantity,
              price: price.toString(),
              expectedRevision: listing.revision,
            };
            break;
          }
          if (BigInt(signal.restock) > 0n)
            action = wait("supplier_allocation_required");
        }
      }
      // Offer every raw material, including non-specialty stock. Existing
      // listings reserve held units, so resize from held minus trade commitments,
      // not from available. Retail shelves may sell out completely.
      const craftingRelease = action.kind === "set_listing" && action.reason === "release_inputs_before_crafting";
      if (input.fresh && input.historyComplete && !town.data.paused &&
        action.kind !== "complete_production" && action.kind !== "start_production" && !craftingRelease) {
        // Fill empty/incomplete shelves before optional repricing. Otherwise
        // repricing an empty specialty listing can hide saleable backup stock.
        const updates = raw.flatMap(item => {
          const listing = r.listings.find(l => l.item_id === item);
          const quantity = min(100n, positive(BigInt(inv.held[item]) - BigInt(inv.trade_reserved[item]))).toString();
          if (!listing && quantity === "0") return [];
          const price = pricing.find(p => p.merchant === name && p.item === item)!.suggestedPrice!;
          if (!listing || listing.remaining_quantity !== quantity || listing.unit_price !== price) {
            return [{ quantityChanged: (listing?.remaining_quantity ?? "0") !== quantity,
              action: { kind: "set_listing" as const, reason: "list_all_saleable_materials", item, quantity, price,
                expectedRevision: listing?.revision ?? null } }];
          }
          return [];
        }).sort((a, b) => Number(b.quantityChanged) - Number(a.quantityChanged));
        if (updates[0]) action = updates[0].action;
        // Legacy direct purchases also consume a real active listing. Negotiated
        // trading uses the listing-backed candidate generator below instead.
        if (action.kind === "wait" && input.merchantTrading && town.deployment.state_schema === "1" && !input.negotiatedTrading) {
          for (const item of raw) {
            const cfg = this.materials[item], primary = cfg.supplier === name;
            const target = primary ? cfg.target : 2n, held = BigInt(inv.held[item]);
            if (held >= target) continue;
            const supplier = rows.find(row => row.name === cfg.supplier)!;
            if (!primary && BigInt(supplier.ledger.inventory.held[item]) < cfg.target - 2n) continue;
            const seller = rows.find(row => row.name !== name && row.listings.some(l =>
              l.item_id === item && l.active && BigInt(l.remaining_quantity) > 0n &&
              BigInt(l.unit_price) <= (primary ? cfg.hi : cfg.price)));
            const listing = seller?.listings.find(l => l.item_id === item && l.active);
            if (!seller || !listing) continue;
            const quantity = min(2n, target - held, BigInt(listing.remaining_quantity));
            const cost = quantity * BigInt(listing.unit_price);
            if (BigInt(r.ledger.gold.available) < cost + BigInt(townMerchantProfiles[name].goldFloor)) continue;
            action = { kind: "merchant_purchase", reason: primary ? "listed_peer_restock" : "listed_backup_acquisition",
              seller: seller.name, item, quantity: quantity.toString(), maxTotal: cost.toString(), expectedRevision: listing.revision };
            break;
          }
        }
      }
      return { merchant: name, action };
    });
    return {
      policy: "living-town-merchants-v4-bounded-pricing",
      pricing,
      epoch: town.data.epoch,
      fresh: input.fresh,
      historyComplete: input.historyComplete,
      checkpoint: { height: town.block_height, revision: town.market_revision },
      windowStartNs: start.toString(),
      windowEndNs: town.block_timestamp_ns,
      volume: Object.fromEntries(
        Object.entries(volume).map(([k, v]) => [
          k,
          input.historyComplete ? v.toString() : null,
        ]),
      ),
      scarcity,
      decisions,
      ...(input.negotiatedTrading
        ? { stockSharing: buildStockSharingPlan(input) }
        : {}),
    };
  }
  /** Phase 4 supplies the model-selected terms; this method only revalidates and
   * compiles a buyer proposal. It never approves on behalf of the seller. */
  compileStockSharingProposal(
    input: MerchantPolicyInput,
    merchant: Merchant,
    choice: StockSharingChoice,
    identityValue: unknown,
    command: unknown,
    expiresAtNs?: string,
  ): CompiledMerchantStep {
    const identity = parseLivingTownIdentity(identityValue),
      town = livingTownSnapshot(livingTownTown)(input.town);
    requireStorage(
      canonicalLivingTownJson(identity.deployment) ===
        canonicalLivingTownJson(town.deployment),
      "stock-sharing compiler identity mismatch",
    );
    const plan = this.evaluate(input).stockSharing;
    requireStorage(plan, "negotiated stock-sharing capability unavailable");
    const { candidate } = selectStockSharingTerms(plan, merchant, choice),
      signer = identity.controllers[merchant];
    requireStorage(
      signer !== identity.operatorId &&
        signer !== identity.ownerId &&
        signer !== identity.deployment.contract_id,
      "independent stock-sharing buyer controller required",
    );
    const call = createLivingTownCall("propose_trade", {
      buyer_merchant_id: merchant,
      seller_merchant_id: candidate.seller,
      item_id: candidate.item,
      quantity: choice.quantity,
      unit_price: choice.unitPrice,
      expires_at_ns:
        expiresAtNs ??
        (BigInt(town.block_timestamp_ns) + 600000000000n).toString(),
      expected_buyer_ledger_revision: candidate.buyerLedgerRevision,
      expected_seller_ledger_revision: candidate.sellerLedgerRevision,
      command,
    });
    requireStorage(
      "expires_at_ns" in call.args &&
        BigInt(call.args.expires_at_ns) >=
          BigInt(town.block_timestamp_ns) + 60000000000n &&
        BigInt(call.args.expires_at_ns) <=
          BigInt(town.block_timestamp_ns) + 600000000000n &&
        call.args.command.config_version === town.deployment.config_version &&
        BigInt(call.args.command.valid_until_ns) >
          BigInt(town.block_timestamp_ns) &&
        BigInt(call.args.command.valid_until_ns) <=
          BigInt(town.block_timestamp_ns) + 600000000000n,
      "stock-sharing command expired/outside bounded lifetime",
    );
    return { merchant, signer, call };
  }
  /** Compile only a freshly re-evaluated policy step, scoped to its merchant controller. */
  compile(
    input: MerchantPolicyInput,
    merchant: Merchant,
    proposal: MerchantAction,
    identityValue: unknown,
    command: unknown,
  ): CompiledMerchantStep {
    const identity = parseLivingTownIdentity(identityValue),
      town = livingTownSnapshot(livingTownTown)(input.town);
    requireStorage(
      canonicalLivingTownJson(identity.deployment) ===
        canonicalLivingTownJson(town.deployment) && names.includes(merchant),
      "merchant compiler identity mismatch",
    );
    const expected = this.evaluate(input).decisions.find(
      (d) => d.merchant === merchant,
    )!.action;
    requireStorage(
      canonicalLivingTownJson(expected) === canonicalLivingTownJson(proposal),
      "stale or altered merchant policy step",
    );
    const signer = identity.controllers[merchant];
    requireStorage(
      signer !== identity.operatorId &&
        signer !== identity.ownerId &&
        signer !== identity.deployment.contract_id,
      "independent merchant controller required",
    );
    if (proposal.kind === "wait") return null;
    if (proposal.kind === "complete_production")
      return {
        merchant,
        signer,
        call: createLivingTownCompletionCall({ job_id: proposal.jobId }),
      };
    const shop = String(names.indexOf(merchant) + 1);
    const call =
      proposal.kind === "merchant_purchase"
        ? createLivingTownCall("merchant_purchase", {
            buyer_merchant_id: merchant,
            merchant_id: proposal.seller,
            item_id: proposal.item,
            quantity: proposal.quantity,
            expected_listing_revision: proposal.expectedRevision,
            max_total_price: proposal.maxTotal,
            command,
          })
        : proposal.kind === "set_listing"
          ? createLivingTownCall("set_listing", {
              shop_id: shop,
              item_id: proposal.item,
              quantity: proposal.quantity,
              unit_price: proposal.price,
              expected_listing_revision: proposal.expectedRevision,
              command,
            })
          : createLivingTownCall("start_production", {
              shop_id: shop,
              recipe_id: proposal.recipe,
              recipe_version: "1",
              quantity: proposal.quantity,
              expected_shop_revision: proposal.expectedShopRevision,
              command,
            });
    requireStorage(
      BigInt(call.args.command.valid_until_ns) >
        BigInt(town.block_timestamp_ns) &&
        BigInt(call.args.command.valid_until_ns) <=
          (input.stockSharingReaction
            ? BigInt(town.block_timestamp_ns) + 60000000000n
            : proposal.kind === "set_listing"
              ? BigInt(town.block_timestamp_ns) + 120000000000n
            : BigInt(town.data.genesis_time_ns) +
              (BigInt(town.data.epoch) + 1n) * 60000000000n),
      "merchant command outside bounded execution window",
    );
    return { merchant, signer, call };
  }
}

/** Bounded collection at one verified finalized reader; confirmed trade history is supplied separately. */
export async function collectMerchantPolicyInput(
  reader: FinalizedLivingTownReader,
  trades: readonly unknown[],
  historyComplete: boolean,
): Promise<MerchantPolicyInput> {
  const town = await reader.getTown();
  const merchants = [];
  for (const shop_id of ["1", "2", "3"]) {
    const shop = await reader.getShop(shop_id);
    requireStorage(shop.data, "missing NPC shop");
    const listings = await reader.getListings({
      shop_id,
      item_id: null,
      active_only: false,
      after_id: null,
      limit: "50",
      expected_market_revision: town.market_revision,
    });
    const jobs = await reader.getProductionJobs({
      shop_id,
      status: "running",
      after_id: null,
      limit: "50",
      expected_market_revision: town.market_revision,
    });
    requireStorage(
      !listings.data.has_more &&
        !jobs.data.has_more &&
        jobs.data.items.length <= 1,
      "incomplete merchant facts",
    );
    merchants.push({
      shop,
      listings: listings.data.items,
      job: jobs.data.items[0] ?? null,
    });
  }
  const merchantTrading =
    typeof reader.getFoundation === "function" &&
    (await reader.getFoundation()).data.supported_methods.includes(
      "merchant_purchase",
    );
  const pending =
    town.deployment.state_schema === "2"
      ? await reader.getPendingMerchantOffers()
      : null;
  requireStorage(
    !pending ||
      canonicalLivingTownJson(pending.town) === canonicalLivingTownJson(town),
    "mixed stock-sharing offer checkpoint",
  );
  return {
    town,
    merchants,
    trades,
    fresh: true,
    historyComplete,
    merchantTrading,
    ...(pending
      ? { negotiatedTrading: true, pendingOffers: pending.offers }
      : {}),
  };
}
