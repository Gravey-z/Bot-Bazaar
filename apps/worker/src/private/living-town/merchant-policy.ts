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
  parseLivingTownIdentity,
  parseU64,
} from "@bot-bazaar/chain";
import type { FinalizedLivingTownReader } from "@bot-bazaar/chain";
import { sha256, requireStorage } from "../storage/validation.js";

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
    herbReserve: "8",
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
    const reviewed = {
      crystal: ["rex", "2", "10", "4", "3", "6"],
      wood: ["bolt", "2", "10", "2", "1", "3"],
      herb: ["luna", "8", "20", "3", "2", "4"],
      iron: ["bolt", "4", "20", "5", "3", "6"],
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
      this.materials.herb.floor === 8n &&
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
    const start = genesis + positive(epoch - 4n) * 60000000000n;
    for (const value of input.trades) {
      const kind = (value as { kind?: string })?.kind;
      const trade =
        kind === "customer_sale"
          ? livingTownCustomerTrade(value)
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
      if (BigInt(trade.settled_at_ns) >= start)
        volume[trade.item_id]! += BigInt(trade.quantity);
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
      let price = cfg.price;
      if (cfg.supplier === "rex")
        price =
          scarce >= 5000n || demand >= 3n
            ? cfg.hi
            : cfg.price < 4n
              ? 4n
              : cfg.price;
      else if (cfg.supplier === "luna")
        price = scarce >= 5000n || demand >= 4n ? cfg.hi : cfg.price;
      else if (scarce >= 5000n) price = cfg.hi;
      else if (held > cfg.target && demand === 0n) price = cfg.lo;
      price = min(cfg.hi, price < cfg.lo ? cfg.lo : price);
      return {
        item,
        supplier: cfg.supplier,
        held: held.toString(),
        reserved: inv.listing_reserved[item],
        tradeReserved: trade.toString(),
        available: inv.available[item],
        floor: cfg.floor.toString(),
        target: cfg.target.toString(),
        saleable: positive(held - trade - cfg.floor).toString(),
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
            BigInt(townMerchantProfiles[name].saleBatch),
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
      return { merchant: name, action };
    });
    return {
      policy: townMerchantProfiles.policy,
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
    };
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
      proposal.kind === "set_listing"
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
          BigInt(town.data.genesis_time_ns) +
            (BigInt(town.data.epoch) + 1n) * 60000000000n,
      "merchant command outside current epoch",
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
  return { town, merchants, trades, fresh: true, historyComplete };
}
