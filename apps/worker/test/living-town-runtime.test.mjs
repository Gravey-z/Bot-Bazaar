import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LivingTownExecutionStore } from "../dist/private/living-town/execution-store.js";
import { RuntimeOwner } from "../dist/private/living-town/runtime-owner.js";
import { RuntimeFacts } from "../dist/private/living-town/runtime-facts.js";
import {
  publishRuntimeOutbox,
  drainRuntimeOutbox,
} from "../dist/private/living-town/runtime-outbox.js";
import { adapterFixture, identity } from "./fixtures/living-town-adapter.mjs";
import { verifyExpiredAllowanceRejection } from "../dist/private/living-town/admission-rejection.js";
import { boundedTownRpc } from "../dist/private/living-town/runtime-rpc.js";

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "town-live-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["exec", "witness", "outbox"]) mkdirSync(join(root, name));
  return root;
}

test("bounded RPC reuses only immutable block reads and preserves moving finality and transaction calls", async () => {
  let calls = 0,
    inFlight = 0,
    max = 0;
  const rpc = boundedTownRpc(async () => {
    calls++;
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { value: calls };
  }, 1);
  const first = await rpc("query", {
    block_id: "immutable",
    request_type: "call_function",
  });
  first.value = "mutated caller";
  assert.equal(
    (
      await rpc("query", {
        block_id: "immutable",
        request_type: "call_function",
      })
    ).value,
    1,
  );
  await Promise.all([
    rpc("block", { finality: "final" }),
    rpc("block", { finality: "final" }),
  ]);
  await rpc("send_tx", {});
  await rpc("send_tx", {});
  assert.equal(calls, 5);
  assert.equal(max, 1);
});

test("30 Tgas proofs and explicit expired allowance rejection preserve the original audit and reject unsafe retirement", async (t) => {
  const root = directory(t),
    f = await adapterFixture(join(root, "exec"));
  f.mode("timeout_before");
  await f.simulation.poll();
  const row = f.store.unresolved()[0],
    original = JSON.parse(row.signed_json);
  assert.equal(original.gas, "30000000000000");
  assert.equal(f.store.receiptProofs()[0].gas, "30000000000000");
  const evidence = {
    transactionHash: original.transactionHash,
    error: {
      cause: { name: "INVALID_TRANSACTION" },
      data: {
        TxExecutionError: {
          InvalidTxError: {
            InvalidAccessKeyError: {
              NotEnoughAllowance: {
                account_id: original.signerId,
                public_key: original.publicKey,
                allowance: "1",
                cost: "2",
              },
            },
          },
        },
      },
    },
  };
  const reader = {
    block: {
      hash: "11111111111111111111111111111111",
      height: "100",
      timestampNs: (
        BigInt(original.call.args.command.valid_until_ns) + 1n
      ).toString(),
    },
    getAccessKey: async () => ({
      nonce: (BigInt(original.nonce) - 1n).toString(),
      permission: {
        FunctionCall: {
          allowance: "1",
          receiver_id: original.deployment.contract_id,
        },
      },
    }),
    getCommand: async () => ({
      data: {
        kind: "not_applied",
        next_sequence: original.call.args.command.sequence,
      },
    }),
  };
  assert.throws(
    () =>
      f.store.resolveRejectedAdmission(row.id, {
        kind: "expired_admission_rejection",
        transactionHash: original.transactionHash,
      }),
    /verified/,
  );
  await assert.rejects(
    verifyExpiredAllowanceRejection(
      original,
      { ...evidence, transactionHash: "other" },
      reader,
      "operator",
    ),
    /original explicit/,
  );
  await assert.rejects(
    verifyExpiredAllowanceRejection(
      original,
      evidence,
      { ...reader, block: { ...reader.block, timestampNs: "1" } },
      "operator",
    ),
    /expired/,
  );
  await assert.rejects(
    verifyExpiredAllowanceRejection(
      original,
      evidence,
      {
        ...reader,
        getAccessKey: async () => ({
          ...(await reader.getAccessKey()),
          nonce: original.nonce,
        }),
      },
      "operator",
    ),
    /nonce/,
  );
  await assert.rejects(
    verifyExpiredAllowanceRejection(
      original,
      evidence,
      { ...reader, getCommand: async () => ({ data: { kind: "found" } }) },
      "operator",
    ),
    /may have applied/,
  );
  const proof = await verifyExpiredAllowanceRejection(
    original,
    evidence,
    reader,
    "operator",
  );
  f.store.resolveRejectedAdmission(row.id, proof);
  assert.equal(f.store.get(row.id).status, "failed");
  assert.equal(f.store.get(row.id).signed_json, row.signed_json);
  assert.deepEqual(f.store.receiptProofs(), []);
  assert.deepEqual(f.store.rejectedAdmissions(), [original.transactionHash]);
  f.close();
});
test("actual witness follows durable pending intent through restart, verifies context, and rejects rolled-back journals", async (t) => {
  const root = directory(t),
    execution = join(root, "exec"),
    witness = join(root, "witness");
  let facts, owner;
  const setup = (create) => (store) => {
    facts = new RuntimeFacts(execution, identity, create);
    owner = new RuntimeOwner(
      store,
      facts,
      witness,
      { tested: "restricted-lanes" },
      create,
    );
    return owner.attest.bind(owner);
  };
  const f = await adapterFixture(execution, { continuityFactory: setup(true) });
  assert.equal(
    await owner.attest({
      sessionId: "other",
      identityHash: f.store.identityHash,
    }),
    undefined,
  );
  // Create a closed checkpoint of the old execution DB before any action.
  owner.close();
  facts.close();
  f.close();
  copyFileSync(
    join(execution, "worker.sqlite"),
    join(root, "old-worker.sqlite"),
  );
  const running = await adapterFixture(execution, {
    continuityFactory: setup(false),
  });
  running.mode("timeout_before");
  const action = await running.simulation.poll();
  const original = running.store.unresolved()[0];
  assert.equal(action.action.kind, "unknown");
  assert.ok(original.tx_hash);
  owner.verify();
  running.save();
  owner.close();
  facts.close();
  running.close();
  const resumed = await adapterFixture(execution, {
    continuityFactory: setup(false),
  });
  assert.equal((await resumed.simulation.poll()).kind, "blocked");
  assert.equal(resumed.stats.sign, 0);
  assert.equal(resumed.stats.send, 0);
  assert.equal(resumed.store.unresolved()[0].signed_json, original.signed_json);
  owner.close();
  facts.close();
  resumed.close();
  copyFileSync(
    join(root, "old-worker.sqlite"),
    join(execution, "worker.sqlite"),
  );
  const rolled = new LivingTownExecutionStore(execution, identity, "42");
  const oldFacts = new RuntimeFacts(execution, identity, false);
  assert.throws(
    () =>
      new RuntimeOwner(
        rolled,
        oldFacts,
        witness,
        { tested: "restricted-lanes" },
        false,
      ),
    /witness mismatch/,
  );
  oldFacts.close();
  rolled.close();
});

test("finalized collectors persist last-sale history and refuse gaps and mixed market pages", async (t) => {
  const root = directory(t),
    f = await adapterFixture(join(root, "exec"));
  const facts = new RuntimeFacts(join(root, "exec"), identity, true);
  const pin = (data) => ({
    ...structuredClone(f.state.town),
    data: structuredClone(data),
  });
  let gap = false,
    mixed = false,
    marketReads = 0;
  const trade = {
    trade_id: "1",
    kind: "customer_sale",
    seller: { kind: "player", account_id: "player.testnet" },
    item_id: "health_potion",
    settled_at_ns: f.state.town.block_timestamp_ns,
    event_sequence: f.state.town.event_sequence,
  };
  const town = () => {
    const v = pin(f.state.town.data);
    v.data.next_trade_id = "2";
    return v;
  };
  const reader = {
    getTown: async () => town(),
    getTrade: async () =>
      pin(gap ? { kind: "pruned", id: "1" } : { kind: "found", value: trade }),
    getListings: async () => {
      marketReads++;
      return {
        ...pin({
          items: structuredClone(f.state.listings),
          has_more: false,
          next_after_id: null,
          history_gap: false,
        }),
        ...(mixed ? { block_height: "999" } : {}),
      };
    },
    getShop: async (id) => pin(f.state.town.data.npc_shops[Number(id) - 1]),
    getProductionJobs: async () => pin({ items: [], has_more: false }),
  };
  let result = await facts.collect(reader);
  assert.equal(result.merchant.historyComplete, true);
  assert.equal(result.merchant.trades.length, 1);
  // Caller mutation cannot corrupt the complete observation cache. A newer finalized
  // header may reuse subordinate facts only while the entire authoritative town agrees.
  result.merchant.merchants[0].listings.length = 0;
  f.state.town.block_height = (
    BigInt(f.state.town.block_height) + 1n
  ).toString();
  const lifted = await facts.collect(reader);
  assert.equal(marketReads, 1);
  assert.ok(lifted.merchant.merchants[0].listings.length > 0);
  assert.equal(
    lifted.merchant.merchants[0].shop.block_height,
    f.state.town.block_height,
  );
  facts.close();
  const reopened = new RuntimeFacts(join(root, "exec"), identity, false);
  gap = true; // Already observed trade may be pruned without losing its authenticated cache.
  result = await reopened.collect(reader);
  assert.equal(result.customer.historyComplete, true);
  mixed = true;
  f.state.town.market_revision = (
    BigInt(f.state.town.market_revision) + 1n
  ).toString();
  f.state.town.event_sequence = f.state.town.market_revision;
  await assert.rejects(reopened.collect(reader), /mixed market/);
  reopened.close();
  f.close();
  const missingDir = join(root, "gap");
  mkdirSync(missingDir);
  const missing = new RuntimeFacts(missingDir, identity, true);
  mixed = false;
  assert.equal((await missing.collect(reader)).customer.historyComplete, false);
  missing.close();
});

test("outbox removes private signed fields, preserves unacknowledged receipts, and acknowledges only committed proofs", async (t) => {
  const root = directory(t),
    f = await adapterFixture(join(root, "exec"));
  await f.simulation.poll();
  const file = join(root, "activity.json"),
    out = join(root, "outbox");
  await publishRuntimeOutbox(f.store, out, file);
  const name = readdirSync(out).find((n) => n.endsWith(".json"));
  assert.ok(name);
  const body = readFileSync(join(out, name), "utf8");
  assert.equal(body.includes("signedTransactionBase64"), false);
  assert.equal(body.includes("private_key"), false);
  let ingest = 0;
  await drainRuntimeOutbox(out, identity, {
    ingest: async () => {
      ingest++;
      return "unresolved";
    },
  });
  assert.equal(ingest, 1);
  assert.ok(readdirSync(out).includes(name));
  await drainRuntimeOutbox(out, identity, { ingest: async () => "indexed" });
  assert.ok(readdirSync(join(out, "archive")).includes(name));
  await publishRuntimeOutbox(f.store, out, file);
  assert.equal(readdirSync(out).filter((n) => n.endsWith(".json")).length, 0);
  f.close();
});

test("executable policy omits zero-value source transactions so completed shelves do not starve customer turns", async (t) => {
  const root = directory(t),
    f = await adapterFixture(join(root, "exec"), {
      simulationOptions: { skipEmptySources: true },
    });
  const r = await f.simulation.poll();
  assert.equal(r.kind, "advanced");
  const tick = f.store.ticks.active();
  const actions = f.store.ticks.actions(tick.id);
  assert.equal(
    actions.some((a) => String(a.arrival).startsWith("raw:")),
    false,
  );
  assert.equal(
    actions.some((a) => String(a.arrival).startsWith("sweep:")),
    false,
  );
  assert.ok(String(actions[0].arrival).startsWith("merchant:"));
  f.close();
});

test("rules runtime keeps funded customer turns when all merchants are idle without issuing another allowance", async (t) => {
  const root = directory(t),
    f = await adapterFixture(join(root, "exec"), {
      fundOnlyWhenNeeded: true,
      simulationOptions: {
        skipEmptySources: true,
        skipIdleMerchantTurns: true,
      },
    });
  f.state.town.data.customer_pool.gold = "100";
  const bolt = f.state.town.data.npc_ledgers.find(
    (l) => l.actor.merchant_id === "bolt",
  );
  bolt.inventory.held.iron_tool = "1";
  bolt.inventory.available.iron_tool = "1";
  // Match the pure policy's expected initial target listings, so all three decisions are waits.
  for (const l of f.state.listings) {
    // This controlled legacy snapshot holds 20 iron against the fresh target of 12.
    if (l.item_id === "iron") l.unit_price = "3";
    const ledger = f.state.town.data.npc_ledgers.find(
      (x) => x.actor.merchant_id === l.owner.merchant_id,
    );
    const q = l.owner.merchant_id === "bolt" ? "3" : "4";
    l.remaining_quantity = q;
    ledger.inventory.listing_reserved[l.item_id] = q;
    ledger.inventory.available[l.item_id] = (
      BigInt(ledger.inventory.held[l.item_id]) - BigInt(q)
    ).toString();
  }
  const result = await f.simulation.poll();
  assert.equal(result.kind, "idle");
  const actions = f.store.ticks.actions(f.store.ticks.active().id);
  assert.equal(
    actions.some((a) => a.arrival === "fund"),
    false,
  );
  assert.equal(
    actions.some((a) => String(a.arrival).startsWith("merchant:")),
    false,
  );
  assert.deepEqual(
    actions.map((a) => a.arrival),
    ["0", "1", "2", "3"],
  );
  assert.equal(f.stats.sign, 0);
  assert.equal(f.stats.send, 0);
  f.close();
});
