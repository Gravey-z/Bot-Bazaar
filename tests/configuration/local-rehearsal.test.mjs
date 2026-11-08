import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Script } from "node:vm";
import { RehearsalSession } from "../../scripts/local-rehearsal/session.mjs";
import { createRehearsalServer } from "../../scripts/local-rehearsal.mjs";

function runner() {
  const session = new RehearsalSession();
  let sequence = 0;
  const act = (action, args = {}) =>
    session.act({
      sessionId: session.id,
      id: `request-${++sequence}`,
      action,
      ...args,
    });
  return { session, act };
}
test("rehearsal completes four funded pairs and upgrade with separate simulated time and accounting", () => {
  const { session, act } = runner();
  act("register");
  act("claim", { name: "Practice" });
  for (let pair = 0; pair < 4; pair++) {
    for (const [item, inputs, seconds, price] of [
      ["health_potion", { herb: "2", crystal: "1" }, "120", "18"],
      ["iron_tool", { iron: "2", wood: "1" }, "180", "24"],
    ]) {
      for (const [material, quantity] of Object.entries(inputs))
        act("buy", { item: material, quantity });
      act("start", { item, quantity: "1" });
      const job = Object.keys(session.model.state.jobs).at(-1);
      assert.throws(() => act("claim-output", { job }), /not ready/);
      act("advance", { seconds });
      act("claim-output", { job });
      act("list", { item, quantity: "1", price });
      act("customers");
    }
  }
  const before = session.snapshot();
  assert.equal(before.gold, "180");
  assert.equal(before.simulatedSeconds, "1200");
  assert.equal(before.accounting.revenue, "168");
  assert.equal(before.accounting.cogs, "88");
  assert.equal(before.accounting.profit, "80");
  const after = act("upgrade");
  assert.equal(after.gold, "30");
  assert.equal(after.slots, 2);
  assert.equal(after.accounting.upgrade, "150");
  assert.equal(after.blockchain, false);
  assert.equal(after.wallet, false);
  assert.equal(after.ai, false);
  assert.equal(after.upgradeAt.simulatedSeconds, "1200");
  assert.ok(after.firstSale);
});
test("rehearsal grants and action IDs cannot double-spend and old session requests cannot reset new state", () => {
  const { session, act } = runner();
  const input = {
    sessionId: session.id,
    id: "registration",
    action: "register",
  };
  session.act(input);
  session.act(input);
  assert.equal(session.snapshot().gold, "100");
  assert.throws(
    () => session.act({ ...input, action: "claim", name: "Other" }),
    /different terms/,
  );
  assert.throws(() => act("register"), /already registered/);
  assert.throws(() => act("buy", { item: "herb", quantity: "2" }), /claim/);
  const old = session.id;
  act("reset");
  assert.notEqual(session.id, old);
  assert.throws(
    () => session.act({ ...input, action: "reset" }),
    /Session changed/,
  );
  assert.equal(session.snapshot().registered, false);
});
test("overpricing, cancellation, epoch quotas and customer funding stay explicit", () => {
  const { session, act } = runner();
  act("register");
  act("claim", { name: "Shop" });
  act("buy", { item: "herb", quantity: "6" });
  act("buy", { item: "crystal", quantity: "3" });
  act("start", { item: "health_potion", quantity: "3" });
  const job = Object.keys(session.model.state.jobs)[0];
  act("advance", { seconds: "360" });
  act("claim-output", { job });
  act("list", { item: "health_potion", quantity: "3", price: "100" });
  act("customers");
  assert.equal(session.snapshot().accounting.revenue, "0");
  act("list", { item: "health_potion", quantity: "3", price: "18" });
  act("customers");
  assert.equal(session.snapshot().accounting.revenue, "36");
  act("customers");
  assert.equal(session.snapshot().accounting.revenue, "36");
  act("cancel", { item: "health_potion" });
  assert.equal(session.model.available("health_potion"), 1n);
  assert.throws(() => act("claim-output", { job }), /already claimed/);
});
test("bounded clock advancement does not issue missed-epoch windfalls and failures roll back", () => {
  const { session, act } = runner();
  act("register");
  act("claim", { name: "Shop" });
  const before = session.snapshot();
  assert.throws(() => act("advance", { seconds: "9999" }), /whole number/);
  assert.deepEqual(session.snapshot().accounting, before.accounting);
  act("buy", { item: "herb", quantity: "12" });
  act("advance", { seconds: "3600" });
  assert.equal(session.model.state.supplied.herb, 8n);
  assert.equal(session.model.state.customer, 200n);
  const snapshot = session.snapshot();
  assert.throws(
    () => act("buy", { item: "constructor", quantity: "1" }),
    /Unknown material/,
  );
  assert.deepEqual(session.snapshot().accounting, snapshot.accounting);
});
test("loopback rehearsal serves a labelled page, preserves refresh state and rejects foreign mutation", async (t) => {
  const server = createRehearsalServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /no wallet, blockchain, native gas or AI\s+calls/);
  assert.doesNotThrow(
    () =>
      new Script(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]),
  );
  const initial = await (await fetch(`${origin}/api/state`)).json();
  const input = {
    sessionId: initial.sessionId,
    id: "register",
    action: "register",
  };
  const foreign = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://other.invalid",
    },
    body: JSON.stringify(input),
  });
  assert.equal(foreign.status, 403);
  const local = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(input),
  });
  assert.equal(local.status, 200);
  assert.equal((await local.json()).gold, "100");
  const restored = await (await fetch(`${origin}/api/state`)).json();
  assert.equal(restored.gold, "100");
  const invalid = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: "{",
  });
  assert.equal(invalid.status, 400);
});
