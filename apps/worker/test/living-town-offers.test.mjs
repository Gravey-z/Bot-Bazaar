import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { KeyPairEd25519 } from "near-api-js";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  livingTownCommandDigest,
  checkPendingOfferReservations,
  offerMaterialRules,
  livingTownTradingRules,
  livingTownIndexedReceipt,
} from "../../../packages/chain/dist/index.js";
import { LivingTownExecutionStore } from "../dist/private/living-town/execution-store.js";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import { RuntimeFacts } from "../dist/private/living-town/runtime-facts.js";
import { DurableTownExecutor } from "../dist/private/living-town/town-executor.js";
import {
  TownChainAdapter,
  townCall,
} from "../dist/private/living-town/town-chain.js";
import {
  assertRuntimePermission,
  townNegotiatingMerchantMethods,
  townMerchantMethods,
  townTradingMerchantMethods,
} from "../dist/private/near-signer.js";
const read = (p) => JSON.parse(readFileSync(p, "utf8")),
  clone = structuredClone;
const cap = read(
    "tests/fixtures/chain/living-town-merchant-offers-sandbox.json",
  ),
  cfg = read("config/living-town-v1.json"),
  names = ["rex", "luna", "bolt"],
  lanes = [...names, "operator"],
  items = cfg.items;
const rows = await Promise.all(
  cap.steps.map(async (step) => {
    const call = createLivingTownCall(step.method, step.args),
      proof = {
        call,
        transactionHash: step.transaction_hash,
        signerId: step.signer_id,
        deployment: step.foundation.deployment,
        referenceBlockHeight: step.reference_block_height,
      };
    const status = await verifyLivingTownReceipt(
      step.receipt,
      proof,
      async (hash) => ({
        hash,
        height: String(step.block.header.height),
        timestampNs: step.block.header.timestamp_nanosec,
      }),
    );
    assert.equal(status.kind, "succeeded");
    return {
      step,
      proof,
      status,
      indexed: livingTownIndexedReceipt(proof, {
        status,
        response: step.receipt,
      }),
    };
  }),
);
const identity = {
  deployment: cap.foundation.deployment,
  codeHash: cap.steps[0].account.code_hash,
  ownerId: cap.foundation.data.owner_account_id,
  operatorId: cap.foundation.data.operator_account_id,
  controllers: cap.foundation.data.merchant_controllers,
};
const rules = livingTownTradingRules({
  schema: "merchant-offers-v1",
  items: items.slice(0, 4),
  quantity_cap: "2",
  backup_cap: "2",
  operating_gold: { rex: "80", luna: "120", bolt: "60" },
  max_pending_global: "12",
  max_pending_per_merchant: "8",
  terminal_retention: "128",
  min_offer_lifetime_seconds: "60",
  max_offer_lifetime_seconds: "600",
  materials: offerMaterialRules,
});

// Real SQLite, signed transaction bytes and SDK effect verification. Finalized
// reads/receipt transport are controlled; these are not additional chain or AI runs.
async function fixture(t, { accept = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-offer-execution-"));
  let store, executor;
  const cleanups = [];
  const key = KeyPairEd25519.fromRandom(),
    counts = { sign: 0, send: 0 };
  const town = clone(cap.low);
  town.data.next_trade_id = "1";
  town.data.next_offer_id = "1";
  for (const [i, n] of town.data.npc_ledgers.entries()) {
    n.revision = "1";
    n.gold = {
      held: "200",
      available: "200",
      trade_reserved: "0",
      trade_inbound_reserved: "0",
    };
    for (const item of items) {
      const r = cfg.economy.materials[item],
        held = r?.supplier === names[i] ? r.seed : "0",
        listed = r?.supplier === names[i] ? r.listed : "0";
      n.inventory.held[item] = held;
      n.inventory.listing_reserved[item] = listed;
      n.inventory.available[item] = String(BigInt(held) - BigInt(listed));
      for (const k of [
        "trade_reserved",
        "production_output_reserved",
        "trade_inbound_reserved",
      ])
        n.inventory[k][item] = "0";
    }
  }
  let block = clone(rows[1].status.block);
  Object.assign(town, {
    market_revision: rows[0].status.result.market_revision,
    event_sequence: rows[0].status.result.event_sequence,
    block_height: block.height,
    block_timestamp_ns: block.timestampNs,
  });
  let pending = [],
    keys = [...townNegotiatingMerchantMethods],
    mode = "unknown_after",
    receiptKnown = false,
    alreadyApplied = false,
    pruned = false;
  const checkpoints = Object.fromEntries(
    lanes.map((l) => [
      l,
      { sequence: "0", digest: null, effect: null, method: null },
    ]),
  );
  function applyRow(row) {
    const r = row.status.result,
      o = r.data.outcome;
    for (const l of [o.buyer, o.seller, o.ledger].filter(Boolean)) {
      if (l.actor.kind === "merchant")
        town.data.npc_ledgers[names.indexOf(l.actor.merchant_id)] = clone(l);
    }
    if (o.offer) {
      pending = pending.filter((x) => x.offer_id !== o.offer.offer_id);
      if (o.offer.status === "pending") pending.push(clone(o.offer));
      town.data.next_offer_id = String(BigInt(o.offer.offer_id) + 1n);
    }
    if (o.trade)
      town.data.next_trade_id = String(BigInt(o.trade.trade_id) + 1n);
    if (r.data.principal?.startsWith("merchant:"))
      checkpoints[r.data.principal.slice(9)] = {
        sequence: r.data.command_sequence,
        digest: r.data.payload_sha256,
        effect: clone(r.data),
        method: row.step.method,
      };
    block = clone(row.status.block);
    Object.assign(town, {
      market_revision: r.market_revision,
      event_sequence: r.event_sequence,
      block_height: block.height,
      block_timestamp_ns: block.timestampNs,
    });
    town.data.epoch = String(
      (BigInt(block.timestampNs) - BigInt(town.data.genesis_time_ns)) /
        60000000000n,
    );
    town.data.customer_pool.epoch = town.data.epoch;
  }
  if (accept) {
    applyRow(rows[1]);
    applyRow(rows[3]);
  }
  const chosen = accept ? rows[4] : rows[1],
    lane = accept ? "rex" : "luna";
  const snapshot = () => clone(town),
    freshOffers = () =>
      pending.map((o) => ({
        ...clone(o),
        expired: BigInt(town.block_timestamp_ns) >= BigInt(o.expires_at_ns),
      }));
  const reader = {
    get block() {
      return clone(block);
    },
    identity,
    getTown: async () => snapshot(),
    getFoundation: async () => ({ ...snapshot(), data: cap.foundation.data }),
    getListings: async () => {
      const ids = { crystal: "1", herb: "2", wood: "3", iron: "4" };
      const listings = Object.entries(cfg.economy.materials)
        .map(([item, r]) => {
          const i = names.indexOf(r.supplier),
            quantity =
              town.data.npc_ledgers[i].inventory.listing_reserved[item];
          return {
            listing_id: ids[item],
            shop_id: String(i + 1),
            owner: { kind: "merchant", merchant_id: r.supplier },
            item_id: item,
            remaining_quantity: quantity,
            unit_price: r.price,
            revision: "1",
            active: quantity !== "0",
          };
        })
        .sort((a, b) => Number(a.listing_id) - Number(b.listing_id));
      return {
        ...snapshot(),
        data: {
          items: listings,
          next_after_id: "4",
          has_more: false,
          history_gap: false,
          pruned_through: "0",
        },
      };
    },
    getProductionJobs: async () => ({
      ...snapshot(),
      data: {
        items: [],
        next_after_id: null,
        has_more: false,
        history_gap: false,
        pruned_through: "0",
      },
    }),
    getPendingMerchantOffers: async () => {
      const offers = freshOffers();
      checkPendingOfferReservations(town.data.npc_ledgers, offers);
      return {
        town: snapshot(),
        rules: { ...snapshot(), data: rules },
        offers,
      };
    },
    getOffer: async (id) => ({
      ...snapshot(),
      data: pruned
        ? { kind: "pruned", offer_id: id }
        : pending.some((o) => o.offer_id === id)
          ? {
              kind: "found",
              offer: freshOffers().find((o) => o.offer_id === id),
            }
          : { kind: "not_found", offer_id: id },
    }),
    getAccessKey: async () => ({
      nonce: "0",
      permission: {
        FunctionCall: {
          receiver_id: identity.deployment.contract_id,
          allowance: "50000000000000000000000",
          method_names: keys,
        },
      },
      block_hash: block.hash,
      block_height: block.height,
    }),
    getCommand: async (principal, sequence) => {
      const c =
        checkpoints[
          principal.startsWith("merchant:") ? principal.slice(9) : "operator"
        ];
      return {
        ...snapshot(),
        data:
          c.sequence === sequence
            ? {
                kind: "found",
                high_water: c.sequence,
                method: c.method,
                payload_sha256: c.digest,
                effect: clone(c.effect),
              }
            : BigInt(sequence) <= BigInt(c.sequence)
              ? { kind: "pruned", high_water: c.sequence, sequence }
              : {
                  kind: "not_applied",
                  high_water: c.sequence,
                  next_sequence: String(BigInt(c.sequence) + 1n),
                },
      };
    },
  };
  const adapters = {};
  for (const l of lanes) {
    const a = new TownChainAdapter(
      identity,
      async () => {
        throw Error("no network");
      },
      {
        publicKey: key.getPublicKey().toString(),
        loadSecretKey: async () => {
          counts.sign++;
          return key.toString();
        },
      },
      l,
    );
    a.client.finalized = async () => reader;
    a.client.receipt = async (p) =>
      receiptKnown
        ? { ...clone(chosen.status), transactionHash: p.transactionHash }
        : { kind: "unknown", transactionHash: p.transactionHash };
    a.submit = async (p) => {
      counts.send++;
      if (mode !== "unknown_before" && !alreadyApplied) {
        applyRow(chosen);
        alreadyApplied = true;
      }
      return { kind: "unknown", transactionHash: p.transactionHash };
    };
    adapters[l] = a;
  }
  const continuity = async (c) => ({
    ...c,
    journal: "current",
    fencing: "verified",
    providerHistory: "accounted",
    evidenceRef: "controlled-offer-recovery",
  });
  const refresh = async () => chosen.proof.call;
  function open(create) {
    store = new LivingTownExecutionStore(dir, identity, "42", create);
    executor = new DurableTownExecutor(store, adapters, continuity, refresh);
  }
  open(true);
  if (accept) {
    // A pre-existing journal checkpoint, seeded only for this isolated test from
    // independently verified earlier receipts. Production enrollment is unchanged.
    store.close();
    const db = new DatabaseSync(join(dir, "worker.sqlite"));
    for (const l of lanes)
      if (checkpoints[l].sequence !== "0")
        db.prepare(
          "UPDATE merchants SET last_action_id=?,last_action_digest=? WHERE merchant_id=?",
        ).run(checkpoints[l].sequence, checkpoints[l].digest, l);
    db.close();
    open(false);
  }
  t.after(() => {
    for (const fn of cleanups) fn();
    store?.close();
    assert(
      resolve(dir).startsWith(resolve(tmpdir(), "bazaar-offer-execution-")),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const id = createHash("sha256")
    .update(dir + lane)
    .digest("hex");
  async function prepare() {
    assert.equal((await executor.recover()).kind, "ready");
    const slot =
        (BigInt(town.block_timestamp_ns) - BigInt(town.data.genesis_time_ns)) /
        30000000000n,
      arrival = `merchant:${lane}:${slot}`;
    store.ticks.prepare(
      { town: snapshot(), block: clone(block), codeHash: identity.codeHash },
      30000,
      [{ id, arrival }],
    );
    store.prepareTown(
      {
        id,
        tick: town.data.epoch,
        arrival,
        lane,
        decision: { controlled: true },
        call: chosen.proof.call,
        digest: await livingTownCommandDigest(
          identity.deployment,
          identity.controllers[lane],
          chosen.proof.call,
        ),
      },
      Date.now() + 60000,
    );
  }
  return {
    dir,
    id,
    lane,
    counts,
    reader,
    chosen,
    identity,
    get store() {
      return store;
    },
    get executor() {
      return executor;
    },
    adapters,
    prepare,
    snapshot,
    applyRow,
    addCleanup(fn) {
      cleanups.push(fn);
    },
    corruptBinding() {
      store.close();
      const db = new DatabaseSync(join(dir, "worker.sqlite"));
      const bound = JSON.parse(
        db
          .prepare(
            "SELECT offers_json FROM town_offer_bindings WHERE action_id=?",
          )
          .get(id).offers_json,
      );
      bound[0].unit_price = "5";
      bound[0].total_price = "10";
      db.prepare(
        "UPDATE town_offer_bindings SET offers_json=? WHERE action_id=?",
      ).run(JSON.stringify(bound), id);
      db.close();
      open(false);
    },
    reopen() {
      store.close();
      open(false);
    },
    mode(v) {
      mode = v;
    },
    known() {
      receiptKnown = true;
    },
    pruned(v) {
      pruned = v;
      pending = [];
      for (const l of town.data.npc_ledgers) {
        l.gold.available = l.gold.held;
        l.gold.trade_reserved = "0";
        for (const k of items) l.inventory.trade_inbound_reserved[k] = "0";
      }
    },
    expire() {
      town.block_timestamp_ns = String(
        BigInt(town.block_timestamp_ns) + 700000000000n,
      );
      town.block_height = String(BigInt(town.block_height) + 1n);
      town.data.epoch = String(
        (BigInt(town.block_timestamp_ns) - BigInt(town.data.genesis_time_ns)) /
          60000000000n,
      );
      town.data.customer_pool.epoch = town.data.epoch;
      block = {
        ...block,
        height: town.block_height,
        timestampNs: town.block_timestamp_ns,
      };
    },
    keys(v) {
      keys = v;
    },
  };
}

test("offer scope binds buyer/seller lanes and denies old or broadened keys", async (t) => {
  const f = await fixture(t),
    a = f.chosen.proof.call.args;
  assert.equal(townCall("propose_trade", a, "luna").method, "propose_trade");
  assert.throws(() => townCall("propose_trade", a, "rex"), /lane/);
  assert.throws(() => townCall("propose_trade", a, "operator"), /scope/);
  const permission = (methods) => ({
    FunctionCall: {
      receiver_id: identity.deployment.contract_id,
      allowance: "50000000000000000000000",
      method_names: methods,
    },
  });
  assertRuntimePermission(
    permission([...townNegotiatingMerchantMethods]),
    identity.deployment.contract_id,
    "town_negotiating_merchant",
  );
  for (const methods of [
    townMerchantMethods,
    townTradingMerchantMethods,
    [...townNegotiatingMerchantMethods, "merchant_purchase"],
  ])
    assert.throws(() =>
      assertRuntimePermission(
        permission(methods),
        identity.deployment.contract_id,
        "town_negotiating_merchant",
      ),
    );
  f.keys([...townMerchantMethods]);
  await assert.rejects(
    () => f.adapters.luna.prepare(f.chosen.proof.call, async () => {}),
    /scope|offers require/,
  );
  assert.equal(f.counts.sign, 0);
});
test("prepared and signed offer recovery reuse the original call and exactly one signature", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  assert.equal(f.store.get(f.id).status, "prepared");
  f.reopen();
  assert.equal((await f.executor.recover()).kind, "blocked");
  await f.executor.resume(f.id);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
  f.reopen();
  assert.equal((await f.executor.recover()).kind, "ready");
  assert.equal(f.store.get(f.id).status, "confirmed");
  assert.equal(f.store.get(f.id).offer_id, "1");
  assert.equal(f.store.offers.pending().length, 1);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});
test("unknown creation stays locked across restart and deadline without replacement signing", async (t) => {
  const f = await fixture(t);
  f.mode("unknown_before");
  await f.prepare();
  await f.executor.resume(f.id);
  f.reopen();
  f.expire();
  assert.equal((await f.executor.recover()).kind, "blocked");
  assert.equal(f.store.unresolved().length, 1);
  await assert.rejects(() => f.executor.resume(f.id), /unbroadcast/);
  assert.throws(() => f.store.abandon(f.id), /broadcast/);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});
test("unknown acceptance recovers the original settlement checkpoint with no second transfer", async (t) => {
  const f = await fixture(t, { accept: true });
  await f.prepare();
  await f.executor.resume(f.id);
  f.reopen();
  assert.equal((await f.executor.recover()).kind, "ready");
  assert.equal(f.store.get(f.id).status, "confirmed");
  assert.equal(f.store.offers.get("1").status, "accepted");
  assert.equal(f.store.offers.pending().length, 0);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});
test("expired pending offers retain commitments and pruned absence blocks reconciliation", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  await f.executor.resume(f.id);
  assert.equal((await f.executor.recover()).kind, "ready");
  f.expire();
  assert.equal((await f.executor.recover()).kind, "ready");
  assert.equal(f.store.offers.pending()[0].status, "pending");
  assert.equal(f.store.offers.pending()[0].expired, true);
  assert.throws(
    () => f.store.offers.bind("new", f.chosen.proof.call),
    /unresolved negotiation/,
  );
  f.pruned(true);
  await assert.rejects(() => f.executor.recover(), /terminal evidence/);
  assert.equal(f.store.offers.pending().length, 1);
  assert.equal(f.counts.send, 1);
});

test("a signed unsent offer survives restart and sends its stored bytes without resigning", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const signed = await f.adapters.luna.prepare(
    f.chosen.proof.call,
    async () => {},
  );
  f.store.saveTownSigned(f.id, signed);
  const bytes = f.store.get(f.id).signed_json;
  f.reopen();
  assert.equal((await f.executor.recover()).kind, "blocked");
  await f.executor.resume(f.id);
  assert.equal(f.store.get(f.id).signed_json, bytes);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
  assert.equal((await f.executor.recover()).kind, "ready");
});

test("verified receipt status recovers original acceptance without resigning", async (t) => {
  const f = await fixture(t, { accept: true });
  await f.prepare();
  await f.executor.resume(f.id);
  f.known();
  f.reopen();
  assert.equal((await f.executor.recover()).kind, "ready");
  assert.equal(f.store.offers.get("1").status, "accepted");
  assert.equal(f.counts.send, 1);
});

test("schema-1 identities cannot enable negotiation even with a new execution schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-offer-legacy-")),
    legacy = {
      ...identity,
      deployment: { ...identity.deployment, state_schema: "1" },
    };
  const store = new LivingTownExecutionStore(dir, legacy, "42", true);
  assert.equal(store.negotiatedTrading, false);
  assert.deepEqual(store.offers.pending(), []);
  store.close();
  assert(resolve(dir).startsWith(resolve(tmpdir(), "bazaar-offer-legacy-")));
  rmSync(dir, { recursive: true, force: true });
});

test("schema-2 projections apply reservation and settlement receipts once and survive reopen", async (t) => {
  const f = await fixture(t, { accept: true });
  let projection = new LivingTownProjectionStore(f.dir, identity, true);
  f.addCleanup(() => projection.close());
  const now = Date.now();
  const town = f.snapshot(),
    empty = {
      items: [],
      next_after_id: null,
      has_more: false,
      history_gap: false,
      pruned_through: "0",
    };
  const offer = rows[1].status.result.data.outcome.offer;
  projection.baseline(
    {
      block: f.reader.block,
      town,
      shops: [],
      production: ["1", "2", "3"].map((shopId) => ({
        shopId,
        pages: [{ ...town, data: empty }],
      })),
      offers: [
        { ...town, data: { ...empty, items: [offer], next_after_id: "1" } },
      ],
    },
    now,
  );
  assert.equal(projection.offers(now).snapshot.data[0].status, "pending");
  assert.equal(
    projection.inventory("2", now).snapshot.data.gold.trade_reserved,
    "8",
  );
  assert.equal(projection.commit(rows[4].indexed, now), "indexed");
  assert.equal(projection.offers(now).snapshot.data[0].status, "accepted");
  assert.equal(projection.inventory("2", now).snapshot.data.gold.held, "192");
  assert.equal(
    projection.inventory("2", now).snapshot.data.gold.trade_reserved,
    "0",
  );
  assert.equal(
    projection.inventory("1", now).snapshot.data.inventory.held.crystal,
    "8",
  );
  assert.equal(projection.commit(rows[4].indexed, now), "duplicate");
  projection.close();
  projection = new LivingTownProjectionStore(f.dir, identity);
  assert.equal(projection.offers(now).snapshot.data[0].status, "accepted");
  assert.equal(projection.inventory("1", now).snapshot.data.gold.held, "208");
  assert.equal(projection.commit(rows[4].indexed, now), "duplicate");
});

test("corrupted stored acceptance terms cannot confirm or release the pending obligation", async (t) => {
  const f = await fixture(t, { accept: true });
  await f.prepare();
  await f.executor.resume(f.id);
  f.corruptBinding();
  await assert.rejects(() => f.executor.recover(), /original offer terms/);
  assert.equal(f.store.get(f.id).status, "unknown");
  assert.equal(f.store.offers.pending().length, 1);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});

test("schema-2 runtime facts retain pending promises through restart and time expiry", async (t) => {
  const f = await fixture(t);
  let facts = new RuntimeFacts(f.dir, identity, true);
  f.addCleanup(() => facts.close());
  assert.deepEqual((await facts.collect(f.reader)).merchant.pendingOffers, []);
  await f.prepare();
  await f.executor.resume(f.id);
  const pending = await facts.collect(f.reader);
  assert.equal(pending.merchant.negotiatedTrading, true);
  assert.equal(pending.merchant.pendingOffers.length, 1);
  facts.close();
  facts = new RuntimeFacts(f.dir, identity, false);
  f.expire();
  const expired = await facts.collect(f.reader);
  assert.equal(expired.merchant.pendingOffers[0].expired, true);
  assert.equal(
    expired.merchant.town.data.npc_ledgers[1].gold.trade_reserved,
    "8",
  );
});

test("unversioned legacy facts remain readable with their original continuity digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-offer-facts-")),
    legacy = {
      ...identity,
      deployment: { ...identity.deployment, state_schema: "1" },
    };
  let facts = new RuntimeFacts(dir, legacy, true);
  const original = facts.digest();
  facts.close();
  const db = new DatabaseSync(join(dir, "facts.sqlite"));
  const legacyDigest = createHash("sha256")
    .update(
      JSON.stringify([
        db.prepare("SELECT * FROM facts").all(),
        db.prepare("SELECT * FROM trades ORDER BY id").all(),
        db.prepare("SELECT * FROM last_sales ORDER BY shop,item").all(),
      ]),
    )
    .digest("hex");
  assert.equal(original, legacyDigest);
  db.exec("PRAGMA user_version=0");
  db.close();
  facts = new RuntimeFacts(dir, legacy, false);
  assert.equal(facts.digest(), original);
  facts.close();
  assert(resolve(dir).startsWith(resolve(tmpdir(), "bazaar-offer-facts-")));
  rmSync(dir, { recursive: true, force: true });
});

test("finalized time updates an offer's expiry hint without releasing projection reservations", async (t) => {
  const f = await fixture(t, { accept: true });
  const projection = new LivingTownProjectionStore(f.dir, identity, true);
  f.addCleanup(() => projection.close());
  const now = Date.now(),
    town = f.snapshot(),
    empty = {
      items: [],
      next_after_id: null,
      has_more: false,
      history_gap: false,
      pruned_through: "0",
    },
    offer = rows[1].status.result.data.outcome.offer;
  projection.baseline(
    {
      block: f.reader.block,
      town,
      shops: [],
      production: ["1", "2", "3"].map((shopId) => ({
        shopId,
        pages: [{ ...town, data: empty }],
      })),
      offers: [
        { ...town, data: { ...empty, items: [offer], next_after_id: "1" } },
      ],
    },
    now,
  );
  const later = clone(town);
  later.block_height = String(BigInt(town.block_height) + 1n);
  later.block_timestamp_ns = String(BigInt(offer.expires_at_ns) + 1n);
  later.data.epoch = later.data.customer_pool.epoch = String(
    (BigInt(later.block_timestamp_ns) - BigInt(later.data.genesis_time_ns)) /
      60000000000n,
  );
  assert.equal(
    projection.observe(
      later,
      {
        hash: "11111111111111111111111111111111",
        height: later.block_height,
        timestampNs: later.block_timestamp_ns,
      },
      now + 1,
    ),
    true,
  );
  assert.equal(projection.offers(now + 1).snapshot.data[0].expired, true);
  assert.equal(projection.offers(now + 1).snapshot.data[0].status, "pending");
  assert.equal(
    projection.inventory("2", now + 1).snapshot.data.gold.trade_reserved,
    "8",
  );
});

test("a legacy execution version cannot admit offers even with schema-2 facts and keys", async (t) => {
  const f = await fixture(t);
  f.store.close();
  const db = new DatabaseSync(join(f.dir, "worker.sqlite"));
  db.exec("PRAGMA user_version=1008");
  db.close();
  f.reopen();
  assert.equal(f.store.negotiatedTrading, false);
  await assert.rejects(() => f.prepare(), /reconciliation required/);
  assert.equal(f.store.unresolved().length, 0);
  assert.equal(f.counts.sign, 0);
  assert.equal(f.counts.send, 0);
});
