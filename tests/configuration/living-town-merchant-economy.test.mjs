import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { livingTownActivity } from "../../packages/chain/dist/index.js";
const bundled = await transform(
  readFileSync("apps/web/src/app/living-town-merchants.ts", "utf8"),
  { loader: "ts", format: "esm" },
);
const { merchantEconomy, merchantProofUrl } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.code).toString("base64")}`
);
const cap = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-merchant-offers-sandbox.json",
    "utf8",
  ),
);
const accepted =
  cap.trade.data.outcome?.offer ??
  cap.steps
    .filter((s) => s.method === "accept_trade")
    .flatMap((s) =>
      s.receipt.receipts_outcome
        .map((r) => r.outcome.status.SuccessValue)
        .filter(Boolean)
        .map((v) => JSON.parse(Buffer.from(v, "base64").toString())),
    )
    .find((r) => r.data?.outcome?.kind === "trade_accepted").data.outcome.offer;
const cp = {
  block_hash: cap.steps[0].block.header.hash,
  block_height: "100",
  block_timestamp_ns: "1000000000",
  market_revision: "1",
  event_sequence: "1",
};
const hash = cap.steps.find(
  (s) => s.method === "accept_trade",
).transaction_hash;
const event = (offer = accepted, merchant = offer.buyer) =>
  livingTownActivity({
    event_id: "a".repeat(64),
    checkpoint: cp,
    type: "merchant_economy",
    source: "confirmed",
    data: {
      merchant,
      kind: "accepted",
      offer,
      item_id: offer.item_id,
      quantity: offer.quantity,
      trade_id: offer.trade_id,
      transaction_hash: hash,
      receipt_id: hash,
    },
  });
const observation = (items = [accepted]) => ({
  town: structuredClone(cap.low.data),
  receivedAt: 1000,
  stale: false,
  merchantOffers: { available: true, items, stale: false, historyGap: false },
  chainTimestampNs: "0",
});
const decision = (outcome, extra = {}) => ({
  event_id: outcome.padEnd(64, "0"),
  checkpoint: cp,
  type: "agent_action",
  source: outcome === "confirmed" ? "confirmed" : "model_proposal",
  data: {
    action_id: "b".repeat(64),
    tick_id: "c".repeat(64),
    merchant: accepted.buyer,
    proposal_type: "accept_trade",
    reason: "<img src=x onerror=alert(1)>",
    validation: "allowed",
    outcome,
    offer_id: accepted.offer_id,
    transaction_hash: outcome === "confirmed" ? hash : null,
    receipt_id: outcome === "confirmed" ? hash : null,
    ...extra,
  },
});

test("merchant views filter ledgers/offers and keep incoming commitments separate from held stock", () => {
  const o = observation(),
    ledger = o.town.npc_ledgers.find(
      (l) => l.actor.merchant_id === accepted.buyer,
    );
  ledger.inventory.trade_inbound_reserved.crystal = "2";
  const v = merchantEconomy(o, [], accepted.buyer, 1000, "live");
  assert.equal(v.gold, ledger.gold.available);
  assert.equal(v.committedGold, ledger.gold.trade_reserved);
  const crystal = v.stock.find((s) => s.id === "crystal");
  assert.equal(crystal.incoming, "2");
  assert.equal(crystal.held, ledger.inventory.held.crystal);
  assert.equal(v.offers[0].direction, "Outgoing request");
  assert.equal(v.goals.length, 2);
  assert.equal(merchantEconomy(o, [], "bolt", 1000, "live").offers.length, 0);
});
test("settlement deltas require exact accepted terms and are opposite for buyer and seller", () => {
  const buyer = merchantEconomy(
    observation(),
    [event()],
    accepted.buyer,
    1000,
    "live",
  ).offers[0];
  const seller = merchantEconomy(
    observation(),
    [event(accepted, accepted.seller)],
    accepted.seller,
    1000,
    "live",
  ).offers[0];
  assert(buyer.delta.includes(`+${accepted.quantity}`));
  assert(seller.delta.includes(`+${accepted.total_price} gold`));
  assert.equal(buyer.url, `https://testnet.nearblocks.io/txns/${hash}`);
  assert.equal(
    seller.receipt,
    `https://testnet.nearblocks.io/txns/${hash}#${hash}`,
  );
  assert.equal(
    merchantEconomy(observation(), [], accepted.buyer, 1000, "live").offers[0]
      .delta,
    null,
  );
  const changed = {
    ...accepted,
    unit_price: "5",
    total_price: String(BigInt(accepted.quantity) * 5n),
  };
  assert.equal(
    merchantEconomy(
      observation([changed]),
      [event()],
      accepted.buyer,
      1000,
      "live",
    ).offers[0].url,
    null,
  );
});
test("unknown and submitted never become confirmed; preparation is distinct and reasons remain plain text", () => {
  for (const outcome of [
    "unknown",
    "submitted",
    "proposal",
    "rejected",
    "expired",
  ]) {
    const v = merchantEconomy(
      observation(),
      [decision(outcome)],
      accepted.buyer,
      1000,
      "live",
    ).decisions[0];
    assert.equal(v.url, null);
    assert(!v.label.includes("confirmed"));
    assert.equal(v.reason, "<img src=x onerror=alert(1)>");
  }
  assert.equal(
    merchantEconomy(
      observation(),
      [decision("confirmed", { validation: "seller_listing_release" })],
      accepted.buyer,
      1000,
      "live",
    ).decisions[0].label,
    "Listing prepared",
  );
  const html = readFileSync(
    "apps/web/src/app/merchant-economy.component.html",
    "utf8",
  );
  assert(!html.includes("innerHTML"));
  assert(html.includes("{{ entry.reason }}"));
  assert.equal(merchantProofUrl("javascript:alert(1)"), null);
});
test("thinking ends on a decision, times out visibly, and unavailable/stale/history gaps remain explicit", () => {
  const d = decision("thinking");
  assert.equal(
    merchantEconomy(observation(), [d], accepted.buyer, 1000, "live")
      .decisions[0].label,
    "Thinking",
  );
  assert.equal(
    merchantEconomy(observation(), [d], accepted.buyer, 22000, "live")
      .decisions[0].label,
    "Status unavailable",
  );
  assert.equal(
    merchantEconomy(
      observation(),
      [decision("submitted"), d],
      accepted.buyer,
      1000,
      "live",
    ).decisions.length,
    1,
  );
  const o = observation();
  o.merchantOffers.historyGap = true;
  assert(merchantEconomy(o, [], accepted.buyer, 32000).stale);
  assert(merchantEconomy(o, [], accepted.buyer, 1000).historyGap);
  assert(!merchantEconomy(null, [], "rex").offersAvailable);
  assert(
    merchantEconomy(o, [], accepted.buyer, 1000, "live", true).activityGap,
  );
  assert.equal(
    merchantEconomy(
      o,
      [decision("submitted"), decision("proposal")],
      accepted.buyer,
      1000,
      "live",
    ).decisions[0].label,
    "Submitted · awaiting confirmation",
  );
  assert.equal(
    merchantEconomy(
      o,
      [decision("unknown"), decision("submitted")],
      accepted.buyer,
      1000,
      "live",
    ).decisions[0].label,
    "Outcome unknown",
  );
});
test("provider fallback waits are labelled unavailable rather than a voluntary model decision", () => {
  const fallback = {
    ...decision("local_no_op", {
      validation: "model_wait",
      reason: "rules fallback: near_ai_http_502",
    }),
    source: "deterministic_rule",
  };
  assert.equal(
    merchantEconomy(observation(), [fallback], accepted.buyer, 1000, "live")
      .decisions[0].label,
    "Decision unavailable",
  );
});
test("past-deadline pending offers retain their commitments until chain cleanup; source refill is separate", () => {
  const pending = {
    ...accepted,
    status: "pending",
    expired: false,
    trade_id: null,
  };
  const o = observation([pending]);
  o.chainTimestampNs = pending.expires_at_ns;
  const v = merchantEconomy(o, [], pending.buyer, 1000, "live");
  assert.match(v.offers[0].label, /cleanup pending/);
  assert.equal(v.offers[0].delta, null);
  const source = livingTownActivity({
    ...event(),
    data: {
      ...event().data,
      kind: "source",
      offer: null,
      trade_id: null,
      quantity: "1",
    },
  });
  const s = merchantEconomy(
    observation(),
    [source],
    accepted.buyer,
    1000,
    "live",
  );
  assert.equal(s.sources.length, 1);
  assert.equal(s.offers[0].delta, null);
  assert.throws(() =>
    livingTownActivity({ ...source, source: "model_proposal" }),
  );
  assert.throws(() =>
    livingTownActivity({
      ...event(),
      data: { ...event().data, merchant: "bolt" },
    }),
  );
});
