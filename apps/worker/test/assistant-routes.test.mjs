import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createAssistantServer } from "../dist/private/assistant/server.js";
import { AssistantAuthError } from "../dist/private/assistant/auth.js";

test("private recommendation routes derive owner scope, separate reads from generation and recheck logout", async (t) => {
  let allowed = true,
    generated = 0,
    reads = 0,
    configured = 0,
    late = false;
  const auth = {
    origin: "https://bazaar.example",
    scope: async (token, shop) => {
      if (!allowed || token !== "a".repeat(43) || shop !== "4")
        throw new AssistantAuthError(401);
      return {
        accountId: "alice.testnet",
        shopId: shop,
        expiresAt: Date.now() + 10000,
      };
    },
  };
  const pipeline = {
    read: async (account, shop) => {
      assert.equal(account, "alice.testnet");
      assert.equal(shop, "4");
      reads++;
      if (late) allowed = false;
      return { private: "owner only" };
    },
    configure: (account, shop, mode) => {
      assert.equal(account, "alice.testnet");
      assert.equal(shop, "4");
      configured++;
      return { mode };
    },
    generate: async (account, shop, authorize) => {
      await authorize();
      assert.equal(account, "alice.testnet");
      assert.equal(shop, "4");
      generated++;
      return { generation: "accepted" };
    },
  };
  const server = createAssistantServer(auth, pipeline);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/private/assistant/shops/`;
  const request = (suffix, body = {}, token = "a".repeat(43)) =>
    fetch(base + suffix, {
      method: "POST",
      headers: {
        Origin: auth.origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await request("4/recommendations", {}, "bad")).status, 401);
  assert.equal((await request("5/recommendations")).status, 401);
  assert.equal(
    (await request("4/generate", { accountId: "bob.testnet" })).status,
    400,
  );
  for (let i = 0; i < 3; i++)
    assert.equal((await request("4/recommendations")).status, 200);
  assert.equal(reads, 3);
  assert.equal(generated, 0);
  assert.equal(
    (await request("4/configuration", { mode: "auto_reprice" })).status,
    400,
  );
  assert.equal(
    (await request("4/configuration", { mode: "recommendations" })).status,
    200,
  );
  assert.equal(configured, 1);
  assert.equal((await request("4/generate")).status, 200);
  assert.equal(generated, 1);
  late = true;
  const rejected = await request("4/recommendations");
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.text()).includes("owner only"), false);
});
