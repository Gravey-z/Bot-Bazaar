import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createPreviewServer } from "../../scripts/preview-server.mjs";
import { securityHeaders } from "../../scripts/security-headers.mjs";

test("preview security headers apply to actual HTML and error responses without isolating wallet popups", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bazaar-proof-"));
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><p>Preview</p>",
  );
  const server = createPreviewServer(directory);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  for (const route of ["/", "/missing"]) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${route}`,
    );
    for (const [name, value] of Object.entries(securityHeaders))
      assert.equal(response.headers.get(name), value);
    assert.equal(response.headers.get("cross-origin-embedder-policy"), null);
    await response.text();
  }
  assert.equal(
    securityHeaders["Cross-Origin-Opener-Policy"],
    "same-origin-allow-popups",
  );
  assert.doesNotMatch(
    securityHeaders["Content-Security-Policy"],
    /(?:script-src|default-src|sandbox)/,
  );
});

test("Pages header artifact matches the tested preview policy and is included in the web build", async () => {
  const artifact = await readFile("apps/web/public/_headers", "utf8");
  assert.equal(artifact.split(/\r?\n/)[0], "/*");
  for (const [name, value] of Object.entries(securityHeaders))
    assert.ok(artifact.includes(`  ${name}: ${value}`));
  const build = JSON.parse(await readFile("apps/web/angular.json", "utf8"));
  assert.ok(
    build.projects.web.architect.build.options.assets.some(
      (asset) => asset.glob === "_headers" && asset.output === "/",
    ),
  );
});
