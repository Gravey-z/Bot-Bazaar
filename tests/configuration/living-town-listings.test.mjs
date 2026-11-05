import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  verifyLivingTownEffect,
  livingTownIndexedReceipt,
  livingTownCommandDigest,
  canonicalLivingTownJson,
  livingTownListingEffect,
  FinalizedLivingTownReader,
} from "../../packages/chain/dist/index.js";
import { LivingTownProjectionStore } from "../../apps/worker/dist/private/living-town/store.js";
const p = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-listings-sandbox.json",
    "utf8",
  ),
);
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
const foundation = p.steps[0].foundation;
const identity = {
  deployment: foundation.deployment,
  codeHash: p.steps[0].account.code_hash,
  ownerId: foundation.data.owner_account_id,
  operatorId: foundation.data.operator_account_id,
  controllers: foundation.data.merchant_controllers,
};
const proofs = p.steps.map((s) => ({
  transactionHash: s.transaction_hash,
  signerId: s.signer_id,
  deployment: identity.deployment,
  call: createLivingTownCall(s.method, s.args),
  referenceBlockHeight: s.reference_block_height,
}));
const statuses = await Promise.all(
  p.steps.map((s, i) =>
    verifyLivingTownReceipt(s.receipt, proofs[i], async () => block(s.block)),
  ),
);
const events = p.steps.map((s, i) =>
  livingTownIndexedReceipt(proofs[i], {
    status: statuses[i],
    response: s.receipt,
  }),
);
test("pinned command lookup decodes listing effects in player and merchant lanes", async () => {
  for (const index of [0, 3, 7, 8]) {
    const result = statuses[index].result;
    const principal = result.data.principal;
    const finalized = block(p.steps[index].block);
    const reader = new FinalizedLivingTownReader(
      async (method, args) => {
        assert.equal(method, "query");
        assert.equal(args.block_id, finalized.hash);
        assert.equal(args.method_name, "get_command");
        return {
          block_hash: finalized.hash,
          block_height: finalized.height,
          result: Array.from(
            Buffer.from(
              JSON.stringify({
                ...result,
                data: {
                  kind: "found",
                  high_water: result.data.command_sequence,
                  method: p.steps[index].method,
                  payload_sha256: result.data.payload_sha256,
                  effect: result.data,
                },
              }),
            ),
          ),
        };
      },
      identity,
      finalized,
    );
    // Controlled query envelope around an actual verified receipt effect;
    // this is not claimed as a separately captured get_command RPC response.
    const row = await reader.getCommand(
      principal.startsWith("merchant:") ? principal : p.steps[index].signer_id,
      result.data.command_sequence,
    );
    assert.equal(row.data.kind, "found");
    assert.equal(row.data.effect.principal, principal);
  }
});
test("listing arguments use replacement quantity with exact revision, integer and price bounds", () => {
  const args = p.steps[0].args;
  assert.equal(
    createLivingTownCall("set_listing", { ...args, quantity: "0" }).args
      .quantity,
    "0",
  );
  for (const [key, value] of [
    ["quantity", "101"],
    ["quantity", "1.5"],
    ["quantity", 1],
    ["unit_price", "0"],
    ["unit_price", "101"],
    ["expected_listing_revision", "0"],
    ["expected_listing_revision", 0],
    ["owner", "forged.testnet"],
  ])
    assert.throws(() =>
      createLivingTownCall("set_listing", { ...args, [key]: value }),
    );
  assert.throws(() =>
    createLivingTownCall("cancel_listing", {
      ...p.steps[3].args,
      expected_listing_revision: null,
    }),
  );
});
test("actual listing receipts bind ownership, replacement quantities, merchant lanes and original replay", async () => {
  assert.equal(statuses.length, 9);
  assert(statuses.every((s) => s.kind === "succeeded"));
  assert.equal(events.filter((e) => e.event !== null).length, 8);
  assert.equal(events[2].event, null);
  const listings = statuses
    .slice(0, 7)
    .map((s) => s.result.data.outcome.listing);
  assert.deepEqual(
    listings.map((l) => l.listing_id),
    Array(7).fill("5"),
  );
  assert.deepEqual(
    listings.map((l) => l.remaining_quantity),
    ["2", "1", "1", "0", "2", "0", "3"],
  );
  assert.deepEqual(
    listings.map((l) => l.revision),
    ["1", "2", "2", "3", "4", "5", "6"],
  );
  assert.equal(
    statuses[3].result.data.outcome.ledger.inventory.available.health_potion,
    "3",
  );
  assert.equal(statuses[8].result.data.principal, "merchant:rex");
  assert.equal(
    await livingTownCommandDigest(
      identity.deployment,
      p.steps[8].signer_id,
      proofs[8].call,
      "merchant:rex",
    ),
    statuses[8].result.data.payload_sha256,
  );
  assert.equal(
    canonicalLivingTownJson(p.before.data.inventory.held),
    canonicalLivingTownJson(p.after.data.inventory.held),
  );
  assert.equal(p.after.data.inventory.listing_reserved.health_potion, "3");
});
test("forged listing amounts, revisions, owner, price and reservations fail effect verification", async () => {
  const original = statuses[0].result;
  for (const mutate of [
    (v) => (v.data.outcome.listing.remaining_quantity = "3"),
    (v) => (v.data.outcome.listing.unit_price = "19"),
    (v) => (v.data.outcome.listing.revision = "2"),
    (v) => (v.data.outcome.listing.owner.account_id = "other.testnet"),
    (v) =>
      (v.data.outcome.ledger.inventory.listing_reserved.health_potion = "1"),
    (v) => (v.data.outcome.listing.item_id = "crystal"),
  ]) {
    const forged = structuredClone(original);
    mutate(forged);
    await assert.rejects(
      verifyLivingTownEffect(
        forged,
        identity.deployment,
        p.steps[0].signer_id,
        proofs[0].call,
      ),
    );
  }
  const cancellation = structuredClone(statuses[8].result.data);
  cancellation.principal = "account:" + p.steps[8].signer_id;
  assert.throws(() => livingTownListingEffect(cancellation));
});
test("listing projection keeps a visible gap until a coherent finalized reservation baseline", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "living-town-listings-"));
  const store = new LivingTownProjectionStore(dir, identity, true);
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "living-town-listings-")));
    rmSync(dir, { recursive: true, force: true });
  });
  const baseline = (s) => ({
    block: block(s.block),
    town: s.town,
    shops: s.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    production: [
      ...["1", "2", "3"].map((shopId) => ({
        shopId,
        pages: [
          {
            ...s.town,
            data: {
              items: [],
              next_after_id: null,
              has_more: false,
              history_gap: false,
              pruned_through: "0",
            },
          },
        ],
      })),
      ...s.shops.map((r) => ({ shopId: r.shop.data.shop_id, pages: [r.jobs] })),
    ],
  });
  // NPC empty production pages are controlled inputs; the player snapshots and
  // listing receipts are actual captures of this same disposable contract.
  store.baseline(baseline(p.before_state));
  store.commit(events[0]);
  assert.equal(store.inventory("4").stale, true);
  assert.equal(
    store.inventory("4").snapshot.data.inventory.listing_reserved.health_potion,
    "0",
  );
  store.baseline(baseline(p.after_state));
  for (const event of events) store.commit(event);
  assert.equal(
    store.inventory("4").snapshot.data.inventory.listing_reserved.health_potion,
    "3",
  );
  assert.equal(
    store.inventory("4").snapshot.data.inventory.held.health_potion,
    "3",
  );
  assert.equal(store.inventory("4").history_complete, false);
});
