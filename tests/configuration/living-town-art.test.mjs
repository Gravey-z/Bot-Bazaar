import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { build } from "esbuild";
import { createPreviewServer } from "../../scripts/preview-server.mjs";
const built = await build({
  stdin: {
    contents: "export * from './apps/web/src/app/living-town-art.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { townArt, townArtFallback, townArtwork } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);
test("fixed artwork paths cannot turn item names into external URLs or traversal", () => {
  for (const kind of [
    "../worker.env",
    "https://attacker.example/a.svg",
    "javascript:alert(1)",
    "__proto__",
    "constructor",
    "",
  ]) {
    assert.equal(townArt(kind), null);
    assert.equal(townArtFallback(kind), "◇");
  }
  assert.equal(townArt("crystal"), null);
  assert.equal(townArtFallback("crystal"), "◆");
  assert.equal(
    townArt("health_potion").src,
    "art/living-town/health-potion.svg",
  );
});
test("all eight retained SVG originals are static local pixel artwork with scoped licensing", () => {
  assert.equal(Object.keys(townArtwork).length, 8);
  for (const kind of Object.keys(townArtwork)) {
    const art = townArt(kind),
      svg = readFileSync(`apps/web/public/${art.src}`, "utf8");
    assert.match(svg, /SPDX-License-Identifier: 0BSD/);
    assert.match(svg, /shape-rendering="crispEdges"/);
    assert.match(svg, new RegExp(`viewBox="0 0 ${art.width} ${art.height}"`));
    assert.doesNotMatch(
      svg,
      /<(?:script|foreignObject|image|animate|set|use)\b|\bhref\s*=|\bon\w+\s*=|url\(/i,
    );
    assert.ok(art.fallback.length > 0);
  }
  assert.match(
    readFileSync("apps/web/public/art/living-town/LICENSE.txt", "utf8"),
    /does not relicense pre-existing/,
  );
  const config = JSON.parse(readFileSync("apps/web/angular.json", "utf8"));
  const assets = config.projects.web.architect.build.options.assets;
  assert.ok(
    assets.some(
      (a) =>
        a.glob === "*.svg" &&
        a.input === "public/art/living-town" &&
        a.output === "/art/living-town/",
    ),
  );
  assert.ok(
    assets.some(
      (a) => a.glob === "LICENSE.txt" && a.input === "public/art/living-town",
    ),
  );
});
test("static server delivers SVGs with the image MIME type and missing art stays a real 404", async (t) => {
  const server = createPreviewServer("apps/web/public");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  for (const kind of ["storefront", "health_potion", "iron_tool"]) {
    const response = await fetch(new URL(townArt(kind).src, base));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
    assert.match(await response.text(), /<svg/);
  }
  assert.equal((await fetch(`${base}art/living-town/missing.svg`)).status, 404);
  assert.equal((await fetch(`${base}art/living-town/LICENSE.txt`)).status, 200);
});
test("decorative art retains visible fallback rendering, adjacent text and reduced-motion behavior", () => {
  const component = readFileSync(
      "apps/web/src/app/town-art.component.ts",
      "utf8",
    ),
    template = readFileSync("apps/web/src/app/town-art.component.html", "utf8"),
    css = readFileSync("apps/web/src/app/town-art.component.css", "utf8");
  assert.match(component, /"aria-hidden": "true"/);
  assert.match(template, /alt=""/);
  assert.match(template, /\(error\)="failedFor.set\(art.id\)"/);
  assert.match(template, /track art.id/);
  assert.match(template, /art-fallback/);
  assert.match(css, /image-rendering: pixelated/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  const town = readFileSync(
    "apps/web/src/app/living-town.component.html",
    "utf8",
  );
  assert.match(town, /kind="customer"[\s\S]*?Town customer\s+budget/);
  assert.match(town, /upgrade.production_slots === "2"[\s\S]*?kind="upgrade"/);
  assert.match(town, /jobCountdown\(job\)/);
  assert.match(town, /itemName\(card.recipe.output_item\)/);
  assert.doesNotMatch(template, /innerHTML|setInterval|fetch\(/);
});
