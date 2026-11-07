import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { canonicalLivingTownJson } from "@bot-bazaar/chain";
import { AssistantStore } from "../dist/private/assistant/store.js";
import { AssistantPipeline } from "../dist/private/assistant/pipeline.js";
import { createAssistantServer } from "../dist/private/assistant/server.js";
import { AssistantAuthError } from "../dist/private/assistant/auth.js";
const capture = JSON.parse(
    readFileSync(
      "tests/fixtures/chain/living-town-reprice-sandbox.json",
      "utf8",
    ),
  ),
  setup = capture.setup.find((s) => s.method === "set_assistant_permissions");
const identity = {
  deployment: setup.foundation.deployment,
  codeHash: setup.account.code_hash,
  ownerId: setup.foundation.data.owner_account_id,
  operatorId: setup.foundation.data.operator_account_id,
  controllers: setup.foundation.data.merchant_controllers,
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-pause-"));
  let store = new AssistantStore(dir, canonicalLivingTownJson(identity), true),
    unavailable = false,
    held = null;
  const f = {
    snapshot: {
      deployment: identity.deployment,
      block_hash: setup.block.header.hash,
      block_height: capture.before.block_height,
      block_timestamp_ns: capture.before.block_timestamp_ns,
      market_revision: capture.before.market_revision,
      event_sequence: capture.before.event_sequence,
    },
    shop: structuredClone(setup.effect.data.outcome.shop),
    ledger: structuredClone(capture.before.data),
    listings: [
      structuredClone(
        capture.setup.find((s) => s.method === "set_listing").effect.data
          .outcome.listing,
      ),
    ],
    fresh: true,
    historyComplete: true,
    paused: false,
    restockSpending: { tick: "0", day: "0" },
    productionCost: { health_potion: "6", iron_tool: null },
    demand: { health_potion: "2", iron_tool: "0" },
    assistantPolicy: structuredClone(setup.effect.data.outcome.policy),
  };
  const owner = f.shop.owner.account_id,
    source = {
      load: async () => {
        const gate = held;
        held = null;
        if (gate) {
          gate.notify();
          await gate.wait;
        }
        if (unavailable) throw Error("controlled unavailable");
        return structuredClone(f);
      },
    };
  let pipeline = new AssistantPipeline(store, source);
  pipeline.configure(owner, "4", "recommendations");
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    f,
    owner,
    get store() {
      return store;
    },
    get pipeline() {
      return pipeline;
    },
    failFacts(v) {
      unavailable = v;
    },
    holdOnce() {
      let release, notify;
      const wait = new Promise((r) => {
          release = r;
        }),
        ready = new Promise((r) => {
          notify = r;
        });
      held = { wait, notify };
      return { ready, release };
    },
    restart() {
      store.close();
      store = new AssistantStore(dir, canonicalLivingTownJson(identity));
      pipeline = new AssistantPipeline(store, source);
    },
    policy(mode, revision) {
      f.assistantPolicy = {
        ...f.assistantPolicy,
        mode,
        revision,
        operator_account_id:
          mode === "auto_reprice" ? identity.operatorId : null,
        allowed_items: mode === "off" ? [] : ["health_potion"],
        min_price: mode === "off" ? "1" : "8",
        max_price: mode === "off" ? "1" : "15",
        expires_at_ns:
          mode === "auto_reprice"
            ? (
                BigInt(f.snapshot.block_timestamp_ns) + 600_000_000_000n
              ).toString()
            : null,
      };
      f.shop.policy_revision = revision;
    },
  };
}
test("pause persists before unavailable facts, expires advice and never re-enables on configure or restart", async (t) => {
  const h = fixture(t);
  await h.pipeline.generate(h.owner, "4", async () => true);
  const proposal = h.store.history(h.owner, "4")[0].proposals[0];
  h.failFacts(true);
  await h.pipeline.pause(h.owner, "4");
  assert.equal(h.store.settings(h.owner, "4").paused, true);
  assert.equal(h.pipeline.dispatchAllowed("4"), false);
  assert.equal(h.store.history(h.owner, "4")[0].status, "expired");
  h.pipeline.configure(h.owner, "4", "recommendations");
  assert.equal(h.pipeline.dispatchAllowed("4"), false);
  h.restart();
  assert.equal(h.pipeline.dispatchAllowed("4"), false);
  await assert.rejects(h.pipeline.generate(h.owner, "4", async () => true));
  await assert.rejects(h.pipeline.review(h.owner, "4", proposal.proposal_id));
});
test("a failed durable stop write still blocks this process and reports no durable acknowledgment", async (t) => {
  const h = fixture(t),
    pause = h.store.pause.bind(h.store);
  await h.pipeline.generate(h.owner, "4", async () => true);
  const proposal = h.store.history(h.owner, "4")[0].proposals[0];
  h.store.pause = () => {
    throw Error("controlled storage unavailable");
  };
  await assert.rejects(h.pipeline.pause(h.owner, "4"));
  assert.equal(h.store.settings(h.owner, "4").paused, false);
  assert.equal(h.pipeline.dispatchAllowed("4"), false);
  await assert.rejects(h.pipeline.generate(h.owner, "4", async () => true));
  await assert.rejects(h.pipeline.review(h.owner, "4", proposal.proposal_id));
  h.store.pause = pause;
  await h.pipeline.pause(h.owner, "4");
  assert.equal(h.store.settings(h.owner, "4").paused, true);
});
test("automatic resume requires a new confirmed policy and explicit current private revision", async (t) => {
  const h = fixture(t);
  await h.pipeline.pause(h.owner, "4");
  const paused = h.store.settings(h.owner, "4");
  assert.equal(paused.pause_policy_revision, "2");
  await assert.rejects(
    h.pipeline.resume(h.owner, "4", paused.revision, "2", "auto_reprice"),
  );
  h.policy("auto_reprice", "3");
  await assert.rejects(
    h.pipeline.resume(h.owner, "4", paused.revision, "2", "auto_reprice"),
  );
  const resumed = await h.pipeline.resume(
    h.owner,
    "4",
    paused.revision,
    "3",
    "auto_reprice",
  );
  assert.equal(resumed.configuration.paused, false);
  assert.equal(h.pipeline.dispatchAllowed("4"), true);
  await assert.rejects(
    h.pipeline.resume(h.owner, "4", paused.revision, "3", "auto_reprice"),
  );
  await h.pipeline.pause(h.owner, "4");
  await assert.rejects(
    h.pipeline.resume(h.owner, "4", paused.revision, "3", "auto_reprice"),
  );
  assert.equal(h.pipeline.dispatchAllowed("4"), false);
});
test("recommendations-only resume waits for confirmed automatic revocation", async (t) => {
  const h = fixture(t);
  await h.pipeline.pause(h.owner, "4");
  const revision = h.store.settings(h.owner, "4").revision;
  await assert.rejects(
    h.pipeline.resume(h.owner, "4", revision, "2", "recommendations"),
  );
  h.policy("off", "3");
  const resumed = await h.pipeline.resume(
    h.owner,
    "4",
    revision,
    "3",
    "recommendations",
  );
  assert.equal(resumed.configuration.mode, "recommendations");
  assert.equal(resumed.configuration.paused, false);
  await assert.rejects(
    h.pipeline.generateAutomatic(h.owner, "4", async () => true),
  );
});
for (const kind of ["operator", "expiry", "paused", "owner", "revision"])
  test(`resume rejects ${kind} changes without clearing stop`, async (t) => {
    const h = fixture(t);
    await h.pipeline.pause(h.owner, "4");
    h.policy("auto_reprice", "3");
    const revision = h.store.settings(h.owner, "4").revision;
    if (kind === "operator")
      h.f.assistantPolicy.operator_account_id = "attacker.testnet";
    if (kind === "expiry")
      h.f.assistantPolicy.expires_at_ns = h.f.snapshot.block_timestamp_ns;
    if (kind === "paused") h.f.paused = true;
    if (kind === "owner") h.f.shop.owner.account_id = "attacker.testnet";
    await assert.rejects(
      h.pipeline.resume(
        h.owner,
        "4",
        kind === "revision" ? "1" : revision,
        "3",
        "auto_reprice",
      ),
    );
    assert.equal(h.pipeline.dispatchAllowed("4"), false);
  });
test("late baseline capture cannot alter a newer paused revision", async (t) => {
  const h = fixture(t),
    first = h.store.pause(h.owner, "4");
  h.pipeline.configure(h.owner, "4", "recommendations");
  h.store.capturePausedPolicy(h.owner, "4", first.revision, "999");
  assert.equal(h.store.settings(h.owner, "4").pause_policy_revision, null);
  await h.pipeline.read(h.owner, "4");
  assert.equal(h.store.settings(h.owner, "4").pause_policy_revision, "2");
});
test("a repeated Pause fences an older Resume that is still loading authority facts", async (t) => {
  const h = fixture(t);
  await h.pipeline.pause(h.owner, "4");
  h.policy("off", "3");
  const revision = h.store.settings(h.owner, "4").revision,
    gate = h.holdOnce();
  const resuming = h.pipeline.resume(
    h.owner,
    "4",
    revision,
    "3",
    "recommendations",
  );
  await gate.ready;
  await h.pipeline.pause(h.owner, "4");
  gate.release();
  await assert.rejects(resuming);
  assert.equal(h.pipeline.dispatchAllowed("4"), false);
  assert.equal(h.store.settings(h.owner, "4").pause_policy_revision, "2");
});
test("private pause/resume routes derive owner scope and reject replayed resume", async (t) => {
  const h = fixture(t),
    auth = {
      origin: "https://bazaar.example",
      scope: async (token, shop) => {
        if (token !== "a".repeat(43) || shop !== "4")
          throw new AssistantAuthError(401);
        return {
          accountId: h.owner,
          shopId: shop,
          expiresAt: Date.now() + 10000,
        };
      },
    };
  const server = createAssistantServer(auth, h.pipeline);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const request = (shop, action, body = {}, token = "a".repeat(43)) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/private/assistant/shops/${shop}/${action}`,
      {
        method: "POST",
        headers: {
          Origin: auth.origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
  assert.equal((await request("4", "pause", {}, "bad")).status, 401);
  assert.equal((await request("5", "pause")).status, 401);
  assert.equal(
    (await request("4", "pause", { accountId: "attacker.testnet" })).status,
    400,
  );
  assert.equal((await request("4", "pause")).status, 200);
  const revision = h.store.settings(h.owner, "4").revision;
  assert.equal((await request("4", "pause")).status, 200);
  assert.notEqual(h.store.settings(h.owner, "4").revision, revision);
  h.policy("off", "3");
  const body = {
    expectedRevision: h.store.settings(h.owner, "4").revision,
    policyRevision: "3",
    mode: "recommendations",
  };
  assert.equal((await request("4", "resume", body)).status, 200);
  assert.equal((await request("4", "resume", body)).status, 400);
});
