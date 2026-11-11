import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeFacts } from "../dist/private/living-town/runtime-facts.js";
const read = (p) => JSON.parse(readFileSync(p, "utf8")),
  clone = structuredClone;
const cap = read(
    "tests/fixtures/chain/living-town-merchant-offers-sandbox.json",
  ),
  cfg = read("config/living-town-v1.json"),
  names = ["rex", "luna", "bolt"];
function result(step) {
  const id = step.receipt.transaction_outcome.outcome.status.SuccessReceiptId;
  return JSON.parse(
    Buffer.from(
      step.receipt.receipts_outcome.find((r) => r.id === id).outcome.status
        .SuccessValue,
      "base64",
    ).toString(),
  ).data.outcome;
}

test("runtime facts retain a 299-second-old retail purchase across the old epoch cutoff", async () => {
  // Controlled finalized-read boundary around archived ledgers/trade shapes.
  // Shift timestamps to test retention; these are not additional chain receipts.
  const town = clone(cap.low),
    now = BigInt(town.data.genesis_time_ns) + 650000000000n;
  town.block_timestamp_ns = now.toString();
  town.data.epoch = town.data.customer_pool.epoch = "10";
  const identity = {
    deployment: town.deployment,
    codeHash: cap.steps[0].account.code_hash,
    ownerId: cap.foundation.data.owner_account_id,
    operatorId: cap.foundation.data.operator_account_id,
    controllers: cap.foundation.data.merchant_controllers,
  };
  const captured = cap.steps
      .map(result)
      .filter(
        (o) =>
          o.trade && BigInt(o.trade.trade_id) < BigInt(town.data.next_trade_id),
      )
      .map((o) => o.trade),
    trades = new Map(captured.map((t) => [t.trade_id, clone(t)]));
  const retail = trades.get("2");
  assert.equal(retail.kind, "raw_purchase");
  retail.settled_at_ns = (now - 299000000000n).toString();
  const ids = { crystal: "1", herb: "2", wood: "3", iron: "4" };
  const listings = Object.entries(cfg.economy.materials)
    .map(([item, r]) => {
      const i = names.indexOf(r.supplier),
        quantity = town.data.npc_ledgers[i].inventory.listing_reserved[item];
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
  const reader = {
    identity,
    block: {
      hash: cap.steps[6].block.header.hash,
      height: town.block_height,
      timestampNs: town.block_timestamp_ns,
    },
    getTown: async () => clone(town),
    getPendingMerchantOffers: async () => ({ town: clone(town), offers: [] }),
    getFoundation: async () => ({ ...clone(town), data: cap.foundation.data }),
    getTrade: async (id) => ({
      ...clone(town),
      data: { kind: "found", value: trades.get(id) },
    }),
    getListings: async () => ({
      ...clone(town),
      data: {
        items: listings,
        next_after_id: "4",
        has_more: false,
        history_gap: false,
        pruned_through: "0",
      },
    }),
    getProductionJobs: async () => ({
      ...clone(town),
      data: {
        items: [],
        next_after_id: null,
        has_more: false,
        history_gap: false,
        pruned_through: "0",
      },
    }),
  };
  const directory = mkdtempSync(join(tmpdir(), "bazaar-stock-sharing-facts-"));
  let facts;
  try {
    facts = new RuntimeFacts(directory, identity, true);
    const value = await facts.collect(reader);
    assert.equal(value.merchant.historyComplete, true);
    assert.deepEqual(
      value.merchant.trades.map((t) => t.trade_id),
      ["2"],
    );
    assert.equal(value.merchant.trades[0].settled_at_ns, retail.settled_at_ns);
    assert.deepEqual(
      facts.purchasesAfter("0").map((t) => t.trade_id),
      ["2"],
    );
    facts.close();
    facts = new RuntimeFacts(directory, identity, false);
    const again = await facts.collect(reader);
    assert.deepEqual(
      again.merchant.trades.map((t) => t.trade_id),
      ["2"],
    );
    // Demand expiry must not erase the unconsumed durable purchase signal.
    town.block_timestamp_ns = String(now + 301000000000n);
    town.data.epoch = town.data.customer_pool.epoch = String(
      (BigInt(town.block_timestamp_ns) - BigInt(town.data.genesis_time_ns)) /
        60000000000n,
    );
    town.market_revision = town.event_sequence = String(
      BigInt(town.market_revision) + 1n,
    );
    town.block_height = String(BigInt(town.block_height) + 1n);
    const aged = await facts.collect(reader);
    assert.equal(aged.merchant.trades.length, 0);
    assert.deepEqual(
      facts.purchasesAfter("0").map((t) => t.trade_id),
      ["2"],
    );
    assert.deepEqual(facts.purchasesAfter("2"), []);
  } finally {
    facts?.close();
    assert(
      resolve(directory).startsWith(
        resolve(tmpdir(), "bazaar-stock-sharing-facts-"),
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});
