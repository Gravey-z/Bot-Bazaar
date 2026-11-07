import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const built = await build({
  entryPoints: ["apps/web/src/app/assistant-session.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "assistant",
  write: false,
});
const ctx = vm.createContext({
  URL,
  Date,
  AbortSignal,
  TextDecoder,
  Uint8Array,
});
vm.runInContext(built.outputFiles[0].text, ctx);
const { AssistantSession } = ctx.assistant;
const origin = "https://bazaar.example",
  deployment = "testnet:town:code",
  token = "a".repeat(43);
function challenge() {
  const c = {
    id: "c".repeat(43),
    accountId: "alice.testnet",
    shopId: "1",
    recipient: origin,
    nonce: "A".repeat(43) + "=",
    expiresAt: Date.now() + 120000,
  };
  return {
    ...c,
    message: JSON.stringify({
      purpose: "Bot Bazaar private assistant session; no spending approval",
      domain: origin,
      deployment,
      accountId: c.accountId,
      shopId: c.shopId,
      challengeId: c.id,
      expiresAt: c.expiresAt,
    }),
  };
}
function fixture() {
  let identity = { accountId: "alice.testnet", version: 1 },
    holdSign,
    holdScope,
    editChallenge = (c) => c,
    editScope = (s) => s;
  let expiresAt = Date.now() + 600000;
  const calls = [];
  let signs = 0;
  const session = new AssistantSession(
    origin,
    deployment,
    () => identity,
    async (accountId) => {
      signs++;
      if (holdSign) await holdSign;
      return { accountId, publicKey: "ed25519:test", signature: "signed" };
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/challenge"))
        return Response.json(editChallenge(challenge()));
      if (String(url).endsWith("/verify")) {
        expiresAt = Date.now() + 600000;
        return Response.json({
          token,
          accountId: "alice.testnet",
          shopId: "1",
          expiresAt,
        });
      }
      if (String(url).endsWith("/scope")) {
        if (holdScope) await holdScope;
        return Response.json(
          editScope({ accountId: "alice.testnet", shopId: "1", expiresAt }),
        );
      }
      return Response.json({ loggedOut: true });
    },
  );
  return {
    session,
    get signs() {
      return signs;
    },
    calls,
    switch: () => {
      identity = { accountId: "bob.testnet", version: 2 };
    },
    networkChange: () => {
      identity = { ...identity, version: 2 };
    },
    holdSign: (p) => {
      holdSign = p;
    },
    holdScope: (p) => {
      holdScope = p;
    },
    editChallenge: (fn) => {
      editChallenge = fn;
    },
    editScope: (fn) => {
      editScope = fn;
    },
  };
}
test("private browser session uses memory bearer, POST, no credentials/redirect/cache", async () => {
  const f = fixture();
  await f.session.authenticate("1");
  assert.equal((await f.session.scope("1")).accountId, "alice.testnet");
  const last = f.calls.at(-1);
  assert.equal(last.init.headers.Authorization, `Bearer ${token}`);
  for (const { init } of f.calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
  }
  f.session.invalidate();
  await assert.rejects(f.session.scope("1"));
  assert.ok(f.calls.some((c) => c.url.endsWith("/logout")));
});
for (const mode of ["account", "network"])
  test(`${mode} change invalidates old session before private fetch`, async () => {
    const f = fixture();
    await f.session.authenticate("1");
    if (mode === "account") f.switch();
    else f.networkChange();
    await assert.rejects(f.session.scope("1"));
    assert.equal(f.calls.filter((c) => c.url.endsWith("/scope")).length, 0);
  });
test("account switch while wallet signs cannot verify stale identity", async () => {
  const f = fixture();
  let resume;
  f.holdSign(
    new Promise((r) => {
      resume = r;
    }),
  );
  const pending = f.session.authenticate("1");
  await new Promise((r) => setTimeout(r, 10));
  f.switch();
  resume();
  await assert.rejects(pending);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/verify")).length, 0);
});
test("late private response after account switch is discarded", async () => {
  const f = fixture();
  await f.session.authenticate("1");
  let resume;
  f.holdScope(
    new Promise((r) => {
      resume = r;
    }),
  );
  const pending = f.session.scope("1");
  await new Promise((r) => setTimeout(r, 10));
  f.switch();
  resume();
  await assert.rejects(pending);
});
test("reload has no session and unsupported/rejected signing cannot create one", async () => {
  const f = fixture();
  await assert.rejects(f.session.scope("1"));
  const fail = new AssistantSession(
    origin,
    deployment,
    () => ({ accountId: "alice.testnet", version: 1 }),
    async () => {
      throw Error("Wallet unsupported");
    },
    async () => Response.json(challenge()),
  );
  await assert.rejects(fail.authenticate("1"));
  await assert.rejects(fail.scope("1"));
});
for (const field of [
  "deployment",
  "domain",
  "accountId",
  "shopId",
  "expiresAt",
  "challengeId",
])
  test(`challenge message with mismatched ${field} never opens wallet`, async () => {
    const f = fixture();
    f.editChallenge((c) => {
      const m = JSON.parse(c.message);
      m[field] = "wrong";
      return { ...c, message: JSON.stringify(m) };
    });
    await assert.rejects(f.session.authenticate("1"));
    assert.equal(f.signs, 0);
    assert.equal(
      f.calls.some((c) => c.url.endsWith("/verify")),
      false,
    );
  });
test("private scope response for another account is discarded and clears session", async () => {
  const f = fixture();
  await f.session.authenticate("1");
  f.editScope((s) => ({ ...s, accountId: "bob.testnet" }));
  await assert.rejects(f.session.scope("1"));
  f.editScope((s) => s);
  await assert.rejects(f.session.scope("1"));
});
test("late read from an old session cannot log out a replacement session", async () => {
  const f = fixture();
  await f.session.authenticate("1");
  let resume;
  f.holdScope(
    new Promise((r) => {
      resume = r;
    }),
  );
  const old = f.session.scope("1");
  await new Promise((r) => setTimeout(r, 10));
  await f.session.authenticate("1");
  resume();
  await assert.rejects(old);
  f.holdScope(null);
  assert.equal((await f.session.scope("1")).accountId, "alice.testnet");
});
test("installed wallet connector has message signing with 32-byte nonce and returned identity", () => {
  const types = readFileSync(
    "apps/web/node_modules/@hot-labs/near-connect/build/types/index.d.ts",
    "utf8",
  );
  const adapter = readFileSync(
    "apps/web/node_modules/@hot-labs/near-connect/build/SandboxedWallet/index.js",
    "utf8",
  );
  assert.match(types, /interface SignMessageParams[\s\S]*?nonce: Uint8Array/);
  assert.match(
    types,
    /interface SignedMessage[\s\S]*?accountId: string;[\s\S]*?publicKey: string;[\s\S]*?signature: string;/,
  );
  assert.match(adapter, /async signMessage\(params\)/);
});

test("recommendation polling and explicit generation use separate authenticated operations", async () => {
  const f = fixture();
  await f.session.authenticate("1");
  await f.session.recommendations("1");
  await f.session.recommendations("1");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/generate")).length, 0);
  await f.session.configure("1", "recommendations");
  await f.session.generate("1");
  const calls = f.calls.filter((c) =>
    /\/(recommendations|configuration|generate)$/.test(c.url),
  );
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every((c) => c.init.headers.Authorization === `Bearer ${token}`),
  );
  f.switch();
  await assert.rejects(f.session.recommendations("1"));
});
