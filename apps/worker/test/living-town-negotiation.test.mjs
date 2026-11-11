import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { KeyPairEd25519 } from "near-api-js";
import {
  input,
  authorize,
  held,
  bind,
  policy,
  identity,
  command,
  proposal,
  pending,
  capture,
} from "../../../tests/fixtures/economy/negotiation.mjs";
import { resolveTownProposal } from "../dist/private/living-town/proposals.js";
import {
  compileSellerTradeApproval,
  negotiationAvailable,
} from "../dist/private/living-town/negotiation.js";
import {
  nearAiProvider,
  nearAiInputBound,
  nearAiModel,
} from "../dist/private/living-town/near-ai-cloud.js";
import { merchantCharacter } from "../dist/private/living-town/merchant-characters.js";
import { LivingTownProviderRunner } from "../dist/private/living-town/provider.js";
import { LivingTownExecutionStore } from "../dist/private/living-town/execution-store.js";
import { RuntimeBudget } from "../dist/private/living-town/runtime-budget.js";
import { TownChainAdapter } from "../dist/private/living-town/town-chain.js";
import { townNegotiatingMerchantMethods } from "../dist/private/near-signer.js";
import { livingTownSourceEffect } from "../../../packages/chain/dist/index.js";

const tick = "b".repeat(64);
const context = (i, m, t = tick) => ({
  tickId: t,
  merchant: m,
  facts: bind(i),
  schemaVersion: "living-town-proposal-v1",
});
const resolveProposal = (i, m, action) =>
  resolveTownProposal(
    proposal(i, m, action),
    bind(i),
    tick,
    m,
    policy,
    identity(i),
    command(i),
  );
const buy = {
  type: "propose_trade",
  side: "buy",
  counterparty: "luna",
  item_id: "crystal",
  quantity: "2",
  unit_price: "5",
};
const accept = {
  type: "accept_trade",
  offer_id: "1",
  expected_offer_revision: "1",
};
const quote = {
  model: nearAiModel,
  inputRate: 170000,
  outputRate: 1100000,
  evidence: "controlled:quote",
  verifiedUntil: Date.now() + 3600000,
};
function shortage() {
  const i = authorize(input());
  held(i, "rex", "crystal", 4);
  return bind(i);
}

test("buyer chooses a supplier and terms; no first-supplier or fixed-price selection", () => {
  const i = shortage(),
    before = structuredClone(i);
  const r = resolveProposal(i, "rex", {
    ...buy,
    counterparty: "bolt",
    quantity: "1",
    unit_price: "6",
  });
  assert.equal(r.call.method, "propose_trade");
  assert.equal(r.call.args.seller_merchant_id, "bolt");
  assert.equal(r.call.args.quantity, "1");
  assert.equal(r.call.args.unit_price, "6");
  assert.deepEqual(i, before);
  for (const action of [
    { ...buy, side: "sell" },
    { ...buy, item_id: "iron_tool" },
    { ...buy, quantity: "3" },
    { ...buy, unit_price: "99" },
    { ...buy, counterparty: "rex" },
  ])
    assert.throws(() => resolveProposal(i, "rex", action));
});
test("contract, journal, root and signer authority are all required before enabling trade", () => {
  for (const change of [
    (i) => {
      i.negotiatedTrading = false;
    },
    (i) => {
      delete i.negotiationAuthority;
    },
    (i) => {
      delete i.stockSharingReaction;
    },
    (i) => {
      i.negotiationAuthority.signerScopes.luna = "town_merchant";
    },
    (i) => {
      delete i.pendingOffers;
    },
  ]) {
    const i = shortage();
    change(i);
    assert.equal(negotiationAvailable(i), false);
    assert.equal(resolveProposal(i, "rex", buy).call, null);
  }
  const i = shortage(),
    id = identity(i);
  id.controllers.luna = id.controllers.rex;
  assert.throws(
    () =>
      resolveTownProposal(
        proposal(i, "rex", buy),
        i,
        tick,
        "rex",
        policy,
        id,
        command(i),
      ),
    /controllers/,
  );
});
test("recipient independently accepts, rejects or waits using the actual incoming offer", () => {
  const i = pending(shortage());
  const yes = resolveProposal(i, "luna", accept),
    no = resolveProposal(i, "luna", { type: "reject_trade", offer_id: "1" });
  assert.equal(yes.call.method, "accept_trade");
  assert.equal(yes.call.args.merchant_id, "luna");
  assert.equal(no.call.method, "reject_trade");
  assert.equal(resolveProposal(i, "luna", { type: "wait" }).call, null);
  assert.throws(() => resolveProposal(i, "bolt", accept), /incoming/);
  assert.throws(
    () =>
      resolveProposal(i, "luna", { ...accept, expected_offer_revision: "2" }),
    /binding/,
  );
  assert.throws(
    () => resolveProposal(i, "luna", { type: "reject_trade", offer_id: "2" }),
    /incoming/,
  );
  held(i, "rex", "crystal", 8, 0, 2);
  bind(i);
  assert.throws(() => resolveProposal(i, "luna", accept), /unsafe/);
  assert.equal(
    resolveProposal(i, "luna", { type: "reject_trade", offer_id: "1" }).call
      .method,
    "reject_trade",
  );
});
test("seller listing release is tied to model approval and a separate freshly checked acceptance", () => {
  const i = pending(authorize(input()), "luna", "rex", "crystal", "2", "4");
  const r = resolveProposal(i, "rex", accept);
  assert.equal(r.tradePhase, "seller_listing_release");
  assert.equal(r.call.method, "set_listing");
  assert.equal(r.call.args.quantity, "8");
  assert.equal(r.call.args.unit_price, "4");
  assert.equal(i.merchants[0].listings[0].remaining_quantity, "10");
  const changed = structuredClone(i);
  changed.pendingOffers[0].unit_price = "5";
  changed.pendingOffers[0].total_price = "10";
  assert.throws(
    () =>
      compileSellerTradeApproval(
        changed,
        r.tradeApproval,
        policy,
        identity(changed),
        command(changed),
      ),
    /terms/,
  );
  // Controlled finalized preparation result, not a chain receipt or an automatic second command.
  held(i, "rex", "crystal", 12, 8);
  i.merchants[0].listings[0].revision = "2";
  i.town.data.npc_ledgers[0].revision = "2";
  i.town.market_revision = String(BigInt(i.town.market_revision) + 1n);
  i.town.event_sequence = i.town.market_revision;
  bind(i);
  const final = compileSellerTradeApproval(
    i,
    r.tradeApproval,
    policy,
    identity(i),
    command(i, "2"),
  );
  assert.equal(final.phase, "seller_acceptance");
  assert.equal(final.call.method, "accept_trade");
  assert.equal(final.call.args.expected_seller_ledger_revision, "2");
  const old = structuredClone(i);
  i.fresh = false;
  assert.throws(() =>
    compileSellerTradeApproval(
      i,
      r.tradeApproval,
      policy,
      identity(i),
      command(i),
    ),
  );
  Object.assign(i, old);
  i.town.data.paused = true;
  assert.throws(() =>
    compileSellerTradeApproval(
      i,
      r.tradeApproval,
      policy,
      identity(i),
      command(i),
    ),
  );
});
test("seller approval cannot change root, survive expiry or select a replacement offer", () => {
  const i = pending(shortage()),
    r = resolveProposal(i, "luna", accept);
  i.stockSharingReaction.id = "c".repeat(64);
  assert.throws(
    () =>
      compileSellerTradeApproval(
        i,
        r.tradeApproval,
        policy,
        identity(i),
        command(i),
      ),
    /binding/,
  );
  i.stockSharingReaction.id = r.tradeApproval.rootId;
  i.pendingOffers = [];
  assert.throws(
    () =>
      compileSellerTradeApproval(
        i,
        r.tradeApproval,
        policy,
        identity(i),
        command(i),
      ),
    /closed/,
  );
  i.pendingOffers = [structuredClone(r.tradeApproval.offer)];
  i.town.block_timestamp_ns = i.pendingOffers[0].expires_at_ns;
  i.pendingOffers[0].expired = true;
  assert.throws(() =>
    compileSellerTradeApproval(
      i,
      r.tradeApproval,
      policy,
      identity(i),
      command(i),
    ),
  );
});
test("every turn includes its own complete character profile, actual stocks and bounded choices within the existing input cap", () => {
  const p = nearAiProvider(
    policy,
    {},
    quote,
    () => {
      throw Error("no credential read");
    },
    () => {
      throw Error("no inference");
    },
  );
  for (const merchant of ["rex", "luna", "bolt"]) {
    const i = shortage(),
      prepared = p.prepare(context(i, merchant)),
      body = JSON.parse(prepared.payload),
      state = JSON.parse(body.messages[1].content);
    assert(
      nearAiInputBound(prepared.payload) <= 4096,
      `${merchant}: ${nearAiInputBound(prepared.payload)}`,
    );
    assert(
      body.messages[0].content.includes(
        JSON.stringify(merchantCharacter(merchant)),
      ),
    );
    assert.equal(state.merchant_id, merchant);
    assert.equal(state.stocks.length, 3);
    assert.equal(
      state.candidates.every((c) => c[0] !== merchant),
      true,
    );
    assert.equal(prepared.maxOutputTokens, 512);
  }
  const seller = p.prepare(context(pending(shortage()), "luna")),
    state = JSON.parse(JSON.parse(seller.payload).messages[1].content);
  assert.equal(state.incoming[0][0], "1");
  assert.equal(state.incoming[0][1], "rex");
  assert.equal(
    state.actions.some((a) => a.type === "reject_trade"),
    true,
  );
  assert(nearAiInputBound(seller.payload) <= 4096);
});

function harness(t, actions = ["rex", "luna"], options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-independent-turns-"));
  mkdirSync(join(dir, "execution"));
  const i = shortage(),
    id = identity(i),
    store = new LivingTownExecutionStore(
      join(dir, "execution"),
      id,
      "42",
      true,
    ),
    authority = new RuntimeBudget(
      join(dir, "budget"),
      join(dir, "witness"),
      true,
    );
  t.after(() => {
    store.close();
    authority.close();
    assert(
      resolve(dir).startsWith(resolve(tmpdir(), "bazaar-independent-turns-")),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  store.recovered(
    Object.fromEntries(
      ["rex", "luna", "bolt", "operator"].map((m) => [
        m,
        { sequence: "0", digest: null },
      ]),
    ),
  );
  i.town.data.customer_pool.epoch = i.town.data.epoch;
  const slot = String(
    (BigInt(i.town.block_timestamp_ns) - BigInt(i.town.data.genesis_time_ns)) /
      30000000000n,
  );
  const work = actions.map((m, n) => ({
    id: String(n + 1).repeat(64),
    arrival: `merchant:${m}:${slot}`,
  }));
  const tick = store.ticks.prepare(
    {
      town: i.town,
      codeHash: id.codeHash,
      block: {
        hash: "11111111111111111111111111111111",
        height: i.town.block_height,
        timestampNs: i.town.block_timestamp_ns,
      },
    },
    30000,
    work,
  );
  const calls = [];
  let inference;
  const fetcher = async (url, request) => {
    if (url.endsWith("/v1/billing/costs"))
      return new Response(
        JSON.stringify({
          requests: [{ requestId: inference, costNanoUsd: 1250 }],
        }),
      );
    assert(url.endsWith("/v1/chat/completions"));
    const body = JSON.parse(request.body),
      state = JSON.parse(body.messages[1].content);
    calls.push({ body, state });
    if (options.timeout)
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(new Error("controlled timeout")),
          { once: true },
        ),
      );
    inference = randomUUID();
    const action =
      options.action?.(state) ?? (state.merchant_id === "rex" ? buy : accept);
    const response = {
      schema: "living-town-proposal-v1",
      tick_id: state.tick_id,
      market_revision: state.market_revision,
      merchant_id: state.merchant_id,
      reason: "controlled independent provider response",
      action,
    };
    return new Response(
      JSON.stringify({
        model: nearAiModel,
        id: randomUUID(),
        usage: { prompt_tokens: 100, completion_tokens: 100 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: options.invalid ? "not json" : JSON.stringify(response),
            },
          },
        ],
      }),
      { headers: { "inference-id": inference } },
    );
  };
  const provider = nearAiProvider(
      policy,
      authority,
      quote,
      () => "controlled-not-a-real-key",
      fetcher,
    ),
    runner = new LivingTownProviderRunner(
      store,
      policy,
      authority.budget,
      authority.binding,
      provider,
      options.current ?? (async () => true),
      options.timeout ? 20 : 1000,
      "policy",
    );
  return {
    i,
    store,
    authority,
    runner,
    calls,
    tick,
    context: (m) => context(i, m, tick.id),
    finish: (n) =>
      store.prepareTown(
        {
          ...work[n],
          tick: i.town.data.epoch,
          lane: actions[n],
          decision: {
            kind: "no_op",
            reason: "controlled chain boundary; no transaction executed",
          },
          call: null,
          digest: null,
        },
        Date.now() + 60000,
      ),
  };
}
for (const decision of ["accept_trade", "reject_trade"])
  test(`controlled provider drives separate buyer and seller turns including ${decision}`, async (t) => {
    const f = harness(t, ["rex", "luna"], {
      action: (state) =>
        state.merchant_id === "rex"
          ? buy
          : decision === "accept_trade"
            ? accept
            : { type: decision, offer_id: "1" },
    });
    const buyer = await f.runner.propose(f.context("rex"));
    assert.equal(buyer.origin, "model_proposal");
    const first = resolveTownProposal(
      buyer.proposal,
      f.i,
      f.tick.id,
      "rex",
      policy,
      identity(f.i),
      command(f.i),
    );
    assert.equal(first.call.method, "propose_trade");
    f.finish(0);
    pending(f.i);
    const seller = await f.runner.propose(f.context("luna"));
    assert.equal(seller.origin, "model_proposal");
    const second = resolveTownProposal(
      seller.proposal,
      f.i,
      f.tick.id,
      "luna",
      policy,
      identity(f.i),
      command(f.i),
    );
    assert.equal(second.call.method, decision);
    assert.equal(f.calls.length, 2);
    assert.notEqual(
      f.calls[0].body.messages[0].content,
      f.calls[1].body.messages[0].content,
    );
    assert.equal(f.calls[1].state.incoming[0][0], "1");
    assert.equal(f.authority.budget.history().entries.length, 2);
    assert.equal(
      f.store
        .providerHistory()
        .every(
          (r) =>
            r.ledger_id === f.authority.binding.ledgerId &&
            r.status === "accepted",
        ),
      true,
    );
    const audit = f.store.providerAttempts.get(seller.inferenceRef);
    assert.equal(JSON.parse(audit.context_json).character.id, "luna");
    assert.equal(JSON.parse(audit.proposal_json).action.type, decision);
    assert.deepEqual(
      (await f.runner.propose(f.context("luna"))).proposal,
      seller.proposal,
    );
    assert.equal(f.calls.length, 2);
  });
test("a recipient model acceptance authorizes labelled listing preparation and only the same later offer", async (t) => {
  const f = harness(t, ["rex"], { action: () => accept });
  // A real stored-offer shape: Luna requests Rex's listed primary stock.
  held(f.i, "rex", "crystal", 12, 10);
  pending(f.i, "luna", "rex", "crystal", "2", "4");
  const delivery = await f.runner.propose(f.context("rex"));
  assert.equal(delivery.origin, "model_proposal");
  const first = resolveTownProposal(
    delivery.proposal,
    f.i,
    f.tick.id,
    "rex",
    policy,
    identity(f.i),
    command(f.i),
  );
  assert.equal(first.tradePhase, "seller_listing_release");
  assert.equal(first.call.method, "set_listing");
  assert.equal(first.call.args.quantity, "8");
  held(f.i, "rex", "crystal", 12, 8);
  f.i.merchants[0].listings[0].revision = "2";
  f.i.town.data.npc_ledgers[0].revision = "2";
  const final = compileSellerTradeApproval(
    bind(f.i),
    first.tradeApproval,
    policy,
    identity(f.i),
    command(f.i, "2"),
  );
  assert.equal(final.phase, "seller_acceptance");
  assert.equal(final.call.method, "accept_trade");
  assert.equal(f.calls.length, 1);
});
for (const mode of ["timeout", "invalid", "budget", "stale"])
  test(`recipient ${mode} never fabricates acceptance or releases unknown spend`, async (t) => {
    let checks = 0;
    const f = harness(t, ["luna"], {
      timeout: mode === "timeout",
      invalid: mode === "invalid",
      current: mode === "stale" ? async () => ++checks === 1 : undefined,
    });
    pending(f.i);
    if (mode === "budget")
      f.authority.budget.reallocate(
        {
          projectId: "bot-bazaar",
          laneId: "shared",
          portions: [{ laneId: "shared", dailyMicro: 1, monthlyMicro: 1 }],
        },
        "controlled:exhaustion",
      );
    const result = await f.runner.propose(f.context("luna"));
    assert.equal(result.origin, "rules");
    assert.equal(result.proposal.action.type, "wait");
    if (mode === "budget") {
      assert.equal(f.calls.length, 0);
      assert.equal(f.authority.budget.history().entries.length, 0);
    }
    if (mode === "timeout") {
      assert.equal(f.authority.budget.history().entries[0].status, "reserved");
      assert(f.authority.budget.history().entries[0].charged_micro > 0);
    }
  });
test("read-only key admission verifies exact negotiated scope and advertised contract methods", async () => {
  const i = authorize(input()),
    id = identity(i),
    key = KeyPairEd25519.fromRandom(),
    adapter = new TownChainAdapter(
      id,
      () => {
        throw Error("no RPC transport");
      },
      {
        publicKey: key.getPublicKey().toString(),
        sign: () => {
          throw Error("no signing");
        },
      },
      "rex",
    );
  let methods = [...townNegotiatingMerchantMethods],
    supported = [...capture.foundation.data.supported_methods];
  const reader = {
    identity: id,
    getFoundation: async () => ({ data: { supported_methods: supported } }),
    getAccessKey: async () => ({
      permission: {
        FunctionCall: {
          receiver_id: id.deployment.contract_id,
          method_names: methods,
          allowance: "1000",
        },
      },
    }),
  };
  await adapter.verifyNegotiationScope(reader);
  methods = methods.filter((m) => m !== "reject_trade");
  await assert.rejects(() => adapter.verifyNegotiationScope(reader));
  methods = [...townNegotiatingMerchantMethods];
  supported = supported.filter((m) => m !== "accept_trade");
  await assert.rejects(() => adapter.verifyNegotiationScope(reader));
});

test("Bolt uses his own provider turn to judge an incoming reserve sale", async (t) => {
  const f = harness(t, ["bolt"], { action: () => accept });
  pending(f.i, "rex", "bolt");
  const delivery = await f.runner.propose(f.context("bolt"));
  assert.equal(delivery.origin, "model_proposal");
  assert(
    f.calls[0].body.messages[0].content.includes(
      JSON.stringify(merchantCharacter("bolt")),
    ),
  );
  const result = resolveTownProposal(
    delivery.proposal,
    f.i,
    f.tick.id,
    "bolt",
    policy,
    identity(f.i),
    command(f.i),
  );
  assert.equal(result.call.method, "accept_trade");
  assert.equal(result.call.args.merchant_id, "bolt");
});

test("SDK source decoding matches paced supply and includes promised target space", () => {
  function effect({
    epoch = "5",
    before = 4,
    issued = 2,
    incoming = 0,
    item = "crystal",
    event = null,
  } = {}) {
    const i = input(),
      m = item === "herb" ? "luna" : "rex";
    held(i, m, item, before + issued, 0, incoming);
    return {
      principal: `account:${identity(i).operatorId}`,
      command_sequence: "1",
      payload_sha256: "a".repeat(64),
      replayed: false,
      effect_revision: "1",
      effect_event_sequence: "1",
      outcome: {
        kind: "raw_supplied",
        item_id: item,
        merchant_id: m,
        epoch,
        issued_quantity: String(issued),
        market_event: event,
        ledger: i.town.data.npc_ledgers.find((l) => l.actor.merchant_id === m),
      },
    };
  }
  assert.equal(livingTownSourceEffect(effect()).outcome.issued_quantity, "2");
  assert.equal(
    livingTownSourceEffect(effect({ epoch: "1", issued: 0 })).outcome
      .issued_quantity,
    "0",
  );
  assert.throws(
    () => livingTownSourceEffect(effect({ epoch: "1" })),
    /formula/,
  );
  assert.equal(
    livingTownSourceEffect(effect({ before: 10, incoming: 2, issued: 0 }))
      .outcome.issued_quantity,
    "0",
  );
  assert.throws(
    () =>
      livingTownSourceEffect(effect({ before: 10, incoming: 2, issued: 2 })),
    /formula/,
  );
  const event = {
    event_id: "1",
    definition_id: "herb_shortage_v1",
    start_epoch: "5",
    end_epoch: "10",
    herb_supply_ceiling: "1",
    revision: "1",
  };
  assert.equal(
    livingTownSourceEffect(effect({ item: "herb", event, issued: 1 })).outcome
      .issued_quantity,
    "1",
  );
  assert.throws(
    () => livingTownSourceEffect(effect({ item: "herb", event, issued: 2 })),
    /formula/,
  );
});
