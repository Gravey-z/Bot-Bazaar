import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { KeyPairEd25519 } from "near-api-js";
import {
  AssistantAuth,
  assistantMessageHash,
} from "../dist/private/assistant/auth.js";
import { createAssistantServer } from "../dist/private/assistant/server.js";

test("logout while an authorization read is pending discards its response", async () => {
  let resume,
    wait = false;
  const blocked = new Promise((r) => {
    resume = r;
  });
  const key = KeyPairEd25519.fromRandom();
  const auth = new AssistantAuth("https://bazaar.example", "deployment", {
    authorize: async () => {
      if (wait) await blocked;
      return true;
    },
  });
  const c = auth.challenge("alice.testnet", "1");
  const s = await auth.verify({
    id: c.id,
    accountId: c.accountId,
    publicKey: key.getPublicKey().toString(),
    signature: Buffer.from(
      key.sign(assistantMessageHash(c)).signature,
    ).toString("base64"),
  });
  wait = true;
  const pending = auth.scope(s.token, "1");
  auth.revoke(s.token);
  resume();
  await assert.rejects(pending);
});
test("private routes reject missing origin, cookies, duplicate fields, oversized bodies and public aliases", async (t) => {
  const auth = new AssistantAuth("https://bazaar.example", "deployment", {
    authorize: async () => true,
  });
  const server = createAssistantServer(auth);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://bazaar.example",
        ...headers,
      },
      body,
    });
  const challenge = "/private/assistant/challenge";
  assert.equal(
    (await request(challenge, "{}", { Origin: "null" })).status,
    403,
  );
  const missing = await fetch(base + challenge, {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(missing.status, 403);
  assert.equal(
    (
      await request(
        challenge,
        '{"accountId":"bob.testnet","accountId":"alice.testnet","shopId":"1"}',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        challenge,
        JSON.stringify({ accountId: "a".repeat(5000), shopId: "1" }),
      )
    ).status,
    413,
  );
  assert.equal((await request("/api/shops/1/assistant", "{}")).status, 404);
  const options = await fetch(base + challenge, {
    method: "OPTIONS",
    headers: { Origin: "https://bazaar.example" },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-credentials"), null);
  assert.equal(
    options.headers.get("access-control-allow-origin"),
    "https://bazaar.example",
  );
});
