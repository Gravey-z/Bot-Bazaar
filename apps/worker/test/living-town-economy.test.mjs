import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  livingTownIndexedReceipt,
} from "@bot-bazaar/chain";
import {
  TownActivityFeed,
  townFeedSchema,
} from "../dist/private/living-town/feed.js";
import { createReadHandler } from "../dist/private/read-api/handler.js";
import { providerFixture } from "./fixtures/living-town-provider.mjs";
import { LivingTownProviderRunner } from "../dist/private/living-town/provider.js";
const cap = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-merchant-offers-sandbox.json",
    "utf8",
  ),
);
const identity = {
  deployment: cap.foundation.deployment,
  codeHash: cap.steps[0].account.code_hash,
  ownerId: cap.foundation.data.owner_account_id,
  operatorId: cap.foundation.data.operator_account_id,
  controllers: cap.foundation.data.merchant_controllers,
};
const rows = await Promise.all(
  cap.steps.map(async (s) => {
    const proof = {
      transactionHash: s.transaction_hash,
      signerId: s.signer_id,
      deployment: identity.deployment,
      call: createLivingTownCall(s.method, s.args),
      referenceBlockHeight: s.reference_block_height,
    };
    const status = await verifyLivingTownReceipt(
      s.receipt,
      proof,
      async (hash) => ({
        hash,
        height: String(s.block.header.height),
        timestampNs: s.block.header.timestamp_nanosec,
      }),
    );
    return livingTownIndexedReceipt(proof, { status, response: s.receipt });
  }),
);
test("actual receipt lifecycle is published for both merchants, once, only after projection coverage", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(townFeedSchema);
  const feed = new TownActivityFeed(db, identity, true);
  const row = rows.find(
    (r) =>
      r.status.result.data.outcome.kind === "trade_accepted" &&
      !r.status.result.data.replayed,
  );
  feed.receipt(row);
  assert.equal(feed.page(null).events.length, 0);
  const cp = {
    through_market_revision: "9999",
    finalized_block_height: "9999",
  };
  feed.flush(cp);
  const events = feed.page(null).events.map((e) => e.event);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.data.merchant).sort(), ["luna", "rex"]);
  for (const e of events) {
    assert.equal(e.data.kind, "accepted");
    assert.equal(e.data.transaction_hash, row.proof.transactionHash);
    assert.equal(e.data.receipt_id, row.status.executionReceiptId);
  }
  feed.receipt(row);
  feed.flush(cp);
  assert.equal(feed.page(null).events.length, 2);
  for (const r of rows) feed.receipt(r);
  feed.flush(cp);
  const all = feed.page(null).events.map((e) => e.event);
  for (const kind of [
    "proposed",
    "accepted",
    "rejected",
    "cancelled",
    "expired",
  ])
    assert(
      all.some((e) => e.data.kind === kind),
      kind,
    );
});
test("trade decisions gain confirmation only from their actor, method and offer-matched receipt", (t) => {
  for (const method of ["propose_trade", "accept_trade", "reject_trade"]) {
    const row = rows.find(
      (r) => r.proof.call.method === method && !r.status.result.data.replayed,
    );
    const result = row.status.result,
      offer = result.data.outcome.offer,
      merchant = result.data.principal.split(":")[1];
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    db.exec(townFeedSchema);
    const feed = new TownActivityFeed(db, identity, true);
    const a = {
      source: "model_proposal",
      transaction_hint: row.proof.transactionHash,
      checkpoint: {
        block_hash: row.status.block.hash,
        block_height: row.status.block.height,
        block_timestamp_ns: row.status.block.timestampNs,
        market_revision: result.data.effect_revision,
        event_sequence: result.data.effect_event_sequence,
      },
      data: {
        action_id: "a".repeat(64),
        tick_id: "b".repeat(64),
        merchant,
        offer_id: offer.offer_id,
        proposal_type: method,
        reason: "Controlled merchant decision.",
        validation: "allowed",
        outcome: "submitted",
        command_digest: result.data.payload_sha256,
        inference_ref: null,
        signals: [],
        transaction_hash: null,
        receipt_id: null,
      },
    };
    feed.agent(a);
    feed.receipt(row);
    feed.flush({
      through_market_revision: "9999",
      finalized_block_height: "9999",
    });
    const confirmed = feed
      .page(null)
      .events.map((x) => x.event)
      .find((e) => e.type === "agent_action" && e.source === "confirmed");
    assert(confirmed, method);
    assert.equal(confirmed.data.offer_id, offer.offer_id);
    assert.equal(confirmed.data.receipt_id, row.status.executionReceiptId);
    assert.throws(
      () => feed.agent({ ...a, data: { ...a.data, offer_id: "999" } }),
      /correlation changed/,
    );
  }
});

test("offer read capability rejects writes and unknown queries without invoking the reader", () => {
  let calls = 0;
  const handler = createReadHandler({
    health: () => ({}),
    activity: () => ({}),
    livingTown: {
      town: () => ({}),
      shop: () => ({}),
      inventory: () => ({}),
      production: () => ({}),
      offers: () => {
        calls++;
        return { items: [] };
      },
    },
  });
  const request = (method, url) => {
    const response = new EventEmitter();
    response.setHeader = () => {};
    response.writeHead = (status) => {
      response.status = status;
    };
    response.end = (body) => {
      response.body = body;
      response.emit("finish");
    };
    handler(
      {
        method,
        url,
        headers: {},
        resume: () => {},
        socket: { remoteAddress: "127.0.0.1" },
      },
      response,
    );
    return response;
  };
  assert.equal(request("GET", "/api/merchant-offers").status, 200);
  assert.equal(calls, 1);
  assert.equal(request("HEAD", "/api/merchant-offers").body, undefined);
  assert.equal(calls, 2);
  for (const [method, url, status] of [
    ["POST", "/api/merchant-offers", 405],
    ["GET", "/api/merchant-offers?accept=1", 400],
    ["GET", "/api/merchant-offers?limit=5", 400],
  ])
    assert.equal(request(method, url).status, status);
  assert.equal(calls, 2);
  handler.closeStreams();
});
test("thinking export uses dispatched audit facts and resolves without exposing provider payloads", async (t) => {
  let resolve;
  const f = await providerFixture(t, {
    invoke: async (c) => {
      c.reportIdentity({ provider: "fixture", model: "fixture-model" });
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  const town = f.context.facts.town;
  f.context.facts.activityCheckpoint = {
    block_hash: (await f.adapters.rex.client.finalized()).block.hash,
    block_height: town.block_height,
    block_timestamp_ns: town.block_timestamp_ns,
    market_revision: town.market_revision,
    event_sequence: town.event_sequence,
  };
  let published = 0;
  const runner = new LivingTownProviderRunner(
    f.store,
    f.policy,
    f.budget,
    f.binding,
    f.configuration,
    async () => true,
    15000,
    "policy",
    undefined,
    undefined,
    async () => {
      published++;
      assert(
        f.store
          .publicActivity()
          .records.some((r) => r.data.outcome === "thinking"),
      );
    },
  );
  const pending = runner.propose(f.context);
  for (let n = 0; n < 20 && !resolve; n++)
    await new Promise((r) => setImmediate(r));
  assert.equal(published, 1);
  assert(resolve);
  const exported = f.store.publicActivity().records;
  assert.equal(exported.at(-1).data.outcome, "thinking");
  assert(!JSON.stringify(exported).includes("messages"));
  resolve(
    JSON.stringify({
      schema: "living-town-proposal-v1",
      tick_id: f.context.tickId,
      market_revision: town.market_revision,
      merchant_id: "rex",
      reason: "Retain reserves.",
      action: { type: "wait" },
    }),
  );
  await pending;
  assert(
    !f.store
      .publicActivity()
      .records.some((r) => r.data.outcome === "thinking"),
  );
});
