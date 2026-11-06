// Real scheduler/journal/policy/signatures, controlled finalized state and receipt boundary.
// Recorded proposal responses are not actual provider inference or extra chain receipts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { adapterFixture } from "./living-town-adapter.mjs";
import { parseTownProposal } from "../../dist/private/living-town/proposals.js";
export const normalize = (value) =>
  typeof value === "bigint"
    ? String(value)
    : Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, normalize(value[k])]),
          )
        : value;
export const fingerprint = (value) =>
  createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
export const replayEpochs = [1, 2, 3, 4, 7, 8, 10008];
const names = ["rex", "luna", "bolt"];
function recordedOutput(context) {
  const epoch = context.facts.town.data.epoch;
  let action = {
    type: "restock",
    item_id:
      context.merchant === "rex"
        ? "crystal"
        : context.merchant === "luna"
          ? "herb"
          : "iron_tool",
  };
  if (epoch === "2" && context.merchant === "rex")
    action = { type: "adjust_price", item_id: "crystal", unit_price: "5" };
  if (epoch === "2" && context.merchant === "luna")
    action = {
      type: "propose_trade",
      counterparty: "rex",
      side: "buy",
      item_id: "crystal",
      quantity: "1",
      unit_price: "4",
    };
  if (epoch === "3" && context.merchant === "rex")
    action = { type: "reject_trade", offer_id: "1" };
  if (epoch === "3" && context.merchant === "luna")
    action = {
      type: "accept_trade",
      offer_id: "1",
      expected_offer_revision: "1",
    };
  if (epoch === "3" && context.merchant === "bolt") action = { type: "wait" };
  return parseTownProposal({
    schema: context.schemaVersion,
    tick_id: context.tickId,
    merchant_id: context.merchant,
    market_revision: context.facts.town.market_revision,
    reason: "Recorded provider-free replay response.",
    action,
  });
}
function advance(f, epoch) {
  const t = f.state.town;
  t.block_height = String(BigInt(t.block_height) + 1000n);
  t.block_timestamp_ns = String(
    BigInt(t.data.genesis_time_ns) + BigInt(epoch) * 60000000000n + 5000000000n,
  );
  t.data.epoch = String(epoch);
  t.data.customer_pool = structuredClone(t.data.customer_pool);
  t.data.customer_pool.epoch = String(epoch);
  t.data.customer_pool.last_funded_epoch = String(epoch);
  t.data.customer_pool.potion_units_bought =
    t.data.customer_pool.tool_units_bought = "0";
}
export async function replaySimulation(
  dir,
  { tape = null, restart = false, seed = "42" } = {},
) {
  const recorded = [],
    errors = [],
    epochs = [];
  let cursor = 0,
    fixture;
  const totals = { sign: 0, send: 0, recordedProposals: 0 };
  const propose = async (context) => {
    const reference = {
      tick: context.tickId,
      merchant: context.merchant,
      facts: fingerprint(context.facts),
    };
    try {
      const entry = tape
        ? tape[cursor++]
        : { reference, output: recordedOutput(context) };
      assert(entry, "recorded tape exhausted");
      assert.deepEqual(
        reference,
        entry.reference,
        "recorded replay context changed",
      );
      const output = parseTownProposal(entry.output);
      recorded.push({ reference, output });
      return structuredClone(output);
    } catch (e) {
      errors.push(e);
      throw e;
    }
  };
  fixture = await adapterFixture(dir, { propose, realCustomers: true, seed });
  try {
    const t = fixture.state.town,
      revision = String(BigInt(t.market_revision) + 1n);
    t.market_revision = t.event_sequence = revision;
    t.data.market_event = {
      event_id: "1",
      definition_id: "herb_shortage_v1",
      start_epoch: "2",
      end_epoch: "7",
      herb_supply_ceiling: "4",
      revision,
    };
    t.data.next_market_event_id = "2";
    // Explicit controlled depleted initial state, preserving each NPC's protected floor.
    const floors = {
      crystal: ["rex", "2"],
      wood: ["bolt", "2"],
      herb: ["luna", "8"],
      iron: ["bolt", "4"],
    };
    for (const [item, [owner, floor]] of Object.entries(floors)) {
      const inv = t.data.npc_ledgers[names.indexOf(owner)].inventory;
      inv.held[item] = inv.available[item] = floor;
      inv.listing_reserved[item] = "0";
      const listing = fixture.state.listings.find((l) => l.item_id === item);
      listing.remaining_quantity = "0";
      listing.active = false;
    }
    for (const epoch of replayEpochs) {
      advance(fixture, epoch);
      let tickId;
      const before = { send: fixture.stats.send, model: fixture.stats.model };
      for (let n = 0; n < 40; n++) {
        const result = await fixture.simulation.poll();
        if (errors.length) throw errors[0];
        assert.notEqual(result.kind, "blocked", JSON.stringify(result));
        const active = fixture.store.ticks.active();
        if (active) tickId = String(active.id);
        if (tickId && !active) break;
        if (n === 39) throw Error("tick did not terminate within its bound");
      }
      assert(tickId);
      assert(fixture.stats.model - before.model <= 3, "catch-up model burst");
      assert(fixture.stats.send - before.send <= 10, "catch-up dispatch burst");
      const tick = fixture.store.ticks.get(tickId),
        actions = fixture.store.ticks.actions(tickId).map((a) => {
          const row = fixture.store.get(a.action_id);
          return {
            id: a.action_id,
            arrival: a.arrival,
            state: a.state,
            method: row?.method ?? null,
            args: row?.args_json ? JSON.parse(row.args_json) : null,
          };
        });
      assert(actions.length <= 15);
      assert(
        actions.every((a) =>
          ["completed", "failed", "expired"].includes(a.state),
        ),
      );
      epochs.push({
        epoch,
        tick: {
          id: tick.id,
          slot: tick.slot,
          missedEpochs: tick.missed_epochs,
          skippedSlots: tick.skipped_slots,
        },
        actions,
        town: structuredClone(fixture.state.town.data),
      });
      const quiet = { ...fixture.stats };
      for (let n = 0; n < 3; n++) await fixture.simulation.poll();
      assert.deepEqual(fixture.stats, quiet, "duplicate ticks invoked work");
      if (restart) {
        for (const k of ["sign", "send"]) totals[k] += fixture.stats[k];
        totals.recordedProposals += fixture.stats.model;
        fixture.save();
        fixture.close();
        fixture = await adapterFixture(dir, {
          propose,
          realCustomers: true,
          seed,
        });
      }
    }
    if (tape) assert.equal(cursor, tape.length, "unused recorded responses");
    for (const k of ["sign", "send"]) totals[k] += fixture.stats[k];
    totals.recordedProposals += fixture.stats.model;
    const activity = fixture.store
      .publicActivity()
      .records.map(({ source, checkpoint, data }) => ({
        source,
        checkpoint,
        data,
      }));
    const result = {
      seed,
      epochs,
      activity,
      totals,
      boundaries: fixture.store.marketEvents.list(),
    };
    return {
      tape: recorded,
      result,
      digest: fingerprint(result),
      report: {
        mode: "controlled_worker_replay",
        providerCalls: 0,
        chainEvidence: false,
        epochs: replayEpochs,
        recordedResponses: recorded.length,
        signatures: totals.sign,
        dispatches: totals.send,
        missedEpochs: epochs.at(-1).tick.missedEpochs,
        digest: fingerprint(result),
      },
    };
  } finally {
    fixture.close();
  }
}
