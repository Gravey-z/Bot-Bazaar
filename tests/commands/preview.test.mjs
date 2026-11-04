import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPreviewServer } from "../../scripts/preview-server.mjs";

test("preview serves browser files from a C# path and blocks private paths and writes", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "bot-bazaar-preview-"),
  );
  const root = path.join(temporary, "C#", "browser");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "index.html"), "<h1>Bot Bazaar</h1>");
  await writeFile(path.join(root, "main.js"), "console.info('preview')");
  await writeFile(path.join(root, "config.json"), '{"networkId":"testnet"}');
  await writeFile(
    path.join(root, "portrait.png"),
    Buffer.from([137, 80, 78, 71]),
  );
  await writeFile(
    path.join(root, "portrait.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"/>',
  );
  await writeFile(
    path.join(temporary, "C#", "private.json"),
    "test-only-private-value",
  );
  const server = createPreviewServer(root);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Bot Bazaar/);
    const script = await fetch(`${base}/main.js`);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal(script.headers.get("cache-control"), "no-store");
    const config = await fetch(`${base}/config.json`);
    const portrait = await fetch(`${base}/portrait.svg`);
    const bitmap = await fetch(`${base}/portrait.png`);
    assert.equal(bitmap.headers.get("content-type"), "image/png");
    await bitmap.arrayBuffer();
    assert.equal(portrait.headers.get("content-type"), "image/svg+xml");
    assert.match(await portrait.text(), /<svg/);
    assert.deepEqual(await config.json(), { networkId: "testnet" });
    assert.equal((await fetch(base, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(base, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await fetch(`${base}/%invalid`)).status, 400);
    const escaped = await fetch(`${base}/..%2fprivate.json`);
    assert.equal(escaped.status, 403);
    assert.doesNotMatch(await escaped.text(), /test-only-private-value/);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(temporary, { recursive: true, force: true });
  }
});
