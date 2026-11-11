import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPairEd25519 } from "near-api-js";
import { createHash } from "node:crypto";
import {
  canonicalLivingTownJson,
  livingTownCommandDigest,
} from "../../../../packages/chain/dist/index.js";
import { LivingTownExecutionStore } from "../../dist/private/living-town/execution-store.js";
import { TownChainAdapter } from "../../dist/private/living-town/town-chain.js";
import { LivingTownMerchantPolicy } from "../../dist/private/living-town/merchant-policy.js";
import { LivingTownTickScheduler } from "../../dist/private/living-town/ticks.js";
import { LivingTownCustomerDemand } from "../../dist/private/living-town/customers.js";
import { LivingTownSimulationAdapter } from "../../dist/private/living-town/simulation-adapter.js";
import {
  townMerchantMethods,
  townNegotiatingMerchantMethods,
  townSourceMethods,
  townOperatorMethods,
} from "../../dist/private/near-signer.js";
import { CustomerChainAdapter } from "../../dist/private/living-town/customer-chain.js";
import { DurableCustomerExecutor } from "../../dist/private/living-town/customer-executor.js";
import { LivingTownTickRunner } from "../../dist/private/living-town/tick-runner.js";
const read = (p) => JSON.parse(readFileSync(p, "utf8")),
  clone = structuredClone;
const capture = read("tests/fixtures/chain/living-town-races-sandbox.json"),
  config = read("config/living-town-v1.json");
// Controlled snapshots use the current fresh-demo config; archived files are untouched.
const currentConfigDigest = createHash("sha256")
  .update(canonicalLivingTownJson(config))
  .digest("hex");
function bindConfig(value) {
  if (!value || typeof value !== "object") return;
  if (value.deployment) value.deployment.config_sha256 = currentConfigDigest;
  for (const child of Object.values(value)) bindConfig(child);
}
bindConfig(capture);
const f = capture.setup[0].foundation;
export const identity = {
  deployment: f.deployment,
  codeHash: capture.setup[0].account.code_hash,
  ownerId: f.data.owner_account_id,
  operatorId: f.data.operator_account_id,
  controllers: f.data.merchant_controllers,
};
const baseIdentity = identity;
const names = ["rex", "luna", "bolt"],
  lanes = [...names, "operator"],
  items = ["crystal", "wood", "herb", "iron", "health_potion", "iron_tool"];
export const continuity = async (c) => ({
  ...c,
  journal: "current",
  fencing: "verified",
  providerHistory: "accounted",
  evidenceRef: "controlled-adapter-test",
});
// Real SQLite and SDK signatures/effect validation; controlled finalized reader/receipt-status boundary.
// These synthetic statuses are not extra chain receipts or provider/model evidence.
const openStores = new Map();
export function closeAdapterFixturesAt(dir) {
  for (const store of openStores.get(dir) ?? []) store.close();
  openStores.delete(dir);
}
export async function adapterFixture(
  dir,
  {
    propose,
    negotiated = false,
    assistant,
    crashAt,
    realCustomers = false,
    seed = "42",
    operations,
    continuityFactory,
    simulationOptions,
    fundOnlyWhenNeeded = false,
  } = {},
) {
  const identity = clone(baseIdentity);
  if (negotiated) identity.deployment.state_schema = "2";
  const path = join(dir, "model.json");
  const state = existsSync(path)
    ? read(path)
    : {
        town: clone(capture.stages[0].before.town),
        markers: {
          raw_epochs: { crystal: "0", wood: "0", herb: "0", iron: "0" },
          treasury_epochs: { rex: "0", luna: "0", bolt: "0" },
        },
        commands: Object.fromEntries(
          lanes.map((l) => [
            l,
            { sequence: "0", digest: null, effect: null, method: null },
          ]),
        ),
        listings: [],
        jobs: [],
        results: {},
        nonce: Object.fromEntries(lanes.map((l) => [l, "0"])),
      };
  if (!existsSync(path)) {
    const t = state.town;
    t.deployment = clone(identity.deployment);
    if (negotiated) {
      state.offers = [];
      state.externalPurchases = [];
      state.trades = [];
      for (const [index, m] of names.entries()) {
        const l = t.data.npc_ledgers[index];
        l.revision = "1";
        l.gold = {
          held: "200",
          available: "200",
          trade_reserved: "0",
          trade_inbound_reserved: "0",
        };
        for (const item of items) {
          const h =
              config.economy.stockSharing.startingHoldings[m][item] ?? "0",
            listed =
              config.economy.materials[item]?.supplier === m
                ? config.economy.materials[item].listed
                : "0";
          for (const key of Object.keys(l.inventory))
            l.inventory[key][item] =
              key === "held"
                ? h
                : key === "listing_reserved"
                  ? listed
                  : key === "available"
                    ? String(BigInt(h) - BigInt(listed))
                    : "0";
        }
      }
      t.data.next_offer_id = "1";
      t.data.next_trade_id = "1";
    }
    t.block_timestamp_ns = (
      BigInt(t.data.genesis_time_ns) + 65000000000n
    ).toString();
    t.data.epoch = t.data.customer_pool.epoch = "1";
    for (const [item, r] of Object.entries(config.economy.materials)) {
      const index = names.indexOf(r.supplier),
        q = t.data.npc_ledgers[index].inventory.listing_reserved[item];
      state.listings.push({
        listing_id: String(items.indexOf(item) + 1),
        shop_id: String(index + 1),
        owner: { kind: "merchant", merchant_id: r.supplier },
        item_id: item,
        remaining_quantity: q,
        unit_price: r.price,
        revision: "1",
        active: q !== "0",
      });
    }
  }
  const store = new LivingTownExecutionStore(
    dir,
    identity,
    seed,
    !existsSync(join(dir, "worker.sqlite")),
  );
  if (!openStores.has(dir)) openStores.set(dir, []);
  openStores.get(dir).push(store);
  const verifyContinuity = continuityFactory
    ? continuityFactory(store)
    : continuity;
  const stats = { sign: 0, send: 0, model: 0 },
    adapters = {};
  let mode = "success";
  const save = () => writeFileSync(path, JSON.stringify(state));
  const die = (point) => {
    if (crashAt === point) {
      save();
      process.kill(process.pid, "SIGKILL");
    }
  };
  const pin = (data) => ({ ...clone(state.town), data: clone(data) });
  const collect = async () => ({
    town: clone(state.town),
    merchants: names.map((name, i) => ({
      shop: pin(state.town.data.npc_shops[i]),
      listings: clone(
        state.listings.filter((l) => l.owner.merchant_id === name),
      ),
      job: clone(
        state.jobs.find(
          (j) => j.owner.merchant_id === name && j.status === "running",
        ) ?? null,
      ),
    })),
    trades: clone(state.trades ?? []),
    ...(negotiated
      ? {
          negotiatedTrading: true,
          pendingOffers: clone(
            (state.offers ?? [])
              .filter((o) => o.status === "pending")
              .map((o) => ({
                ...o,
                expired:
                  BigInt(state.town.block_timestamp_ns) >=
                  BigInt(o.expires_at_ns),
              })),
          ),
          externalPurchases: clone(state.externalPurchases ?? []),
        }
      : {}),
    fresh: true,
    historyComplete: true,
  });
  function settleOffer(lane, a, method, revision) {
    const ledger = (m) => state.town.data.npc_ledgers[names.indexOf(m)],
      bump = (l) => {
        l.revision = String(BigInt(l.revision) + 1n);
      };
    let o;
    if (method === "propose_trade") {
      o = {
        offer_id: state.town.data.next_offer_id,
        proposer: a.buyer_merchant_id,
        buyer: a.buyer_merchant_id,
        seller: a.seller_merchant_id,
        item_id: a.item_id,
        quantity: a.quantity,
        unit_price: a.unit_price,
        total_price: String(BigInt(a.quantity) * BigInt(a.unit_price)),
        created_at_ns: state.town.block_timestamp_ns,
        expires_at_ns: a.expires_at_ns,
        status: "pending",
        expired: false,
        revision: "1",
        trade_id: null,
        proposal_command_sequence: a.command.sequence,
        closed_at_ns: null,
        closing_principal: null,
        closing_command_sequence: null,
      };
      state.offers.push(o);
      state.town.data.next_offer_id = String(BigInt(o.offer_id) + 1n);
      const b = ledger(o.buyer);
      b.gold.trade_reserved = String(
        BigInt(b.gold.trade_reserved) + BigInt(o.total_price),
      );
      b.gold.available = String(
        BigInt(b.gold.available) - BigInt(o.total_price),
      );
      b.inventory.trade_inbound_reserved[o.item_id] = String(
        BigInt(b.inventory.trade_inbound_reserved[o.item_id]) +
          BigInt(o.quantity),
      );
      bump(b);
      return { kind: "trade_proposed", offer: clone(o), buyer: clone(b) };
    }
    o = state.offers.find(
      (o) => o.offer_id === (a.offer_id ?? a.offer_ids?.[0]),
    );
    const b = ledger(o.buyer),
      s = ledger(o.seller),
      q = BigInt(o.quantity),
      cost = BigInt(o.total_price);
    b.gold.trade_reserved = String(BigInt(b.gold.trade_reserved) - cost);
    b.inventory.trade_inbound_reserved[o.item_id] = String(
      BigInt(b.inventory.trade_inbound_reserved[o.item_id]) - q,
    );
    o.status =
      method === "accept_trade"
        ? "accepted"
        : method === "reject_trade"
          ? "rejected"
          : "expired";
    o.revision = "2";
    o.expired = o.status === "expired";
    o.closed_at_ns = state.town.block_timestamp_ns;
    o.closing_principal = "merchant:" + lane;
    o.closing_command_sequence = a.command.sequence;
    if (method === "accept_trade") {
      b.gold.held = String(BigInt(b.gold.held) - cost);
      b.inventory.held[o.item_id] = String(
        BigInt(b.inventory.held[o.item_id]) + q,
      );
      b.inventory.available[o.item_id] = String(
        BigInt(b.inventory.available[o.item_id]) + q,
      );
      s.gold.held = s.gold.available = String(BigInt(s.gold.held) + cost);
      s.inventory.held[o.item_id] = String(
        BigInt(s.inventory.held[o.item_id]) - q,
      );
      s.inventory.available[o.item_id] = String(
        BigInt(s.inventory.available[o.item_id]) - q,
      );
      bump(b);
      bump(s);
      const trade = {
        trade_id: state.town.data.next_trade_id,
        kind: "merchant_trade",
        buyer: clone(b.actor),
        seller: clone(s.actor),
        customer_pool_id: null,
        item_id: o.item_id,
        quantity: o.quantity,
        unit_price: o.unit_price,
        total_price: o.total_price,
        listing_id: null,
        offer_id: o.offer_id,
        consumed_quantity: "0",
        settled_at_ns: o.closed_at_ns,
        command_principal: o.closing_principal,
        command_sequence: o.closing_command_sequence,
        event_sequence: revision,
      };
      o.trade_id = trade.trade_id;
      state.trades.push(trade);
      state.town.data.next_trade_id = String(BigInt(trade.trade_id) + 1n);
      return {
        kind: "trade_accepted",
        offer: clone(o),
        buyer: clone(b),
        seller: clone(s),
        trade: clone(trade),
      };
    }
    b.gold.available = String(BigInt(b.gold.available) + cost);
    bump(b);
    return method === "expire_offers"
      ? {
          kind: "offers_expired",
          offers: [clone(o)],
          skipped_offer_ids: [],
          ledgers: [clone(b)],
        }
      : { kind: "trade_rejected", offer: clone(o), buyer: clone(b) };
  }
  async function send(lane) {
    const row = store.unresolved()[0];
    if (!row || row.status !== "unknown")
      throw Error("send before unknown journal marker");
    stats.send++;
    if (mode === "timeout_before") throw Error("controlled transport timeout");
    const p = JSON.parse(row.signed_json),
      a = p.call.args,
      method = p.call.method,
      rev = (BigInt(state.town.market_revision) + 1n).toString();
    const principal =
      lane === "operator"
        ? `account:${identity.operatorId}`
        : `merchant:${lane}`;
    let outcome;
    if (
      [
        "propose_trade",
        "accept_trade",
        "reject_trade",
        "expire_offers",
      ].includes(method)
    ) {
      outcome = settleOffer(lane, a, method, rev);
    } else if (method === "assistant_reprice") {
      const listing = state.assistantListing;
      if (
        state.assistantPolicy.mode !== "auto_reprice" ||
        state.assistantPolicy.revision !== a.expected_policy_revision ||
        listing.revision !== a.expected_listing_revision
      )
        throw Error("controlled policy rejected");
      listing.unit_price = a.unit_price;
      listing.revision = (BigInt(listing.revision) + 1n).toString();
      outcome = {
        kind: "assistant_repriced",
        listing: clone(listing),
        policy_revision: a.expected_policy_revision,
      };
    } else if (
      method === "allocate_raw_supply" ||
      method === "sweep_merchant_treasury"
    ) {
      const name =
          method === "allocate_raw_supply"
            ? config.economy.materials[a.item_id].supplier
            : a.merchant_id,
        i = names.indexOf(name),
        ledger = state.town.data.npc_ledgers[i];
      if (method === "allocate_raw_supply") {
        const r = config.economy.materials[a.item_id],
          held = BigInt(ledger.inventory.held[a.item_id]),
          promised =
            held +
            BigInt(ledger.inventory.production_output_reserved[a.item_id]) +
            BigInt(ledger.inventory.trade_inbound_reserved[a.item_id]),
          amount = [
            BigInt(a.epoch) % 5n === 0n ? 2n : 0n,
            a.item_id === "herb" &&
            state.town.data.market_event &&
            BigInt(a.epoch) >=
              BigInt(state.town.data.market_event.start_epoch) &&
            BigInt(a.epoch) < BigInt(state.town.data.market_event.end_epoch)
              ? 1n
              : BigInt(r.supply),
            BigInt(r.target) > promised ? BigInt(r.target) - promised : 0n,
            1000n -
              held -
              BigInt(ledger.inventory.production_output_reserved[a.item_id]) -
              BigInt(ledger.inventory.trade_inbound_reserved[a.item_id]),
          ].reduce((x, y) => (x < y ? x : y));
        ledger.inventory.held[a.item_id] = (held + amount).toString();
        ledger.inventory.available[a.item_id] = (
          BigInt(ledger.inventory.available[a.item_id]) + amount
        ).toString();
        state.markers.raw_epochs[a.item_id] = a.epoch;
        outcome = {
          kind: "raw_supplied",
          item_id: a.item_id,
          merchant_id: name,
          epoch: a.epoch,
          issued_quantity: amount.toString(),
          market_event: clone(state.town.data.market_event),
        };
      } else {
        const excess = BigInt(ledger.gold.available) - 200n,
          burn = excess <= 0n ? 0n : excess < 100n ? excess : 100n;
        ledger.gold.held = (BigInt(ledger.gold.held) - burn).toString();
        ledger.gold.available = (
          BigInt(ledger.gold.available) - burn
        ).toString();
        state.markers.treasury_epochs[name] = a.epoch;
        outcome = {
          kind: "treasury_swept",
          merchant_id: name,
          epoch: a.epoch,
          burned_gold: burn.toString(),
        };
      }
      ledger.revision = (BigInt(ledger.revision) + 1n).toString();
      outcome.ledger = clone(ledger);
    } else {
      const i = names.indexOf(lane),
        ledger = state.town.data.npc_ledgers[i];
      if (method === "set_listing") {
        const listing = state.listings.find(
          (l) => l.owner.merchant_id === lane && l.item_id === a.item_id,
        );
        listing.remaining_quantity = a.quantity;
        listing.unit_price = a.unit_price;
        listing.active = a.quantity !== "0";
        listing.revision = (BigInt(listing.revision) + 1n).toString();
        ledger.inventory.listing_reserved[a.item_id] = a.quantity;
        ledger.inventory.available[a.item_id] = (
          BigInt(ledger.inventory.held[a.item_id]) -
          BigInt(a.quantity) -
          BigInt(ledger.inventory.trade_reserved[a.item_id])
        ).toString();
        ledger.revision = (BigInt(ledger.revision) + 1n).toString();
        outcome = {
          kind: "listing_set",
          listing: clone(listing),
          ledger: clone(ledger),
        };
      } else if (method === "start_production") {
        const zero = Object.fromEntries(items.map((k) => [k, "0"])),
          start = state.town.block_timestamp_ns;
        const job = {
          recipe_id: "iron_tool",
          recipe_version: "1",
          config_version: "1",
          quantity: "1",
          inputs_consumed: { ...zero, wood: "1", iron: "2" },
          output_item: "iron_tool",
          output_quantity: "1",
          start_at_ns: start,
          ready_at_ns: (BigInt(start) + 180000000000n).toString(),
          job_id: String(state.jobs.length + 1),
          shop_id: "3",
          owner: { kind: "merchant", merchant_id: lane },
          completed_at_ns: null,
          status: "running",
          start_command_sequence: a.command.sequence,
          revision: "1",
        };
        for (const [item, n] of [
          ["wood", 1n],
          ["iron", 2n],
        ]) {
          ledger.inventory.held[item] = (
            BigInt(ledger.inventory.held[item]) - n
          ).toString();
          ledger.inventory.available[item] = (
            BigInt(ledger.inventory.available[item]) - n
          ).toString();
        }
        ledger.inventory.production_output_reserved.iron_tool = "1";
        ledger.revision = (BigInt(ledger.revision) + 1n).toString();
        state.jobs.push(job);
        state.town.data.npc_shops[i].revision = (
          BigInt(state.town.data.npc_shops[i].revision) + 1n
        ).toString();
        outcome = {
          kind: "production_started",
          job: clone(job),
          ledger: clone(ledger),
        };
      } else if (method === "complete_production") {
        const job = state.jobs.find((j) => j.job_id === a.job_id);
        job.status = "completed";
        job.completed_at_ns = state.town.block_timestamp_ns;
        job.revision = "2";
        ledger.inventory.production_output_reserved.iron_tool = "0";
        ledger.inventory.held.iron_tool = (
          BigInt(ledger.inventory.held.iron_tool) + 1n
        ).toString();
        ledger.inventory.available.iron_tool = (
          BigInt(ledger.inventory.available.iron_tool) + 1n
        ).toString();
        ledger.revision = (BigInt(ledger.revision) + 1n).toString();
        state.town.data.npc_shops[i].revision = (
          BigInt(state.town.data.npc_shops[i].revision) + 1n
        ).toString();
        outcome = {
          kind: "production_completed",
          job: clone(job),
          ledger: clone(ledger),
        };
      } else throw Error("unexpected model method");
    }
    state.town.market_revision = state.town.event_sequence = rev;
    const digest =
      method === "complete_production"
        ? null
        : await livingTownCommandDigest(
            identity.deployment,
            p.signerId,
            p.call,
          );
    const effect = {
      principal: method === "complete_production" ? null : principal,
      command_sequence: a.command?.sequence ?? null,
      payload_sha256: digest,
      replayed: false,
      effect_revision: rev,
      effect_event_sequence: rev,
      outcome,
    };
    if (a.command)
      state.commands[lane] = {
        sequence: a.command.sequence,
        digest,
        effect: clone(effect),
        method,
      };
    state.nonce[lane] = p.nonce;
    state.results[p.transactionHash] = {
      kind: "succeeded",
      transactionHash: p.transactionHash,
      result: pin(effect),
      executionReceiptId: capture.setup[0].receipt.receipts_outcome[0].id,
      block: {
        hash: capture.setup[0].block.header.hash,
        height: state.town.block_height,
        timestampNs: state.town.block_timestamp_ns,
      },
    };
    save();
    die("after_network");
    if (mode === "timeout_after") throw Error("controlled post-send timeout");
    return { transaction: { hash: p.transactionHash } };
  }
  for (const lane of lanes) {
    const signer = KeyPairEd25519.fromRandom(),
      publicKey = (await signer.getPublicKey()).toString();
    const adapter = new TownChainAdapter(
      identity,
      async (method) => {
        if (method !== "send_tx") throw Error("unexpected RPC");
        return send(lane);
      },
      {
        publicKey,
        loadSecretKey: async () => {
          assertPrepared();
          stats.sign++;
          die("before_sign");
          return signer.toString();
        },
      },
      lane,
      assistant ? "town_operator" : "town_source",
    );
    function assertPrepared() {
      if (store.unresolved()[0]?.status !== "prepared")
        throw Error("key loaded before durable intent");
    }
    adapter.client.finalized = async () => ({
      identity,
      block: {
        hash: capture.setup[0].block.header.hash,
        height: state.town.block_height,
        timestampNs: state.town.block_timestamp_ns,
      },
      getTown: async () => clone(state.town),
      getFoundation: async () =>
        pin({
          ...f.data,
          supported_methods: negotiated
            ? [
                ...f.data.supported_methods.filter(
                  (m) => m !== "merchant_purchase",
                ),
                "propose_trade",
                "accept_trade",
                "reject_trade",
                "cancel_trade",
                "expire_offers",
                "get_offer",
                "get_offers",
                "get_merchant_trading_rules",
              ]
            : f.data.supported_methods,
        }),
      getPendingMerchantOffers: async () => ({
        town: clone(state.town),
        offers: clone(
          (state.offers ?? [])
            .filter((o) => o.status === "pending")
            .map((o) => ({
              ...o,
              expired:
                BigInt(state.town.block_timestamp_ns) >=
                BigInt(o.expires_at_ns),
            })),
        ),
      }),
      getOffer: async (id) => {
        const offer = (state.offers ?? []).find((o) => o.offer_id === id);
        return pin(
          offer
            ? {
                kind: "found",
                offer: {
                  ...offer,
                  expired:
                    offer.status === "expired" ||
                    (offer.status === "pending" &&
                      BigInt(state.town.block_timestamp_ns) >=
                        BigInt(offer.expires_at_ns)),
                },
              }
            : { kind: "not_found", offer_id: id },
        );
      },
      getShop: async () => pin(state.assistantShop),
      getShopInventory: async () => pin(state.assistantLedger),
      getAssistantPolicy: async () => pin(state.assistantPolicy),
      getListings: async () =>
        pin({ items: [clone(state.assistantListing)], has_more: false }),
      getSourceState: async () => pin(state.markers),
      getMarketEvents: async () =>
        pin({
          items: state.town.data.market_event
            ? [state.town.data.market_event]
            : [],
          pruned_through: "0",
        }),
      getAccessKey: async (account) => {
        const keyLane =
          names.find((m) => identity.controllers[m] === account) ?? "operator";
        return {
          nonce: state.nonce[keyLane],
          permission: {
            FunctionCall: {
              receiver_id: identity.deployment.contract_id,
              allowance: "10000000000000000000000",
              method_names:
                keyLane === "operator"
                  ? [...(assistant ? townOperatorMethods : townSourceMethods)]
                  : [
                      ...(negotiated
                        ? townNegotiatingMerchantMethods
                        : townMerchantMethods),
                    ],
            },
          },
          block_hash: capture.setup[0].block.header.hash,
          block_height: state.town.block_height,
        };
      },
      getCommand: async (principal, seq) => {
        const l = principal.startsWith("merchant:")
            ? principal.slice(9)
            : "operator",
          c = state.commands[l];
        return pin(
          BigInt(seq) > BigInt(c.sequence)
            ? {
                kind: "not_applied",
                high_water: c.sequence,
                next_sequence: (BigInt(c.sequence) + 1n).toString(),
              }
            : seq === c.sequence && c.effect
              ? {
                  kind: "found",
                  high_water: c.sequence,
                  payload_sha256: c.digest,
                  method: c.method,
                  effect: clone(c.effect),
                }
              : { kind: "pruned", high_water: c.sequence, sequence: seq },
        );
      },
    });
    adapter.client.receipt = adapter.client.completionReceipt = async (p) =>
      state.hideReceipts
        ? { kind: "unknown", transactionHash: p.transactionHash }
        : clone(
            state.results[p.transactionHash] ?? {
              kind: "unknown",
              transactionHash: p.transactionHash,
            },
          );
    adapters[lane] = adapter;
  }
  const signed = store.saveTownSigned.bind(store);
  store.saveTownSigned = (...a) => {
    signed(...a);
    die("after_signed");
  };
  const broadcast = store.markBroadcast.bind(store);
  store.markBroadcast = (...a) => {
    broadcast(...a);
    if (a[1] === "unknown") die("after_unknown");
  };
  const policy = new LivingTownMerchantPolicy(config),
    scheduler = new LivingTownTickScheduler(
      store,
      new LivingTownCustomerDemand(config),
      30000,
      fundOnlyWhenNeeded,
    );
  let customerRunner = { poll: async () => ({ kind: "idle" }) },
    customers = {
      recover: async () => ({ kind: "ready", reasons: [], unresolved: 0 }),
    };
  if (realCustomers) {
    const key = KeyPairEd25519.fromRandom();
    const customerAdapter = new CustomerChainAdapter(
      identity,
      async () => {
        throw Error(
          "no funded product action expected in this controlled empty-market test",
        );
      },
      {
        publicKey: (await key.getPublicKey()).toString(),
        loadSecretKey: async () => {
          throw Error("no customer signing expected");
        },
      },
    );
    customerAdapter.client.finalized = adapters.operator.client.finalized;
    customers = new DurableCustomerExecutor(
      store,
      new LivingTownCustomerDemand(config),
      customerAdapter,
      verifyContinuity,
    );
    customerRunner = new LivingTownTickRunner(
      store,
      scheduler,
      customers,
      customerAdapter.client,
      async () => ({
        town: clone(state.town),
        fresh: true,
        marketComplete: true,
        historyComplete: true,
        candidates: [],
      }),
      operations,
    );
  }
  const simulation = new LivingTownSimulationAdapter(
    store,
    scheduler,
    customers,
    customerRunner,
    adapters,
    policy,
    collect,
    verifyContinuity,
    propose
      ? async (c) => {
          stats.model++;
          return propose(c);
        }
      : undefined,
    assistant,
    operations,
    simulationOptions,
  );
  return {
    store,
    state,
    stats,
    adapters,
    policy,
    scheduler,
    simulation,
    collect,
    save,
    close: () => store.close(),
    mode: (v) => {
      mode = v;
    },
  };
}
