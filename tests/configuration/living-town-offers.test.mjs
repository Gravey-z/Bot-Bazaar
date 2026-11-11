import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  livingTownIndexedReceipt,
  livingTownOffer,
  livingTownOfferEffect,
  livingTownMerchantTrade,
  verifyLivingTownEffect,
  livingTownCommandDigest,
  livingTownFoundation,
  parseLivingTownDeployment,
  FinalizedLivingTownReader,
  offerMaterialRules,
} from "../../packages/chain/dist/index.js";
const capture = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-merchant-offers-sandbox.json",
    "utf8",
  ),
);
export const decoded = await Promise.all(
  capture.steps.map(async (step) => {
    const proof = {
      transactionHash: step.transaction_hash,
      signerId: step.signer_id,
      deployment: step.foundation.deployment,
      call: createLivingTownCall(step.method, step.args),
      referenceBlockHeight: step.reference_block_height,
    };
    const status = await verifyLivingTownReceipt(
      step.receipt,
      proof,
      async (hash) => {
        assert.equal(hash, step.block.header.hash);
        return {
          hash,
          height: String(step.block.header.height),
          timestampNs: step.block.header.timestamp_nanosec,
        };
      },
    );
    assert.equal(status.kind, "succeeded", step.method);
    return livingTownIndexedReceipt(proof, { status, response: step.receipt });
  }),
);
test("all 15 actual schema-2 WASM receipts decode with immutable terms, seller identity and replay", () => {
  assert.equal(decoded.length, 15);
  for (const step of capture.steps.filter((s) =>
    [
      "propose_trade",
      "accept_trade",
      "reject_trade",
      "cancel_trade",
      "expire_offers",
    ].includes(s.method),
  )) {
    const gas =
      BigInt(step.receipt.transaction_outcome.outcome.gas_burnt) +
      step.receipt.receipts_outcome.reduce(
        (sum, r) => sum + BigInt(r.outcome.gas_burnt),
        0n,
      );
    assert(
      gas < 30000000000000n,
      "captured offer actions fit runtime gas allocation",
    );
  }
  livingTownFoundation(capture.foundation.data);
  const accepted = decoded.filter(
    (x) =>
      x.status.result.data.outcome.kind === "trade_accepted" &&
      !x.status.result.data.replayed,
  );
  assert.equal(accepted.length, 2);
  for (const x of accepted) {
    const { trade, offer } = x.status.result.data.outcome;
    assert.equal(trade.command_principal, `merchant:${offer.seller}`);
    assert.equal(trade.offer_id, offer.offer_id);
    assert.equal(trade.listing_id, null);
    assert.equal(trade.total_price, offer.total_price);
  }
  for (const x of decoded.filter((x) => x.status.result.data.replayed))
    assert.equal(x.event, null);
  const expiry = decoded.at(-1).status.result.data.outcome;
  assert.equal(expiry.kind, "offers_expired");
  assert.deepEqual(expiry.skipped_offer_ids, ["3", "4"]);
  assert.equal(expiry.offers[0].status, "expired");
});
test("offer codecs reject invented fields, roles, terms, terminal timing and expiry batch duplicates", () => {
  const proposal = decoded.find(
    (x) => x.status.result.data.outcome.kind === "trade_proposed",
  ).status.result.data;
  const o = proposal.outcome.offer;
  for (const bad of [
    { ...o, quantity: "3" },
    { ...o, seller: o.buyer },
    { ...o, total_price: "1" },
    { ...o, invented: true },
    { ...o, status: "accepted" },
  ])
    assert.throws(() => livingTownOffer(bad));
  const accepted = decoded.find(
    (x) => x.status.result.data.outcome.kind === "trade_accepted",
  ).status.result.data;
  assert.throws(() =>
    livingTownMerchantTrade({
      ...accepted.outcome.trade,
      command_principal: `merchant:${accepted.outcome.offer.buyer}`,
    }),
  );
  const bad = structuredClone(accepted);
  bad.outcome.offer.unit_price = "5";
  bad.outcome.offer.total_price = "10";
  assert.throws(() => livingTownOfferEffect(bad));
  const expiry = structuredClone(decoded.at(-1).status.result.data);
  expiry.outcome.skipped_offer_ids.push(expiry.outcome.offers[0].offer_id);
  assert.throws(() => livingTownOfferEffect(expiry));
});
test("offer calls bind merchant lanes and preserve old command identity while requiring schema 2", async () => {
  const i = decoded.findIndex((x) => x.proof.call.method === "accept_trade"),
    x = decoded[i],
    step = capture.steps[i];
  assert.equal(
    (
      await verifyLivingTownEffect(
        x.status.result,
        step.foundation.deployment,
        step.signer_id,
        x.proof.call,
      )
    ).data.principal,
    `merchant:${x.status.result.data.outcome.offer.seller}`,
  );
  const wrong = structuredClone(x.proof.call);
  wrong.args.merchant_id = x.status.result.data.outcome.offer.buyer;
  await assert.rejects(() =>
    verifyLivingTownEffect(
      x.status.result,
      step.foundation.deployment,
      step.signer_id,
      wrong,
    ),
  );
  await assert.rejects(() =>
    livingTownCommandDigest(
      { ...step.foundation.deployment, state_schema: "1" },
      step.signer_id,
      x.proof.call,
    ),
  );
  assert.equal(
    parseLivingTownDeployment({
      ...step.foundation.deployment,
      state_schema: "1",
    }).state_schema,
    "1",
  );
  assert.throws(() =>
    createLivingTownCall("expire_offers", {
      merchant_id: "rex",
      offer_ids: ["1", "1"],
      command: step.args.command,
    }),
  );
});

test("finalized offer reads preserve pending completeness through history gaps and validate checkpoints", async () => {
  const town = structuredClone(capture.low),
    block = {
      hash: capture.steps[6].block.header.hash,
      height: town.block_height,
      timestampNs: town.block_timestamp_ns,
    };
  const identity = {
    deployment: town.deployment,
    codeHash: capture.steps[0].account.code_hash,
    ownerId: capture.foundation.data.owner_account_id,
    operatorId: capture.foundation.data.operator_account_id,
    controllers: capture.foundation.data.merchant_controllers,
  };
  const rules = {
    schema: "merchant-offers-v1",
    items: ["crystal", "wood", "herb", "iron"],
    quantity_cap: "2",
    backup_cap: "7",
    operating_gold: { rex: "80", luna: "120", bolt: "60" },
    max_pending_global: "12",
    max_pending_per_merchant: "8",
    terminal_retention: "128",
    min_offer_lifetime_seconds: "60",
    max_offer_lifetime_seconds: "600",
    materials: offerMaterialRules,
  };
  const accepted = decoded.find(
    (x) => x.status.result.data.outcome.kind === "trade_accepted",
  ).status.result.data;
  const rpc = async (method, p) => {
    assert.equal(method, "query");
    assert.equal(p.block_id, block.hash);
    const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
    let data;
    if (p.method_name === "get_foundation") data = capture.foundation.data;
    else if (p.method_name === "get_town") data = town.data;
    else if (p.method_name === "get_merchant_trading_rules") data = rules;
    else if (p.method_name === "get_offers")
      data = {
        items: [],
        next_after_id: null,
        has_more: false,
        history_gap: BigInt(args.after_id ?? "0") < 1n,
        pruned_through: "1",
      };
    else if (p.method_name === "get_command")
      data = {
        kind: "found",
        high_water: accepted.command_sequence,
        method: "accept_trade",
        payload_sha256: accepted.payload_sha256,
        effect: accepted,
      };
    else throw Error(p.method_name);
    return {
      block_hash: block.hash,
      block_height: block.height,
      result: [...Buffer.from(JSON.stringify({ ...town, data }))],
    };
  };
  const reader = new FinalizedLivingTownReader(rpc, identity, block);
  assert.deepEqual((await reader.getPendingMerchantOffers()).offers, []);
  assert.equal(
    (
      await reader.getOffers({
        merchant_id: null,
        status: "all",
        after_id: "42",
        limit: "50",
        expected_market_revision: town.market_revision,
      })
    ).data.next_after_id,
    null,
  );
  assert.equal(
    (await reader.getCommand("merchant:rex", "2")).data.method,
    "accept_trade",
  );
  town.data.npc_ledgers[0].gold.trade_reserved = "1";
  town.data.npc_ledgers[0].gold.available = String(
    BigInt(town.data.npc_ledgers[0].gold.held) - 1n,
  );
  await assert.rejects(
    () => reader.getPendingMerchantOffers(),
    /reconciliation mismatch/,
  );
});
