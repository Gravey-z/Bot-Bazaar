import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  livingTownIndexedReceipt,
  livingTownMarketEvent,
  livingTownMarketEventHistory,
  livingTownSourceEffect,
  describeLivingTownMarketEvent,
} from "../../packages/chain/dist/index.js";
const fixture = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-market-event-sandbox.json",
    "utf8",
  ),
);
const event = fixture.after.data.market_event;
test("actual shortage scheduling/supply receipts bind exact SDK terms without fabricating activation transactions", async () => {
  for (const s of fixture.steps) {
    const proof = {
      transactionHash: s.transaction_hash,
      signerId: s.signer_id,
      deployment: s.foundation.deployment,
      call: createLivingTownCall(s.method, s.args),
      referenceBlockHeight: s.reference_block_height,
    };
    const status = await verifyLivingTownReceipt(
      s.receipt,
      proof,
      async (hash) => {
        assert.equal(hash, s.block.header.hash);
        return {
          hash,
          height: String(s.block.header.height),
          timestampNs: s.block.header.timestamp_nanosec,
        };
      },
    );
    assert.equal(status.kind, "succeeded");
    livingTownIndexedReceipt(proof, { status, response: s.receipt });
  }
  const scheduled = fixture.steps.filter(
    (s) => s.method === "schedule_market_event",
  );
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].effect.data.replayed, true);
  const sources = fixture.steps.filter(
    (s) => s.method === "allocate_raw_supply",
  );
  assert.deepEqual(
    sources.map((s) => s.effect.data.outcome.issued_quantity),
    ["4", "4", "8"],
  );
  assert.equal(fixture.after.data.totals.supplied_items.herb, "16");
  assert.equal(fixture.after.data.npc_ledgers[1].inventory.held.herb, "20");
});
test("event status shows announced baseline/changed caps and restores the rule exactly at expiry", () => {
  const start = BigInt(event.start_epoch),
    end = BigInt(event.end_epoch);
  for (const [epoch, status, current] of [
    [start - 1n, "scheduled", "8"],
    [start, "active", "4"],
    [end - 1n, "active", "4"],
    [end, "ended", "8"],
    [end + 10000n, "ended", "8"],
  ]) {
    const description = describeLivingTownMarketEvent(event, String(epoch));
    assert.equal(description.status, status);
    assert.equal(description.current, current);
    assert.equal(description.baseline, "8");
    assert.match(description.explanation, /stock already held is preserved/);
  }
});
test("event decoder rejects edited duration, arbitrary definitions/modifiers and discontinuous retained identities", () => {
  for (const patch of [
    { end_epoch: String(BigInt(event.end_epoch) + 1n) },
    { definition_id: "surplus" },
    { herb_supply_ceiling: "9" },
    { start_epoch: "01" },
    { multiplier: "2" },
  ])
    assert.throws(() => livingTownMarketEvent({ ...event, ...patch }));
  assert.throws(() =>
    livingTownMarketEventHistory({
      items: [event, event],
      pruned_through: "0",
    }),
  );
  const args = fixture.steps.find(
    (s) => s.method === "schedule_market_event",
  ).args;
  for (const patch of [
    { herb_supply_ceiling: "10" },
    { definition_id: "surplus" },
    { event_id: "0" },
    { start_epoch: 1 },
  ])
    assert.throws(() =>
      createLivingTownCall("schedule_market_event", { ...args, ...patch }),
    );
});
test("SDK source formula independently rejects baseline-sized herb issuance during the shortage", () => {
  const source = structuredClone(
    fixture.steps.find((s) => s.method === "allocate_raw_supply").effect.data,
  );
  source.outcome.issued_quantity = "8";
  assert.throws(() => livingTownSourceEffect(source));
  const wrong = structuredClone(source);
  wrong.outcome.market_event.end_epoch = wrong.outcome.market_event.start_epoch;
  assert.throws(() => livingTownSourceEffect(wrong));
});
