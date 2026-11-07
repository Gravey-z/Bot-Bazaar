import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const built = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/app/living-town-layout.ts'; export {LivingTownComponent} from './apps/web/src/app/living-town.component.ts'; export {initialTownState} from './apps/web/src/app/living-town-controller.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "layout-framework-double",
      setup(b) {
        b.onResolve({ filter: /^@angular\/(core|common)$/ }, (a) => ({
          path: a.path,
          namespace: "layout",
        }));
        b.onLoad({ filter: /.*/, namespace: "layout" }, () => ({
          contents: `export const Component=()=>c=>c, Injectable=()=>c=>c, ViewChild=()=>()=>{}; export class InjectionToken{}; export class ElementRef{}; export class DatePipe{}; export const untracked=f=>f(), computed=f=>f, effect=()=>{}, inject=()=>{throw Error('not a rendered browser')}; export function signal(v){const f=()=>v;f.set=n=>v=n;return f;} export const input=Object.assign(signal,{required:()=>signal(undefined)});`,
          loader: "js",
        }));
        b.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({
          path: "wallet",
          namespace: "layout-wallet",
        }));
        b.onLoad({ filter: /.*/, namespace: "layout-wallet" }, () => ({
          contents: "export class NearConnector{}",
          loader: "js",
        }));
      },
    },
  ],
});
const {
  shopManagerTabs,
  ownedTownObservation,
  townSnapshotFresh,
  townHud,
  townMode,
  nextTownAction,
  townMarketComparisons,
  LivingTownComponent,
  initialTownState,
} = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);
const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-upgrade-sandbox.json", "utf8"),
);
const now = 10000,
  owner = capture.baseline.shops[0].shop.data.owner.account_id;
function state() {
  const shop = structuredClone(capture.baseline.shops[0].shop.data),
    ledger = structuredClone(capture.baseline.shops[0].ledger.data);
  ledger.inventory.available.health_potion = "0";
  ledger.inventory.available.iron_tool = "0";
  return {
    ...structuredClone(initialTownState),
    phase: "ready",
    accountId: owner,
    accounts: [owner],
    transactionAvailable: true,
    observation: {
      accountId: owner,
      town: structuredClone(capture.baseline.town.data),
      shop,
      player: { shop_id: "4" },
      ledger,
      production: { items: [], historyGap: false },
      ownListings: [],
      listings: [],
      receivedAt: now,
      stale: false,
      ownershipKnown: true,
      source: "chain",
      ownershipUrl: null,
      chainTimestampNs: capture.baseline.town.block_timestamp_ns,
    },
  };
}
test("all six shop sections remain available, including a dedicated Listings tab", () => {
  assert.deepEqual(
    shopManagerTabs.map((t) => t.name),
    ["Overview", "Inventory", "Production", "Listings", "Assistant", "History"],
  );
});
test("preview, spectator, connected player and replay retain explicit independent modes", () => {
  assert.equal(townMode("unconfigured", null), "Local preview · no saved game");
  assert.equal(townMode("unavailable", null), "Town connection unavailable");
  assert.equal(townMode("ready", null), "NEAR Testnet · spectator");
  assert.equal(townMode("ready", owner), "NEAR Testnet · player");
  const preview = structuredClone(initialTownState);
  assert.equal(townHud(preview, now).available, null);
  assert.equal(nextTownAction(preview, "unconfigured", now).target, "manager");
  assert.match(
    readFileSync("apps/web/src/app/replay.component.html", "utf8"),
    /Historical replay · read-only · NEAR Testnet/,
  );
});
test("HUD distinguishes unknown from zero and never shows another account as the player's facade", () => {
  const s = state();
  s.observation.ledger.gold = {
    held: "0",
    available: "0",
    trade_reserved: "0",
    trade_inbound_reserved: "0",
  };
  assert.equal(townHud(s, now).available, "0");
  s.accountId = "other.testnet";
  assert.equal(ownedTownObservation(s), null);
  assert.equal(townHud(s, now).available, null);
  assert.equal(townHud(s, now).slots, null);
  assert.equal(nextTownAction(s, "ready", now).target, "refresh");
});
test("saved requests and stale/future snapshots take priority over economic suggestions", () => {
  const s = state();
  s.pending = { id: "saved", accountId: "old-owner.testnet", phase: "unknown" };
  const before = JSON.stringify(s);
  assert.match(nextTownAction(s, "ready", now).detail, /old-owner.testnet/);
  assert.equal(JSON.stringify(s), before);
  s.pending = null;
  assert.equal(townSnapshotFresh(s, now + 30001), false);
  assert.equal(nextTownAction(s, "ready", now + 30001).target, "refresh");
  s.observation.receivedAt = now + 1;
  assert.equal(nextTownAction(s, "ready", now).target, "refresh");
});
test("ready guidance uses finalized chain time and claims remain visible during pause", () => {
  const s = state(),
    job = structuredClone(capture.running.data.items[0]);
  s.observation.production.items = [job];
  s.observation.chainTimestampNs = String(BigInt(job.ready_at_ns) - 1n);
  assert.match(nextTownAction(s, "ready", now + 1000).title, /queue/);
  s.observation.chainTimestampNs = job.ready_at_ns;
  s.observation.town.paused = true;
  assert.match(nextTownAction(s, "ready", now).title, /Claim/);
});
test("finished stock routes to Listings while pause blocks new sale/craft guidance", () => {
  const s = state();
  s.observation.ledger.inventory.available.health_potion = "1";
  assert.equal(nextTownAction(s, "ready", now).tab, "listings");
  s.observation.town.paused = true;
  assert.equal(nextTownAction(s, "ready", now).tab, "production");
  assert.match(nextTownAction(s, "ready", now).title, /paused/);
});
test("market comparison distinguishes missing pages from empty offers and preserves freshness/scope", () => {
  const s = state();
  assert.equal(townMarketComparisons(s, now)[0].loaded, false);
  const listing = structuredClone(
    capture.steps.find((r) => r.method === "set_listing").effect.data.outcome
      .listing,
  );
  s.market = {
    items: [
      {
        ...listing,
        unit_price: "12",
        owner: { kind: "player", account_id: "other.testnet" },
        shop_id: "5",
      },
      {
        ...listing,
        unit_price: "1",
        owner: { kind: "merchant", merchant_id: "rex" },
      },
    ],
    nextCursor: "more",
    stale: false,
    receivedAt: now,
  };
  const row = townMarketComparisons(s, now)[0];
  assert.equal(row.lowest, "12");
  assert.equal(row.partial, true);
  assert.equal(row.ownKnown, true);
  assert.equal(row.own, null);
  assert.equal(townMarketComparisons(s, now + 30001)[0].fresh, false);
  s.market.items = [];
  assert.equal(townMarketComparisons(s, now)[0].loaded, true);
  assert.equal(townMarketComparisons(s, now)[0].lowest, null);
  s.observation.ownListings = undefined;
  assert.equal(townMarketComparisons(s, now)[0].ownKnown, false);
});
function dialogHarness(t) {
  const oldDocument = globalThis.document,
    oldElement = globalThis.HTMLElement;
  class Element {
    isConnected = true;
    focusCount = 0;
    focus() {
      this.focusCount++;
    }
  }
  const opener = new Element();
  globalThis.HTMLElement = Element;
  globalThis.document = { activeElement: opener };
  t.after(() => {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
    if (oldElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = oldElement;
  });
  const dialog = () => ({
    open: false,
    shows: 0,
    showModal() {
      if (this.open) throw Error("already open");
      this.open = true;
      this.shows++;
    },
    close() {
      this.open = false;
    },
  });
  const signal = (v) => {
    const f = () => v;
    f.set = (n) => (v = n);
    return f;
  };
  const component = Object.create(LivingTownComponent.prototype),
    manager = dialog(),
    purchase = dialog();
  component.managerDialog = { nativeElement: manager };
  component.purchaseDialog = { nativeElement: purchase };
  component.tab = signal("overview");
  component.productionReview = signal({ review: true });
  component.selected = signal(null);
  return { component, manager, purchase, opener };
}
test("native manager opens once, ignores late close events and clears local reviews on close", (t) => {
  const { component, manager, opener } = dialogHarness(t);
  component.openManager("production");
  component.openManager("listings");
  assert.equal(manager.shows, 1);
  assert.equal(component.tab(), "listings");
  component.managerClosed();
  assert.equal(component.tab(), "listings");
  component.closeManager();
  component.managerClosed();
  assert.equal(component.productionReview(), null);
  assert.equal(component.tab(), "overview");
  assert.equal(opener.focusCount, 1);
});
test("purchase close cannot steal focus from a newly opened manager or cancel a saved transaction", (t) => {
  const { component, manager, purchase, opener } = dialogHarness(t);
  let cancels = 0;
  component.screen = {
    controller: {
      discardPrepared() {
        cancels++;
      },
    },
  };
  component.purchaseOpener = opener;
  purchase.open = true;
  component.selected.set({ listing_id: "1" });
  component.closePurchase();
  component.openManager("inventory");
  component.purchaseClosed();
  assert.equal(component.selected(), null);
  assert.equal(manager.open, true);
  assert.equal(opener.focusCount, 0);
  assert.equal(cancels, 0);
});
test("wallet recovery remains inside the manager modal and purchase review stays a separate labelled dialog", () => {
  const html = readFileSync(
      "apps/web/src/app/living-town.component.html",
      "utf8",
    ),
    manager = html.indexOf("#managerDialog"),
    recovery = html.indexOf("ORIGINAL WALLET ATTEMPT");
  assert.ok(manager < recovery && recovery < html.lastIndexOf("</dialog>"));
  assert.match(html, /#purchaseDialog/);
  assert.match(html, /Close manager/);
  assert.match(html, /Only confirmed History proves a\s+sale/);
  assert.doesNotMatch(html, /innerHTML/);
});
