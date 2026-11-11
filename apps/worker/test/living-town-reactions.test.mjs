import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  adapterFixture,
  closeAdapterFixturesAt,
} from "./fixtures/living-town-adapter.mjs";
import { TownProposalDelivery } from "../dist/private/living-town/proposals.js";
import { TownOperations } from "../dist/private/living-town/operations.js";
import { RuntimeBudget } from "../dist/private/living-town/runtime-budget.js";
import { LivingTownProviderRunner } from "../dist/private/living-town/provider.js";

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-purchase-reactions-"));
  t.after(() => {
    closeAdapterFixturesAt(dir);
    assert(
      resolve(dir).startsWith(resolve(tmpdir(), "bazaar-purchase-reactions-")),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  let f;
  const propose = async (c) => {
    calls.push(structuredClone(c));
    if (options.propose) return options.propose(c);
    const role = f.store.reactions.work(c.reaction.stepId).role;
    const action =
      options.choose?.(c, role) ??
      (role === "buyer"
        ? {
            type: "propose_trade",
            side: "buy",
            counterparty: "luna",
            item_id: "crystal",
            quantity: "2",
            unit_price: "5",
          }
        : role === "seller"
          ? {
              type: "accept_trade",
              offer_id: c.facts.pendingOffers[0].offer_id,
              expected_offer_revision: "1",
            }
          : { type: "wait" });
    return new TownProposalDelivery(
      {
        schema: "living-town-proposal-v1",
        tick_id: c.tickId,
        market_revision: c.facts.town.market_revision,
        merchant_id: c.merchant,
        reason: "controlled independent reaction decision",
        action,
      },
      "model_proposal",
      `controlled:${c.reaction.stepId}`,
    );
  };
  async function open() {
    f = await adapterFixture(dir, {
      negotiated: true,
      propose,
      operations: options.operations,
      simulationOptions: options.simulationOptions,
    });
    return f;
  }
  await open();
  const api = {
    dir,
    calls,
    get f() {
      return f;
    },
    reopen: async () => {
      f.close();
      await open();
    },
    purchase: (quantity = 8) => {
      const t = f.state.town,
        l = t.data.npc_ledgers[0],
        q = BigInt(quantity),
        id = t.data.next_trade_id;
      l.inventory.held.crystal = String(BigInt(l.inventory.held.crystal) - q);
      l.inventory.listing_reserved.crystal = String(
        BigInt(l.inventory.listing_reserved.crystal) - q,
      );
      l.gold.held = String(BigInt(l.gold.held) + q * 4n);
      l.gold.available = String(BigInt(l.gold.available) + q * 4n);
      l.revision = String(BigInt(l.revision) + 1n);
      const listing = f.state.listings.find((l) => l.item_id === "crystal");
      listing.remaining_quantity = l.inventory.listing_reserved.crystal;
      listing.active = BigInt(listing.remaining_quantity) > 0n;
      listing.revision = String(BigInt(listing.revision) + 1n);
      t.market_revision = t.event_sequence = String(
        BigInt(t.market_revision) + 1n,
      );
      t.data.next_trade_id = String(BigInt(id) + 1n);
      const trade = {
        trade_id: id,
        kind: "raw_purchase",
        buyer: { kind: "player", account_id: "controlled-player.testnet" },
        seller: { kind: "merchant", merchant_id: "rex" },
        customer_pool_id: null,
        item_id: "crystal",
        quantity: String(quantity),
        unit_price: "4",
        total_price: String(q * 4n),
        listing_id: listing.listing_id,
        offer_id: null,
        consumed_quantity: "0",
        settled_at_ns: t.block_timestamp_ns,
        command_principal: "account:controlled-player.testnet",
        command_sequence: id,
        event_sequence: t.event_sequence,
      };
      f.state.trades.push(trade);
      f.state.externalPurchases.push(trade);
      f.save();
      return trade;
    },
    pump: async (predicate, max = 30) => {
      for (let n = 0; n < max; n++) {
        if (predicate()) return;
        await f.simulation.poll();
      }
      assert(
        predicate(),
        "controlled bounded loop did not reach expected state",
      );
    },
  };
  return api;
}

test("one finalized player purchase drives buyer, recipient, settlement and bounded followups", async (t) => {
  const a = await fixture(t);
  a.purchase();
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  const root = a.f.store.reactions.roots()[0],
    offer = a.f.store.offers.get(String(root.offer_id));
  assert.equal(root.close_reason, "accepted");
  const activity = a.f.store.publicActivity().records;
  assert(
    activity.some(
      (r) =>
        r.data.merchant === "rex" && r.data.proposal_type === "propose_trade",
    ),
  );
  assert(
    activity.some(
      (r) =>
        r.data.merchant === "luna" &&
        r.data.proposal_type === "accept_trade" &&
        r.data.offer_id === root.offer_id,
    ),
  );
  assert(
    activity.every(
      (r) => r.data.outcome !== "confirmed" && r.data.transaction_hash === null,
    ),
  );
  assert(!JSON.stringify(activity).includes("signed_json"));
  assert.equal(root.trade_id, offer.trade_id);
  assert.equal(root.proposals, 1);
  assert(root.model_calls <= 6);
  assert(root.mutations <= 8);
  assert.deepEqual(
    a.calls.slice(0, 2).map((c) => c.merchant),
    ["rex", "luna"],
  );
  assert.equal(a.calls[1].facts.pendingOffers[0].offer_id, root.offer_id);
  assert.equal(a.calls[0].reaction.rootId, a.calls[1].reaction.rootId);
  assert.deepEqual(
    a.f.state.town.data.npc_ledgers.map((l) => l.inventory.held.crystal),
    ["6", "2", "7"],
  );
  assert.deepEqual(
    a.f.state.town.data.npc_ledgers.map((l) => l.gold.held),
    ["222", "210", "200"],
  );
  assert.equal(
    a.f.store.reactions.roots().filter((r) => r.kind === "purchase").length,
    1,
  );
  assert(
    a.f.store.reactions
      .steps(String(root.id))
      .every((s) => s.state === "completed"),
  );
});
test("purchase replays and two purchases during negotiation coalesce without duplicate inference", async (t) => {
  const a = await fixture(t);
  const trade = a.purchase(8);
  a.f.state.externalPurchases.push(structuredClone(trade));
  await a.f.simulation.poll();
  const root = a.f.store.reactions.roots()[0];
  a.purchase(1);
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(a.f.store.reactions.roots().length, 1);
  assert.equal(
    a.calls.filter(
      (c) => a.f.store.reactions.work(c.reaction.stepId).role === "buyer",
    ).length,
    1,
  );
  assert.equal(a.f.store.reactions.cursor(), "2");
  assert.equal(a.f.store.reactions.roots()[0].id, root.id);
  assert.equal(a.f.store.reactions.roots()[0].close_reason, "accepted");
});
test("peer transfers and ordinary worker listings never create another paid purchase root", async (t) => {
  const a = await fixture(t);
  a.purchase();
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  const paid = a.calls.length;
  for (let n = 0; n < 10; n++) await a.f.simulation.poll();
  assert.equal(a.f.store.reactions.roots().length, 1);
  assert.equal(a.calls.length, paid);
  assert(a.f.state.trades.some((t) => t.kind === "merchant_trade"));
});
test("a recipient refusal releases promises without a transfer or another trade attempt", async (t) => {
  const a = await fixture(t, {
    choose: (_c, role) =>
      role === "seller" ? { type: "reject_trade", offer_id: "1" } : undefined,
  });
  a.purchase();
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  const root = a.f.store.reactions.roots()[0];
  assert.equal(root.close_reason, "rejected");
  assert.equal(root.trade_id, null);
  assert.equal(root.proposals, 1);
  assert.equal(
    a.f.state.town.data.npc_ledgers[0].inventory.trade_inbound_reserved.crystal,
    "0",
  );
  assert.equal(a.f.state.town.data.npc_ledgers[1].inventory.held.crystal, "4");
});
test("recipient wait retains the offer until expiry; cleanup makes no model call", async (t) => {
  const a = await fixture(t, {
    choose: (_c, role) => (role === "seller" ? { type: "wait" } : undefined),
  });
  a.purchase();
  await a.pump(
    () => a.calls.length === 2 && a.f.store.unresolved().length === 0,
  );
  const root = a.f.store.reactions.roots()[0],
    offer = a.f.store.offers.get(String(root.offer_id));
  assert.equal(offer.status, "pending");
  a.f.state.town.block_timestamp_ns = offer.expires_at_ns;
  a.f.state.town.data.epoch = String(
    (BigInt(offer.expires_at_ns) -
      BigInt(a.f.state.town.data.genesis_time_ns)) /
      60000000000n,
  );
  a.f.state.town.data.customer_pool.epoch = a.f.state.town.data.epoch;
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(a.f.store.offers.get(offer.offer_id).status, "expired");
  assert.equal(a.calls.length, 2);
  assert.equal(a.f.state.town.data.npc_ledgers[0].gold.trade_reserved, "0");
});
test("restart after proposal broadcast recovers the original call and wakes the seller", async (t) => {
  const a = await fixture(t);
  a.purchase();
  a.f.mode("timeout_after");
  await a.f.simulation.poll();
  assert.equal(a.f.store.unresolved().length, 1);
  const original = a.f.store.unresolved()[0];
  await a.reopen();
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(
    a.calls.filter(
      (c) =>
        c.merchant === "rex" &&
        a.f.store.reactions.work(c.reaction.stepId).role === "buyer",
    ).length,
    1,
  );
  assert.equal(a.f.state.offers.length, 1);
  assert.equal(a.f.state.commands.rex.sequence, original.action_id);
  assert.equal(a.f.store.reactions.roots()[0].close_reason, "accepted");
});
test("a committed receipt cannot lose its recipient wake between recovery and the next poll", async (t) => {
  const a = await fixture(t);
  a.purchase();
  await a.f.simulation.poll();
  await a.f.simulation.runtime.recover();
  assert.equal(a.f.store.reactions.roots()[0].offer_id, "1");
  await a.reopen();
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(a.f.state.offers.length, 1);
  assert.equal(
    a.calls.filter(
      (c) =>
        c.merchant === "luna" &&
        a.f.store.reactions.work(c.reaction.stepId).role === "seller",
    ).length,
    1,
  );
});
test("pause and restart preserve an unknown acceptance without a new signature or inference", async (t) => {
  const operations = new TownOperations("simulation");
  operations.setMode("active");
  const a = await fixture(t, { operations });
  a.purchase();
  await a.f.simulation.poll();
  a.f.mode("timeout_before");
  await a.f.simulation.poll();
  assert.equal(a.f.store.unresolved()[0].method, "accept_trade");
  assert(
    a.f.store
      .publicActivity()
      .records.some(
        (r) =>
          r.data.proposal_type === "accept_trade" &&
          r.data.outcome === "unknown",
      ),
  );
  const calls = a.calls.length,
    signed = a.f.store.unresolved()[0].signed_json;
  operations.setMode("paused");
  await a.f.simulation.poll();
  await a.reopen();
  operations.setMode("active");
  const result = await a.f.simulation.poll();
  assert.equal(result.kind, "blocked");
  assert.equal(a.f.store.unresolved()[0].signed_json, signed);
  assert.equal(a.calls.length, calls);
  assert.equal(a.f.state.offers[0].status, "pending");
});
test("source refill invalidates seller acceptance and root cleanup still releases the original buyer reservation", async (t) => {
  const a = await fixture(t);
  a.purchase();
  await a.f.simulation.poll();
  const l = a.f.state.town.data.npc_ledgers[0];
  l.inventory.held.crystal = "10";
  l.inventory.available.crystal = "8";
  l.revision = String(BigInt(l.revision) + 1n);
  a.f.state.town.market_revision = a.f.state.town.event_sequence = String(
    BigInt(a.f.state.town.market_revision) + 1n,
  );
  await a.f.simulation.poll();
  assert.equal(a.f.state.offers[0].status, "pending");
  assert.equal(a.f.state.offers[0].trade_id, null);
  const offer = a.f.state.offers[0];
  a.f.state.town.block_timestamp_ns = offer.expires_at_ns;
  a.f.state.town.data.epoch = String(
    (BigInt(offer.expires_at_ns) -
      BigInt(a.f.state.town.data.genesis_time_ns)) /
      60000000000n,
  );
  a.f.state.town.data.customer_pool.epoch = a.f.state.town.data.epoch;
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(a.f.state.offers[0].status, "expired");
});
test("persisted model/mutation ceilings and late roots deny inference before dispatch", async (t) => {
  const a = await fixture(t);
  a.purchase();
  await a.f.simulation.runtime.recover();
  const input = await a.f.collect();
  a.f.store.reactions.observe(input);
  const work = a.f.store.reactions.next(input, a.f.store.offers);
  a.f.close();
  const db = new DatabaseSync(join(a.dir, "worker.sqlite"));
  db.prepare(
    "UPDATE reaction_roots SET model_calls=6,mutations=7 WHERE id=?",
  ).run(work.rootId);
  db.close();
  await a.reopen();
  await a.f.simulation.poll();
  assert.equal(a.calls.length, 0);
  assert.equal(a.f.store.reactions.roots()[0].model_calls, 6);
  assert.equal(a.f.store.reactions.roots()[0].mutations, 7);
});

test("seller listing preparation and acceptance are distinct bounded durable mutations", async (t) => {
  const a = await fixture(t);
  a.purchase();
  const l = a.f.state.town.data.npc_ledgers[1];
  l.inventory.listing_reserved.crystal = "2";
  l.inventory.available.crystal = "2";
  a.f.state.listings.push({
    listing_id: "5",
    shop_id: "2",
    owner: { kind: "merchant", merchant_id: "luna" },
    item_id: "crystal",
    remaining_quantity: "2",
    unit_price: "5",
    revision: "1",
    active: true,
  });
  a.f.save();
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  const root = a.f.store.reactions.roots()[0],
    steps = a.f.store.reactions.steps(String(root.id));
  assert.equal(root.close_reason, "accepted");
  assert(steps.some((s) => s.role === "acceptance"));
  const seller = steps.find((s) => s.role === "seller"),
    continuation = steps.find((s) => s.role === "acceptance");
  assert.equal(
    JSON.parse(seller.decision_json).tradePhase,
    "seller_listing_release",
  );
  assert.equal(
    JSON.parse(continuation.decision_json).tradePhase,
    "seller_acceptance",
  );
  assert.equal(
    JSON.parse(seller.decision_json).inferenceRef,
    JSON.parse(continuation.decision_json).inferenceRef,
  );
  assert.equal(
    a.calls.filter(
      (c) => a.f.store.reactions.work(c.reaction.stepId).role === "seller",
    ).length,
    1,
  );
  assert(root.mutations >= 3 && root.mutations <= 8);
});
test("a late purchase root closes without paying for an unserviceable buyer turn", async (t) => {
  const a = await fixture(t);
  a.purchase();
  a.f.state.town.block_timestamp_ns = String(
    BigInt(a.f.state.town.block_timestamp_ns) + 511000000000n,
  );
  a.f.state.town.data.epoch = String(
    (BigInt(a.f.state.town.block_timestamp_ns) -
      BigInt(a.f.state.town.data.genesis_time_ns)) /
      60000000000n,
  );
  a.f.state.town.data.customer_pool.epoch = a.f.state.town.data.epoch;
  await a.f.simulation.poll();
  assert.equal(a.calls.length, 0);
  assert.equal(
    a.f.store.reactions.roots()[0].close_reason,
    "insufficient_root_window",
  );
});
test("control change after inference stops signing and the persisted attempt resumes safely", async (t) => {
  let allowed = true;
  const a = await fixture(t, {
    simulationOptions: { admission: () => allowed },
    choose: (_c, role) => {
      if (role === "buyer") allowed = false;
      return undefined;
    },
  });
  a.purchase();
  await a.f.simulation.poll();
  assert.equal(a.f.stats.sign, 0);
  assert.equal(a.f.store.reactions.roots()[0].model_calls, 1);
  // A real provider runner supplies the cached result on resume; this fixture waits instead.
  allowed = true;
  assert.equal(
    a.f.store.reactions.steps(a.f.store.reactions.roots()[0].id)[0]
      .model_reserved,
    1,
  );
});
test("root-scoped real provider caching survives a crash before decision persistence", async (t) => {
  const budgetDir = mkdtempSync(join(tmpdir(), "bazaar-reaction-budget-")),
    authority = new RuntimeBudget(
      join(budgetDir, "budget"),
      join(budgetDir, "witness"),
      true,
    );
  t.after(() => {
    authority.close();
    assert(
      resolve(budgetDir).startsWith(
        resolve(tmpdir(), "bazaar-reaction-budget-"),
      ),
    );
    rmSync(budgetDir, { recursive: true, force: true });
  });
  let runner,
    currentContext,
    invocations = 0;
  const a = await fixture(t, { propose: (c) => runner.propose(c) });
  function configure() {
    runner = new LivingTownProviderRunner(
      a.f.store,
      a.f.policy,
      authority.budget,
      authority.binding,
      {
        provider: "controlled",
        model: "controlled-model",
        promptVersion: "controlled-fixture",
        prepare: (c) => {
          currentContext = c;
          return {
            provider: "controlled",
            model: "controlled-model",
            payload: JSON.stringify({ merchant: c.merchant, root: c.reaction }),
            maxOutputTokens: 512,
            countTokens: () => 100,
            accountingEvidence: "controlled:count",
            worstInputMicroPerMillion: 100000,
            outputMicroPerMillion: 100000,
            pricingEvidence: "controlled:quote",
            verifiedUntil: Date.now() + 60000,
          };
        },
        invoke: async (invocation) => {
          invocations++;
          invocation.reportIdentity({
            provider: "controlled",
            model: "controlled-model",
          });
          const c = currentContext,
            role = a.f.store.reactions.work(c.reaction.stepId).role;
          return {
            schema: "living-town-proposal-v1",
            tick_id: c.tickId,
            market_revision: c.facts.town.market_revision,
            merchant_id: c.merchant,
            reason: "controlled provider root turn",
            action:
              role === "buyer"
                ? {
                    type: "propose_trade",
                    side: "buy",
                    counterparty: "luna",
                    item_id: "crystal",
                    quantity: "2",
                    unit_price: "5",
                  }
                : role === "seller"
                  ? {
                      type: "accept_trade",
                      offer_id: "1",
                      expected_offer_revision: "1",
                    }
                  : { type: "wait" },
          };
        },
      },
      async () => true,
      1000,
      "wait",
    );
  }
  configure();
  a.purchase();
  a.f.store.reactions.decide = () => {
    throw Error("controlled crash before reaction decision save");
  };
  await assert.rejects(() => a.f.simulation.poll(), /controlled crash/);
  assert.equal(invocations, 1);
  await a.reopen();
  configure();
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(invocations, 5);
  assert.equal(authority.budget.history().entries.length, 5);
  assert.equal(a.f.store.reactions.roots()[0].model_calls, 5);
  assert.equal(a.f.state.offers.length, 1);
});
test("actual process death after proposal send retains one offer and recipient wake", async (t) => {
  const a = await fixture(t);
  a.purchase();
  a.f.close();
  const child = spawnSync(
    process.execPath,
    ["apps/worker/test/fixtures/living-town-reaction-child.mjs", a.dir],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.notEqual(child.status, 0);
  await a.reopen();
  assert.equal(a.f.store.unresolved()[0].method, "propose_trade");
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(a.f.state.offers.length, 1);
  assert.equal(
    a.calls.filter(
      (c) => a.f.store.reactions.work(c.reaction.stepId).role === "buyer",
    ).length,
    0,
  );
  assert.equal(a.f.store.reactions.roots()[0].close_reason, "accepted");
});

test("idle finalized blocks cannot slide the persisted buyer offer expiry before signing", async (t) => {
  const a = await fixture(t);
  a.purchase();
  const original = a.f.adapters.rex.client.finalized.bind(
    a.f.adapters.rex.client,
  );
  let advanced = false;
  a.f.adapters.rex.client.finalized = async () => {
    if (!advanced && a.f.store.unresolved()[0]?.status === "prepared") {
      advanced = true;
      a.f.state.town.block_timestamp_ns = String(
        BigInt(a.f.state.town.block_timestamp_ns) + 1000000000n,
      );
      a.f.state.town.block_height = String(
        BigInt(a.f.state.town.block_height) + 1n,
      );
    }
    return original();
  };
  await a.f.simulation.poll();
  assert(advanced);
  assert.equal(a.f.store.unresolved()[0]?.method, "propose_trade");
  const root = a.f.store.reactions.roots()[0],
    step = a.f.store.reactions.steps(String(root.id))[0],
    decision = JSON.parse(step.decision_json);
  assert.equal(a.f.state.offers[0].expires_at_ns, decision.offerExpiryNs);
  await a.pump(() => a.f.store.reactions.roots()[0]?.state === "closed");
  assert.equal(a.f.state.offers.length, 1);
  assert.equal(a.f.store.reactions.roots()[0].close_reason, "accepted");
});
