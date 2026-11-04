import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDecision } from "../dist/private/policy/evaluate.js";
import {
  profiles,
  rexShortageSaleBand,
} from "../dist/private/prompts/profiles.js";
import {
  buildMerchantPrompt,
  promptVersion,
} from "../dist/private/prompts/merchant-prompt.js";
import { captured } from "./chain-fixture.mjs";
import { recordInferenceInput } from "../dist/private/inference/input.js";

const now = Date.now();
function context() {
  const market = structuredClone(captured.seed.market);
  market.block_timestamp_ns = String(BigInt(now) * 1000000n);
  const rex = market.data.merchants.find((m) => m.merchant_id === "rex");
  rex.inventory.crystal = "3";
  rex.gold = "228";
  rex.listings[0].quantity = "3";
  return {
    merchantId: "rex",
    phase: "decision",
    rootDeadline: now + 120000,
    rexShortageMode: true,
    mutationsRemaining: 8,
    commitments: [],
    rejectedOfferIds: [],
    changedResources: ["crystal"],
    state: {
      market,
      block: {
        height: market.block_height,
        hash: captured.seed.finalized_block.hash,
        timestampNs: market.block_timestamp_ns,
      },
      observedAt: now,
      offers: [],
      trades: [],
      mode: "initial",
      tradeCursor: "0",
    },
  };
}
function proposal(c, quantity = 4, price = 6) {
  return {
    method: "propose_trade",
    args: {
      proposer: "rex",
      buyer: "rex",
      seller: "luna",
      resource: "crystal",
      quantity: String(quantity),
      total_price: String(quantity * price),
      expires_at_ns: String(BigInt(now + 120000) * 1000000n),
      action_id: "1",
    },
  };
}
function prompt(c, extras = {}) {
  return buildMerchantPrompt(
    c.state,
    {
      merchantId: c.merchantId,
      phase: c.phase,
      rootDeadline: c.rootDeadline,
      modelCallsRemaining: 6,
      mutationsRemaining: c.mutationsRemaining,
      rexShortageMode: c.rexShortageMode,
      commitments: [],
      rejectedOfferIds: [],
      ...extras,
    },
    now,
  );
}

test("balancing sweep enforces supplier floors, shortage targets, price compatibility and exact affordability", (t) => {
  let checked = 0,
    permitted = 0;
  for (let stock = 0; stock <= 7; stock++)
    for (let supply = 4; supply <= 12; supply++)
      for (const gold of [80, 85, 86, 104, 228])
        for (let price = 5; price <= 8; price++)
          for (let quantity = 1; quantity <= 5; quantity++) {
            const c = context(),
              [rex, luna] = c.state.market.data.merchants;
            rex.inventory.crystal = String(stock);
            rex.gold = String(gold);
            rex.listings[0].quantity = String(stock);
            rex.listings[0].active = stock > 0;
            luna.inventory.crystal = String(supply);
            luna.listings[0].quantity = String(Math.min(8, supply - 4));
            luna.listings[0].active = supply > 4;
            const expected =
              stock < 5 &&
              price === 6 &&
              quantity <= 4 &&
              quantity <= 7 - stock &&
              quantity <= supply - 4 &&
              gold - quantity * price >= 80;
            let accepted;
            try {
              evaluateDecision(proposal(c, quantity, price), c, now);
              accepted = true;
            } catch (error) {
              assert.equal(error.name, "PolicyError");
              accepted = false;
            }
            assert.equal(
              accepted,
              expected,
              JSON.stringify({ stock, supply, gold, price, quantity }),
            );
            checked++;
            if (accepted) permitted++;
          }
  assert.ok(permitted > 0);
  t.diagnostic(
    `${checked} controlled economic combinations; ${permitted} permitted. No inference or chain mutation.`,
  );
});

test("four-unit shortage briefing exposes conservative buyer-only headroom without promising profit", () => {
  const result = prompt(context()),
    data = JSON.parse(result.messages[1].content);
  assert.equal(promptVersion, "merchant-v1.1.0");
  assert.deepEqual(data.restockEconomics, {
    resource: "crystal",
    targetGap: "4",
    spendableGold: "148",
    purchaseUnitPriceBand: ["4", "6"],
    futureSaleUnitPriceBand: ["7", "8"],
    buyerOnlyQuantityCeilingAtMaxPrice: "4",
    totalAtQuantityCeilingAndMaxPrice: "24",
    potentialUnitGrossMarginAtMinResaleAndMaxBuyPrice: "1",
    futureDemandGuaranteed: false,
  });
  assert.match(result.messages[0].content, /not an authorized action/);
  assert.match(result.messages[0].content, /You may buy less, hold or decline/);
  assert.deepEqual(
    evaluateDecision({ method: "hold" }, context(), now).preparations,
    [],
  );
});

test("briefing affordability includes local reservations and permits no purchase below one-unit budget", () => {
  for (const [gold, maximum] of [
    ["85", "0"],
    ["86", "1"],
    ["104", "4"],
  ]) {
    const c = context();
    c.state.market.data.merchants[0].gold = gold;
    const data = JSON.parse(prompt(c).messages[1].content);
    assert.equal(
      data.restockEconomics.buyerOnlyQuantityCeilingAtMaxPrice,
      maximum,
    );
  }
  const c = context(),
    result = prompt(c, {
      commitments: [
        {
          merchantId: "rex",
          gold: "143",
          inventory: { crystal: "0", wood: "0", herb: "0", iron: "0" },
        },
      ],
    });
  assert.equal(
    JSON.parse(result.messages[1].content).restockEconomics
      .buyerOnlyQuantityCeilingAtMaxPrice,
    "0",
  );
});

test("briefing never manufactures shortage demand for other merchants, followups or a full target", () => {
  for (const name of ["luna", "bolt"]) {
    const c = context();
    c.merchantId = name;
    assert.equal(
      JSON.parse(prompt(c).messages[1].content).restockEconomics,
      null,
    );
  }
  for (const stock of ["5", "7"]) {
    const c = context();
    c.state.market.data.merchants[0].inventory.crystal = stock;
    assert.equal(
      JSON.parse(prompt(c).messages[1].content).restockEconomics,
      null,
    );
  }
  const c = context();
  c.phase = "followup";
  assert.equal(
    JSON.parse(prompt(c).messages[1].content).restockEconomics,
    null,
  );
});

test("admission records the briefing, rejects unsafe claims and retains older prompt compatibility", () => {
  const built = prompt(context());
  const payload = { messages: structuredClone(built.messages) };
  const data = JSON.parse(payload.messages[1].content);
  const recorded = recordInferenceInput(JSON.stringify(payload));
  assert.equal(recorded.status, "recorded");
  assert.equal(
    JSON.parse(recorded.inputJson).restockEconomics
      .potentialUnitGrossMarginAtMinResaleAndMaxBuyPrice,
    "1",
  );
  data.restockEconomics.futureDemandGuaranteed = true;
  payload.messages[1].content = JSON.stringify(data);
  assert.equal(
    recordInferenceInput(JSON.stringify(payload)).status,
    "unavailable",
  );
  delete data.restockEconomics;
  payload.messages[1].content = JSON.stringify(data);
  assert.equal(
    recordInferenceInput(JSON.stringify(payload)).status,
    "recorded",
  );
});

test("Luna's independent acceptance preserves her floor after worst-case public listing sales", () => {
  const c = context();
  c.merchantId = "luna";
  c.state.offers = [
    {
      ...structuredClone(captured.pending.offer.data.offer),
      created_at_ns: c.state.block.timestampNs,
      expires_at_ns: String(BigInt(now + 120000) * 1000000n),
    },
  ];
  const action = {
    method: "accept_trade",
    args: { offer_id: "1", action_id: "1" },
  };
  const selected = evaluateDecision(action, c, now);
  assert.equal(selected.preparations[0].args.quantity, "4");
  const luna = c.state.market.data.merchants[1];
  luna.inventory.crystal = "8";
  luna.listings[0].quantity = "0";
  luna.listings[0].active = false;
  assert.equal(evaluateDecision(action, c, now).trade.quantity, "4");
  luna.inventory.crystal = "7";
  assert.throws(() => evaluateDecision(action, c, now), /stock_reserve/);
});

test("permitted followup resale prices retain positive gross spread over maximum restock cost", () => {
  const c = context();
  c.phase = "followup";
  const rex = c.state.market.data.merchants[0];
  rex.inventory.crystal = "7";
  rex.gold = "204";
  rex.listings[0].active = false;
  rex.listings[0].quantity = "0";
  const args = {
    merchant_id: "rex",
    resource: "crystal",
    quantity: "4",
    active: true,
    expected_version: rex.listings[0].version,
    action_id: "1",
  };
  for (let price = 4; price <= 9; price++) {
    const action = {
      method: "set_listing",
      args: { ...args, unit_price: String(price) },
    };
    if (price < 7 || price > 8)
      assert.throws(
        () => evaluateDecision(action, c, now),
        /price_outside_band/,
      );
    else {
      evaluateDecision(action, c, now);
      assert.ok(
        BigInt(price) - BigInt(profiles.rex.buys.crystal.price[1]) > 0n,
      );
    }
  }
  assert.deepEqual(rexShortageSaleBand, ["7", "8"]);
});
