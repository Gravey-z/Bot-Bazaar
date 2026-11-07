import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { KeyPairEd25519, KeyPairSigner } from "near-api-js";
import {
  AssistantAuth,
  assistantFacts,
} from "../dist/private/assistant/auth.js";
import { createAssistantServer } from "../dist/private/assistant/server.js";

const origin = "https://bazaar.example";
function fixture() {
  const key = KeyPairEd25519.fromRandom(),
    signer = new KeyPairSigner(key);
  let time = 1000,
    allowed = true;
  const checks = [];
  const auth = new AssistantAuth(
    origin,
    "testnet:town:code",
    {
      async authorize(account, publicKey, shop) {
        checks.push({ account, publicKey, shop });
        return (
          allowed &&
          account === "alice.testnet" &&
          shop === "1" &&
          publicKey === key.getPublicKey().toString()
        );
      },
    },
    () => time,
  );
  const signed = async (c, changes = {}) => {
    const p = { ...c, ...changes };
    const s = await signer.signNep413Message(c.accountId, {
      message: p.message,
      recipient: p.recipient,
      nonce: Buffer.from(p.nonce, "base64"),
    });
    return {
      id: c.id,
      accountId: c.accountId,
      publicKey: s.publicKey.toString(),
      signature: Buffer.from(s.signature).toString("base64"),
    };
  };
  return {
    auth,
    signed,
    checks,
    advance: (n) => {
      time += n;
    },
    deny: () => {
      allowed = false;
    },
  };
}
test("SDK NEP-413 signature authenticates exact owner/shop; token replay after logout fails", async () => {
  const f = fixture(),
    c = f.auth.challenge("alice.testnet", "1");
  assert.equal(Buffer.from(c.nonce, "base64").length, 32);
  assert.match(c.message, /no spending approval/);
  const input = await f.signed(c),
    s = await f.auth.verify(input);
  assert.equal((await f.auth.scope(s.token, "1")).accountId, "alice.testnet");
  assert.equal(f.checks.length, 2);
  await assert.rejects(f.auth.verify(input));
  await assert.rejects(f.auth.scope(s.token, "2"));
  f.auth.revoke(s.token);
  await assert.rejects(f.auth.scope(s.token, "1"));
});
for (const field of ["message", "recipient", "nonce"])
  test(`reject altered signed ${field}`, async () => {
    const f = fixture(),
      c = f.auth.challenge("alice.testnet", "1");
    const changed =
      field === "nonce"
        ? Buffer.alloc(32, 2).toString("base64")
        : "https://evil.example";
    await assert.rejects(
      f.auth.verify(await f.signed(c, { [field]: changed })),
    );
  });
test("challenge expiry, wrong account, malformed signature and simultaneous nonce replay fail", async () => {
  for (const kind of ["expiry", "account", "signature"]) {
    const f = fixture(),
      c = f.auth.challenge("alice.testnet", "1"),
      input = await f.signed(c);
    if (kind === "expiry") f.advance(120000);
    if (kind === "account") input.accountId = "bob.testnet";
    if (kind === "signature") input.signature = "invalid";
    await assert.rejects(f.auth.verify(input));
  }
  const f = fixture(),
    input = await f.signed(f.auth.challenge("alice.testnet", "1"));
  const outcomes = await Promise.allSettled([
    f.auth.verify(input),
    f.auth.verify(input),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
});
test("key revocation/ownership change invalidates sessions and expiry requires fresh login", async () => {
  for (const mode of ["revoked", "expired", "restart"]) {
    const f = fixture(),
      s = await f.auth.verify(
        await f.signed(f.auth.challenge("alice.testnet", "1")),
      );
    if (mode === "revoked") f.deny();
    if (mode === "expired") f.advance(600000);
    const auth = mode === "restart" ? fixture().auth : f.auth;
    await assert.rejects(auth.scope(s.token, "1"));
  }
});
test("RPC failure consumes challenge and cannot authenticate", async () => {
  const f = fixture();
  f.auth = new AssistantAuth(origin, "town", {
    authorize: async () => {
      throw Error("offline");
    },
  });
  const input = await f.signed(f.auth.challenge("alice.testnet", "1"));
  await assert.rejects(f.auth.verify(input));
  await assert.rejects(f.auth.verify(input));
});
test("production facts reader requires FullAccess and current player owner at one finalized reader", async () => {
  for (const [permission, owner, expected] of [
    ["FullAccess", { kind: "player", account_id: "alice.testnet" }, true],
    [
      { FunctionCall: {} },
      { kind: "player", account_id: "alice.testnet" },
      false,
    ],
    ["FullAccess", { kind: "player", account_id: "bob.testnet" }, false],
    ["FullAccess", { kind: "merchant", merchant_id: "rex" }, false],
  ]) {
    let readers = 0;
    const facts = assistantFacts({
      finalized: async () => {
        readers++;
        return {
          getAccessKey: async () => ({ permission }),
          getShop: async () => ({ data: { owner } }),
        };
      },
    });
    assert.equal(await facts.authorize("alice.testnet", "key", "1"), expected);
    assert.equal(readers, 1);
  }
});
test("bounded challenge storage rejects saturation and releases expired challenges", () => {
  const f = fixture();
  for (let i = 0; i < 1024; i++) f.auth.challenge("alice.testnet", "1");
  assert.throws(() => f.auth.challenge("alice.testnet", "1"));
  f.advance(120001);
  assert.ok(f.auth.challenge("alice.testnet", "1"));
  assert.throws(() => new AssistantAuth("http://evil.example", "town", {}));
  assert.throws(() => f.auth.challenge("alice.near", "1"));
});
test("real private HTTP boundary: origin/CSRF, bearer scope, strict bodies, query identity and rate limit", async (t) => {
  const f = fixture(),
    server = createAssistantServer(f.auth);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/private/assistant/`;
  const call = (route, body = {}, extra = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  assert.equal(
    (await call("challenge", {}, { Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await call("challenge", {}, { Cookie: "session=fake" })).status,
    403,
  );
  assert.equal((await call("shops/1/scope")).status, 401);
  assert.equal((await call("challenge?accountId=alice.testnet")).status, 400);
  assert.equal(
    (
      await call("challenge", {
        accountId: "alice.testnet",
        shopId: "1",
        extra: true,
      })
    ).status,
    400,
  );
  const response = await call("challenge", {
    accountId: "alice.testnet",
    shopId: "1",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const input = await f.signed(await response.json());
  const r = await call("verify", input),
    s = await r.json();
  assert.equal(r.status, 200);
  assert.ok(s.token);
  assert.equal(
    (await call("shops/1/scope", {}, { Authorization: `Bearer ${s.token}` }))
      .status,
    200,
  );
  assert.equal(
    (await call("shops/2/scope", {}, { Authorization: `Bearer ${s.token}` }))
      .status,
    401,
  );
  await call("logout", {}, { Authorization: `Bearer ${s.token}` });
  assert.equal(
    (await call("shops/1/scope", {}, { Authorization: `Bearer ${s.token}` }))
      .status,
    401,
  );
  let limited = false;
  for (let i = 0; i < 24; i++)
    if ((await call("challenge", {})).status === 429) limited = true;
  assert.equal(limited, true);
});
