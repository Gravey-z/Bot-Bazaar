import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterFixture,
  closeAdapterFixturesAt,
  identity,
} from "./fixtures/living-town-adapter.mjs";
import { AssistantPipeline } from "../dist/private/assistant/pipeline.js";
import { AssistantStore } from "../dist/private/assistant/store.js";
import {
  automaticAssistant,
  resolveAssistantReprice,
} from "../dist/private/assistant/automatic.js";
import { bindProposal } from "../dist/private/assistant/proposals.js";
import {
  townOperatorMethods,
  townSourceMethods,
  assertRuntimePermission,
} from "../dist/private/near-signer.js";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  livingTownIndexedReceipt,
  canonicalLivingTownJson,
} from "@bot-bazaar/chain";
const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-reprice-sandbox.json", "utf8"),
);
test("actual WASM repricing receipts bind exact SDK terms and retain original acknowledgments after revoke", async () => {
  for (const s of capture.steps) {
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
      async () => ({
        hash: s.block.header.hash,
        height: String(s.block.header.height),
        timestampNs: s.block.header.timestamp_nanosec,
      }),
    );
    assert.equal(status.kind, "succeeded");
    livingTownIndexedReceipt(proof, { status, response: s.receipt });
  }
  assert.deepEqual(capture.before.data, capture.after.data);
  assert.equal(capture.steps[0].effect.data.outcome.listing.unit_price, "12");
  assert.equal(capture.steps[1].effect.data.replayed, true);
  assert.equal(capture.rejected.length, 12);
  for (const name of ["web", "reader", "assistant"])
    assert.equal(
      JSON.parse(
        readFileSync(`config/living-town-${name}.example.json`, "utf8"),
      ).identity.codeHash,
      capture.steps[0].account.code_hash,
    );
});
test("repricing DTO rejects spending, quantity, recipient and missing policy revision", () => {
  for (const extra of ["quantity", "recipient", "allowed_actions", "shop_id"])
    assert.throws(() =>
      createLivingTownCall("assistant_reprice", {
        ...capture.steps[0].args,
        [extra]: "1",
      }),
    );
  const args = structuredClone(capture.steps[0].args);
  delete args.expected_policy_revision;
  assert.throws(() => createLivingTownCall("assistant_reprice", args));
});
test("reviewed operator key scope is exact, finite and cannot sign owner policy changes", () => {
  const permission = (methods) => ({
    FunctionCall: {
      receiver_id: identity.deployment.contract_id,
      allowance: "10000000000000000000000",
      method_names: methods,
    },
  });
  assertRuntimePermission(
    permission([...townOperatorMethods]),
    identity.deployment.contract_id,
    "town_operator",
  );
  for (const methods of [
    [...townSourceMethods],
    [...townOperatorMethods, "set_assistant_permissions"],
    ["assistant_reprice"],
    [],
  ])
    assert.throws(() =>
      assertRuntimePermission(
        permission(methods),
        identity.deployment.contract_id,
        "town_operator",
      ),
    );
});
async function harness(
  t,
  { invalid = false, mode = "success", realCustomers = false } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-auto-")),
    privateDir = join(dir, "assistant");
  mkdirSync(privateDir);
  const assistantStore = new AssistantStore(
    privateDir,
    canonicalLivingTownJson(identity),
    true,
  );
  let f,
    proposals = 0;
  const facts = () => ({
    snapshot: {
      deployment: identity.deployment,
      block_hash: capture.steps[0].block.header.hash,
      block_height: f.state.town.block_height,
      block_timestamp_ns: f.state.town.block_timestamp_ns,
      market_revision: f.state.town.market_revision,
      event_sequence: f.state.town.event_sequence,
    },
    shop: structuredClone(f.state.assistantShop),
    ledger: structuredClone(f.state.assistantLedger),
    listings: [structuredClone(f.state.assistantListing)],
    fresh: true,
    historyComplete: true,
    restockSpending: { tick: "0", day: "0" },
    paused: f.state.town.data.paused,
    productionCost: { health_potion: "6", iron_tool: null },
    demand: { health_potion: "2", iron_tool: "0" },
    assistantPolicy: structuredClone(f.state.assistantPolicy),
  });
  const pipeline = new AssistantPipeline(assistantStore, {
    load: async () => facts(),
  });
  const capability = automaticAssistant(["4"], pipeline, {
    identity,
    finalized: async () => f.adapters.operator.client.finalized(),
  });
  const assistant = {
    ...capability,
    async propose(shop, reader) {
      proposals++;
      if (invalid)
        return {
          ...bindProposal(
            {
              action: {
                type: "suggest_price",
                item_id: "health_potion",
                listing_id: "5",
                expected_listing_revision: "1",
                current_unit_price: "10",
                suggested_unit_price: "99",
              },
              reason: "controlled invalid band",
            },
            facts(),
            "1",
            "rules_fallback",
          ),
        };
      return capability.propose(shop, reader);
    },
  };
  f = await adapterFixture(dir, { assistant, realCustomers });
  if (realCustomers)
    f.state.town.data.customer_pool.last_funded_epoch = f.state.town.data.epoch;
  const shop = structuredClone(
    capture.setup.find((s) => s.method === "set_assistant_permissions").effect
      .data.outcome.shop,
  );
  shop.owner = { kind: "player", account_id: "alice.testnet" };
  const ledger = structuredClone(capture.before.data);
  ledger.actor = structuredClone(shop.owner);
  f.state.assistantShop = shop;
  f.state.assistantLedger = ledger;
  f.state.assistantListing = {
    ...structuredClone(capture.steps[0].effect.data.outcome.listing),
    owner: structuredClone(shop.owner),
    unit_price: "10",
    revision: "1",
  };
  f.state.assistantPolicy = {
    shop_id: "4",
    revision: "2",
    mode: "auto_reprice",
    operator_account_id: identity.operatorId,
    allowed_items: ["health_potion"],
    min_price: "8",
    max_price: "15",
    expires_at_ns: (
      BigInt(f.state.town.block_timestamp_ns) + 120_000_000_000n
    ).toString(),
  };
  f.save();
  f.mode(mode);
  t.after(() => {
    assistantStore.close();
    closeAdapterFixturesAt(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get f() {
      return f;
    },
    facts,
    pipeline,
    assistantStore,
    dir,
    assistant,
    get proposals() {
      return proposals;
    },
    restart: async () => {
      f.save();
      f.close();
      f = await adapterFixture(dir, { assistant, realCustomers });
      return f;
    },
  };
}
async function untilAssistant(h) {
  for (let i = 0; i < 30; i++) {
    const r = await h.f.simulation.poll();
    if (h.f.store.assistantAudit("4").length) return r;
    assert.notEqual(r.kind, "blocked", JSON.stringify(r));
  }
  assert.fail("assistant opportunity not reached");
}
test("shared scheduler signs a bounded rules fallback repricing and reconciles it once across restart", async (t) => {
  const h = await harness(t, { realCustomers: true }),
    before = structuredClone(h.f.state.assistantLedger);
  await untilAssistant(h);
  assert.equal(h.f.state.assistantListing.unit_price, "11");
  assert.deepEqual(h.f.state.assistantLedger, before);
  const first = h.f.store.assistantAudit("4")[0];
  assert.equal(first.method, "assistant_reprice");
  await h.restart();
  for (let i = 0; i < 7; i++) await h.f.simulation.poll();
  assert.equal(h.f.store.assistantAudit("4").length, 1);
  assert.equal(h.proposals, 1);
  assert.equal(h.f.store.assistantAudit("4")[0].status, "confirmed");
  // Reconfiguring the reviewed shop set in a later slot cannot buy another
  // automatic opportunity in the same epoch.
  h.assistant.shopIds = ["5"];
  h.f.state.town.block_timestamp_ns = (
    BigInt(h.f.state.town.data.genesis_time_ns) + 95_000_000_000n
  ).toString();
  h.f.state.town.block_height = (
    BigInt(h.f.state.town.block_height) + 2n
  ).toString();
  await h.restart();
  for (let i = 0; i < 12; i++) await h.f.simulation.poll();
  assert.equal(h.proposals, 1);
  assert.equal(h.f.store.assistantAudit("5").length, 0);
});
test("out-of-band proposal records a durable no-op without an operator transaction", async (t) => {
  const h = await harness(t, { invalid: true });
  await untilAssistant(h);
  const row = h.f.store.assistantAudit("4")[0];
  assert.equal(row.method, null);
  assert.equal(row.job_status, "completed");
  assert.equal(h.f.state.assistantListing.unit_price, "10");
});
test("revocation during signing expires the original intent before broadcast", async (t) => {
  const h = await harness(t),
    adapter = h.f.adapters.operator,
    prepare = adapter.prepare.bind(adapter);
  adapter.prepare = async (call, beforeSign) =>
    prepare(call, async () => {
      if (call.method === "assistant_reprice") {
        h.f.state.assistantPolicy.mode = "off";
        h.f.state.assistantPolicy.revision = "3";
        h.f.state.assistantShop.policy_revision = "3";
      }
      await beforeSign();
    });
  await untilAssistant(h);
  assert.equal(h.f.state.assistantListing.unit_price, "10");
  assert.equal(h.f.store.assistantAudit("4")[0].job_status, "expired");
});
test("uncertain automatic broadcast retains its original hash and never resends after revocation", async (t) => {
  const h = await harness(t);
  const submit = h.f.adapters.operator.submit.bind(h.f.adapters.operator);
  h.f.adapters.operator.submit = async (p) => {
    if (p.call.method === "assistant_reprice") h.f.mode("timeout_before");
    return submit(p);
  };
  await untilAssistant(h);
  const row = h.f.store.assistantAudit("4")[0],
    hash = row.tx_hash;
  assert.equal(row.status, "unknown");
  h.f.state.assistantPolicy.mode = "off";
  await h.restart();
  const sends = h.f.stats.send;
  const result = await h.f.simulation.poll();
  assert.equal(result.kind, "blocked");
  assert.equal(h.f.stats.send, sends);
  assert.equal(h.f.store.assistantAudit("4")[0].tx_hash, hash);
});
for (const edit of [
  "shop",
  "revision",
  "operator",
  "price",
  "expiry",
  "listing",
  "quantity",
  "snapshot",
  "paused",
])
  test(`automatic admission rejects ${edit} changes before signing`, async (t) => {
    const h = await harness(t),
      f = h.f,
      proposal = bindProposal(
        {
          action: {
            type: "suggest_price",
            item_id: "health_potion",
            listing_id: "5",
            expected_listing_revision: "1",
            current_unit_price: "10",
            suggested_unit_price: "12",
          },
          reason: "controlled valid quote",
        },
        h.facts(),
        "1",
        "rules_fallback",
      );
    if (edit === "shop") proposal.shop_id = "5";
    if (edit === "revision") f.state.assistantPolicy.revision = "3";
    if (edit === "operator")
      f.state.assistantPolicy.operator_account_id = "attacker.testnet";
    if (edit === "price") proposal.action.suggested_unit_price = "99";
    if (edit === "expiry")
      f.state.assistantPolicy.expires_at_ns = f.state.town.block_timestamp_ns;
    if (edit === "listing") f.state.assistantListing.revision = "2";
    if (edit === "quantity") proposal.action.quantity = "2";
    if (edit === "snapshot") proposal.snapshot.market_revision = "99999";
    if (edit === "paused") f.state.town.data.paused = true;
    const reader = await f.adapters.operator.client.finalized();
    assert.equal(
      await resolveAssistantReprice(
        proposal,
        reader,
        {
          sequence: "1",
          config_version: "1",
          valid_until_ns: (
            BigInt(reader.block.timestampNs) + 60_000_000_000n
          ).toString(),
        },
        "4",
      ),
      null,
    );
    assert.equal(f.stats.sign, 0);
    assert.equal(f.stats.send, 0);
  });
test("automatic generation shares recommendation cache and limits without a separate provider allowance", async (t) => {
  const h = await harness(t),
    owner = "alice.testnet";
  const a = await h.pipeline.generateAutomatic(owner, "4", async () => true);
  const b = await h.pipeline.generateAutomatic(owner, "4", async () => true);
  assert(a.length > 0);
  assert.deepEqual(a, b);
  assert.equal(h.assistantStore.history(owner, "4").length, 1);
  h.f.state.assistantPolicy.mode = "off";
  await assert.rejects(
    h.pipeline.generateAutomatic(owner, "4", async () => true),
  );
});

test("automatic inference authority uses a new finalized block rather than a cached enabled policy", async (t) => {
  const h = await harness(t),
    reader = await h.f.adapters.operator.client.finalized();
  const enabled = structuredClone(h.f.state.assistantPolicy);
  const pinned = {
    ...reader,
    getAssistantPolicy: async () => ({ data: enabled }),
  };
  let invoked = false,
    refreshes = 0;
  const capability = automaticAssistant(
    ["4"],
    {
      generateAutomatic: async (_owner, _shop, authorized) => {
        h.f.state.assistantPolicy.mode = "off";
        h.f.state.assistantPolicy.revision = "3";
        await authorized();
        invoked = true;
        return [];
      },
    },
    {
      identity,
      finalized: async () => {
        refreshes++;
        return h.f.adapters.operator.client.finalized();
      },
    },
  );
  assert.equal(await capability.propose("4", pinned), null);
  assert.equal(invoked, false);
  assert.equal(refreshes, 1);
});
