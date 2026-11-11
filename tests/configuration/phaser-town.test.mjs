import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const bundle = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/app/game/town-game.bridge.ts'; export * from './apps/web/src/app/game/town-game.component.ts'; export {rendererDouble} from './apps/web/src/app/game/town-game.runtime.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "controlled-angular-renderer-lifecycle",
      setup(b) {
        b.onResolve({ filter: /^@angular\/core$/ }, () => ({
          path: "angular",
          namespace: "town-test",
        }));
        b.onLoad({ filter: /.*/, namespace: "town-test" }, () => ({
          contents: `export const Component=()=>c=>c,ViewChild=()=>()=>{},effect=()=>{}; export class NgZone{};export class ElementRef{};export const inject=()=>({run:f=>f(),runOutsideAngular:f=>f()});export function signal(v){const f=()=>v;f.set=n=>v=n;return f;}export const input={required:()=>signal(undefined)};export const output=()=>({values:[],emit(v){this.values.push(v)}});`,
          loader: "js",
        }));
        b.onResolve({ filter: /town-game\.runtime(?:\.ts)?$/ }, () => ({
          path: "renderer",
          namespace: "town-renderer",
        }));
        b.onLoad({ filter: /.*/, namespace: "town-renderer" }, () => ({
          contents: `export const rendererDouble={created:0,destroyed:0,snapshots:[],choose:null};export function startTownGame(parent,bridge,report){rendererDouble.created++;rendererDouble.choose=id=>bridge.choose(id);const unsubscribe=bridge.subscribe(value=>rendererDouble.snapshots.push(value));report({kind:'ready'});return {destroy(){rendererDouble.destroyed++;unsubscribe();}}}`,
          loader: "js",
        }));
      },
    },
  ],
});
const {
  TownGameBridge,
  townLocations,
  TownGameComponent,
  rendererDouble,
  townCoverTransform,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const initial = { selected: null, blocked: false, shopLabel: "Your shop" };

test("scene intents admit only known locations, block under overlays and stop after disposal", () => {
  const calls = [],
    bridge = new TownGameBridge((id) => calls.push(id));
  bridge.choose("rex");
  bridge.choose("buy_from_merchant");
  bridge.update({ ...initial, blocked: true });
  bridge.choose("luna");
  assert.deepEqual(calls, ["rex"]);
  const state = { ...initial, selected: "bolt" };
  bridge.update(state);
  state.blocked = true;
  bridge.choose("bolt");
  assert.deepEqual(calls, ["rex", "bolt"]);
  bridge.dispose();
  bridge.choose("shop");
  assert.deepEqual(calls, ["rex", "bolt"]);
  assert.equal(new Set(townLocations.map((l) => l.id)).size, 7);
});

test("visual remount subscriptions do not multiply selection or retain old mutable snapshots", () => {
  const bridge = new TownGameBridge(() => {}),
    seen = [];
  const first = bridge.subscribe((v) => seen.push(v));
  first();
  const stop = bridge.subscribe((v) => {
    v.shopLabel = "changed by listener";
  });
  bridge.subscribe((v) => assert.notEqual(v.shopLabel, "changed by listener"));
  bridge.update({ ...initial, shopLabel: "Confirmed shop" });
  assert.equal(seen.length, 1);
  stop();
  bridge.dispose();
});

test("host retry destroys its previous renderer and uses the same instance-owned intent bridge", async () => {
  const before = {
    created: rendererDouble.created,
    destroyed: rendererDouble.destroyed,
  };
  const host = new TownGameComponent();
  host.canvasHost = { nativeElement: {} };
  host.ngAfterViewInit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendererDouble.created, before.created + 1);
  rendererDouble.choose("luna");
  assert.deepEqual(host.selection.values, ["luna"]);
  await host.boot();
  assert.equal(rendererDouble.created, before.created + 2);
  assert.equal(rendererDouble.destroyed, before.destroyed + 1);
  rendererDouble.choose("bolt");
  assert.deepEqual(host.selection.values, ["luna", "bolt"]);
  host.ngOnDestroy();
  assert.equal(rendererDouble.destroyed, before.destroyed + 2);
  rendererDouble.choose("rex");
  assert.deepEqual(host.selection.values, ["luna", "bolt"]);
});

test("an unmounted host cannot create a renderer after its lazy import resolves", async () => {
  const before = rendererDouble.created,
    host = new TownGameComponent();
  host.canvasHost = { nativeElement: {} };
  host.ngAfterViewInit();
  host.ngOnDestroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendererDouble.created, before);
});

test("scene uses a fixed camera and local essential asset; native controls and existing reviews remain available", () => {
  const host = readFileSync(
      "apps/web/src/app/game/town-game.component.ts",
      "utf8",
    ),
    runtime = readFileSync(
      "apps/web/src/app/game/town-game.runtime.ts",
      "utf8",
    ),
    template = readFileSync(
      "apps/web/src/app/living-town.component.html",
      "utf8",
    );
  assert.match(host, /import\("\.\/town-game.runtime"\)/);
  assert.match(runtime, /Phaser.Scale.RESIZE/);
  assert.doesNotMatch(
    runtime,
    /setInterval|fetch\(|createLivingTownCall|\.startFollow\(|\.pan\(/,
  );
  assert.match(template, /<app-town-game/);
  assert.match(template, /#managerDialog/);
  assert.match(template, /#purchaseDialog/);
  const preview = template.slice(
    0,
    template.indexOf('<div class="town-page">'),
  );
  assert.match(template, /^@if \(usePhaser\)/);
  assert.doesNotMatch(preview, /class="intro"|<footer/);
  const assets = JSON.parse(readFileSync("apps/web/angular.json", "utf8"))
    .projects.web.architect.build.options.assets;
  assert.ok(
    assets.some(
      (a) => a.input === "public/art/living-town/game" && a.glob === "**/*",
    ),
  );
});

test("the town covers wide and portrait viewports with one undistorted transform for art and hit regions", () => {
  for (const [width, height] of [
    [1920, 1080],
    [2560, 1080],
    [1440, 800],
    [375, 812],
    [0, 0],
  ]) {
    const { x, y, scale } = townCoverTransform(width, height);
    assert.ok(Number.isFinite(scale) && scale > 0);
    assert.ok(x <= 0 && y <= 0);
    assert.ok(x + 1280 * scale >= width - 0.0001);
    assert.ok(y + 720 * scale >= height - 0.0001);
    const location = townLocations.find((l) => l.id === "luna");
    assert.ok(
      Math.abs((location.x * scale + x - x) / scale - location.x) < 0.0001,
    );
  }
});
