import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const built = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/app/living-town-layout.ts'; export * from './apps/web/src/app/living-town-tutorial.ts'; export {LivingTownComponent} from './apps/web/src/app/living-town.component.ts'; export {initialTownState} from './apps/web/src/app/living-town-controller.ts';",
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
        b.onResolve({ filter: /\/game\/town-game\.component$/ }, () => ({
          path: "town-game",
          namespace: "layout-game",
        }));
        b.onLoad({ filter: /.*/, namespace: "layout-game" }, () => ({
          contents: "export class TownGameComponent {}",
          loader: "js",
        }));
        b.onResolve({ filter: /^@angular\/(core|common)$/ }, (a) => ({
          path: a.path,
          namespace: "layout",
        }));
        b.onLoad({ filter: /.*/, namespace: "layout" }, () => ({
          contents: `export const Component=()=>c=>c, Injectable=()=>c=>c, ViewChild=()=>()=>{}; export class InjectionToken{}; export class ElementRef{}; export class DatePipe{}; export class NgZone{}; export const output=()=>({emit(){}}); export const untracked=f=>f(), computed=f=>f, effect=()=>{}, inject=()=>{throw Error('not a rendered browser')}; export function signal(v){const f=()=>v;f.set=n=>v=n;return f;} export const input=Object.assign(signal,{required:()=>signal(undefined)});`,
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
  firstLoopTutorial,
  TutorialGoalTracker,
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
      player: { account_id: owner, shop_id: "4" },
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

test("a registered player's gold is visible before shop creation and remains scoped to that account", () => {
  const s = state();
  s.observation.shop = null;
  s.observation.player.shop_id = null;
  s.observation.ledger.gold = {
    held: "100",
    available: "100",
    trade_reserved: "0",
    trade_inbound_reserved: "0",
  };
  assert.equal(townHud(s, now).available, "100");
  assert.equal(townHud(s, now).reserved, "0");
  assert.equal(townHud(s, now).slots, null);
  s.observation.player.account_id = "other.testnet";
  assert.equal(townHud(s, now).available, null);
  s.observation.player.account_id = owner;
  s.observation.ownershipKnown = false;
  assert.equal(townHud(s, now).available, null);
  s.observation.ownershipKnown = true;
  s.observation.player = null;
  assert.equal(townHud(s, now).available, null);
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
  component.helpVisible = signal(false);
  return { component, manager, purchase, opener };
}

test("notices dismiss after ten seconds and a newer notice gets its full lifetime", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const component = Object.create(LivingTownComponent.prototype);
  let text = "",
    shows = 0,
    hides = 0;
  component.notice = Object.assign(() => text, {
    set: (value) => (text = value),
  });
  component.noticeElement = {
    showPopover() {
      shows++;
    },
    hidePopover() {
      hides++;
    },
  };
  component.showNotice("First error");
  t.mock.timers.tick(9000);
  assert.equal(text, "First error");
  component.showNotice("Second error");
  t.mock.timers.tick(9999);
  assert.equal(text, "Second error");
  t.mock.timers.tick(1);
  assert.equal(text, "");
  assert.equal(shows, 2);
  assert.equal(hides, 1);
});

test("wallet prompt opens immediately and closes before the Meteor handoff", async (t) => {
  const { component, manager, opener } = dialogHarness(t);
  let visible = false,
    attempts = 0;
  const wallet = {
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
  component.walletDialog = { nativeElement: wallet };
  component.walletVisible = Object.assign(() => visible, {
    set: (v) => (visible = v),
  });
  component.state = () => ({ busy: false });
  component.notice = Object.assign(() => "", { set() {} });
  component.screen = {
    controller: {
      async connect() {
        assert.equal(wallet.open, false);
        attempts++;
      },
    },
  };
  globalThis.document.getElementById = () => opener;
  manager.open = true;
  component.openWalletDialog();
  assert.equal(manager.open, false);
  assert.equal(wallet.open, true);
  assert.equal(visible, true);
  assert.equal(attempts, 0);
  await component.connectWallet();
  assert.equal(attempts, 1);
  component.walletDialogClosed();
  assert.equal(visible, false);
  assert.equal(opener.focusCount, 1);
});
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
test("shop menu opens town panels without stacking dialogs and returns focus to the top shop button", (t) => {
  const { component, manager, opener } = dialogHarness(t);
  const scene = {
    open: false,
    showModal() {
      assert.equal(manager.open, false);
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
  globalThis.document.getElementById = (id) => {
    assert.equal(id, "town-shop-menu");
    return opener;
  };
  component.sceneDialog = { nativeElement: scene };
  let panel = null;
  component.scenePanel = Object.assign(() => panel, {
    set: (v) => (panel = v),
  });
  component.managerVisible = Object.assign(() => manager.open, { set() {} });
  for (const destination of ["rex", "luna", "bolt", "notice", "journal"]) {
    component.openManager();
    const focusBefore = opener.focusCount;
    component.openScenePanel(destination);
    assert.equal(panel, destination);
    assert.equal(scene.open, true);
    component.managerClosed();
    assert.equal(opener.focusCount, focusBefore);
    component.closeScenePanel();
    component.scenePanelClosed();
    assert.equal(panel, null);
    assert.equal(opener.focusCount, focusBefore + 1);
  }
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

function tutorialState() {
  const s = state();
  s.observation.shop.production_slots = "1";
  s.observation.player = {
    account_id: owner,
    shop_id: s.observation.shop.shop_id,
    grant_issued: true,
  };
  s.history = {
    shopId: s.observation.shop.shop_id,
    items: [],
    costs: { recorded_sales_revenue: "0", recorded_material_spending: "0" },
    historyComplete: true,
    nextCursor: null,
    receivedAt: now,
    stale: false,
  };
  return s;
}
const tutorial = (s) => firstLoopTutorial(s, "ready", now);
const milestone = (s, id) => tutorial(s).steps.find((step) => step.id === id);

test("tutorial separates registration and shop approval; wallet assertions never confirm milestones", () => {
  const s = tutorialState();
  s.observation.shop = null;
  s.observation.player.shop_id = null;
  s.pending = { phase: "confirmed", accountId: owner };
  s.lastAttempt = { phase: "confirmed", method: "create_shop" };
  assert.equal(milestone(s, "register").status, "confirmed");
  assert.equal(milestone(s, "shop").status, "not_confirmed");
  assert.equal(tutorial(s).completed, 1);
});
test("tutorial advances through receipts and retained listing state, not elapsed production time", () => {
  const s = tutorialState();
  assert.equal(tutorial(s).current.id, "buy");
  s.observation.production.items = [
    {
      shop_id: s.observation.shop.shop_id,
      owner: s.observation.shop.owner,
      status: "running",
      ready_at_ns: "999999999999999998",
    },
  ];
  assert.equal(tutorial(s).current.id, "craft");
  s.observation.chainTimestampNs = "999999999999999999";
  assert.equal(milestone(s, "craft").status, "not_confirmed");
  s.history.items.push({ kind: "production_completed" });
  assert.equal(tutorial(s).current.id, "list");
  s.observation.ownListings = [
    {
      shop_id: s.observation.shop.shop_id,
      owner: s.observation.shop.owner,
      active: false,
      remaining_quantity: "0",
    },
  ];
  assert.equal(tutorial(s).current.id, "sale");
  assert.equal(milestone(s, "sale").status, "not_confirmed");
  s.history.items.push({ kind: "customer_sale" });
  assert.equal(tutorial(s).current.id, "upgrade");
});
test("tutorial restores later prerequisites across paged history without grants becoming sales", () => {
  const s = tutorialState();
  s.history.stale = true;
  assert.equal(milestone(s, "buy").status, "unknown");
  s.history.stale = false;
  s.history.historyComplete = false;
  s.history.nextCursor = "older";
  s.history.items = [{ kind: "player_grant" }];
  assert.equal(milestone(s, "buy").status, "unknown");
  assert.equal(tutorial(s).action.tab, "history");
  assert.equal(milestone(s, "sale").status, "unknown");
  s.history.costs.recorded_sales_revenue = "20";
  assert.equal(tutorial(s).completed, 6);
  assert.equal(tutorial(s).current.id, "upgrade");
});
test("two-slot chain state restores the whole tutorial after reconnect with no archive", () => {
  const s = tutorialState();
  s.history = null;
  s.observation.production = undefined;
  s.observation.ownListings = undefined;
  s.observation.shop.production_slots = "2";
  assert.equal(tutorial(s).completed, 7);
  assert.equal(tutorial(s).current, null);
  assert.deepEqual(tutorial(structuredClone(s)), tutorial(s));
});
test("tutorial ignores foreign account, shop history, jobs and listings", () => {
  const s = tutorialState();
  s.history.shopId = "foreign";
  s.history.costs.recorded_sales_revenue = "999";
  s.observation.production.items = [
    {
      shop_id: "foreign",
      owner: s.observation.shop.owner,
      status: "completed",
    },
  ];
  s.observation.ownListings = [
    { shop_id: "foreign", owner: s.observation.shop.owner },
  ];
  assert.equal(tutorial(s).completed, 2);
  s.accountId = "other.testnet";
  assert.equal(tutorial(s).scope, null);
  assert.equal(tutorial(s).completed, 0);
  assert.equal(tutorial(s).action.target, "refresh");
});
test("saved unknown requests and stale observations keep recovery priority without mutation", () => {
  const s = tutorialState();
  s.pending = {
    id: "original",
    accountId: "original.testnet",
    phase: "unknown",
  };
  const before = JSON.stringify(s);
  assert.match(tutorial(s).action.detail, /original.testnet/);
  assert.equal(tutorial(s).blocked, true);
  assert.equal(JSON.stringify(s), before);
  s.pending = null;
  s.observation.stale = true;
  assert.equal(tutorial(s).fresh, false);
  assert.equal(tutorial(s).action.target, "refresh");
});
test("goal announcements baseline reconnects and deduplicate polls, stale state and pending outcomes", () => {
  const s = tutorialState(),
    tracker = new TutorialGoalTracker();
  assert.equal(tracker.observe(tutorial(s)), null);
  s.history.items.push({ kind: "material_purchase" });
  s.pending = { phase: "unknown" };
  assert.equal(tracker.observe(tutorial(s)), null);
  s.pending = null;
  s.observation.stale = true;
  assert.equal(tracker.observe(tutorial(s)), null);
  s.observation.stale = false;
  assert.match(tracker.observe(tutorial(s)), /Craft and claim/);
  assert.equal(tracker.observe(tutorial(s)), null);
  assert.equal(new TutorialGoalTracker().observe(tutorial(s)), null);
  s.accountId = "other.testnet";
  assert.equal(tracker.observe(tutorial(s)), null);
  s.accountId = owner;
  assert.equal(tracker.observe(tutorial(s)), null);
});
test("How to Play preserves reviews and restores focus; pending manager can take precedence", (t) => {
  const { component, manager, opener } = dialogHarness(t);
  const help = {
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
  component.helpDialog = { nativeElement: help };
  const review = component.productionReview();
  component.openHelp();
  component.openHelp();
  assert.equal(help.open, true);
  assert.equal(component.productionReview(), review);
  component.closeHelp();
  component.helpClosed();
  assert.equal(opener.focusCount, 1);
  component.openHelp();
  component.openManager("overview");
  manager.contains = () => false;
  component.helpClosed();
  assert.equal(help.open, false);
  assert.equal(manager.open, true);
  assert.equal(opener.focusCount, 1);
});
test("tutorial overlay supplies all recovery topics and a labelled native modal", () => {
  const html = readFileSync(
    "apps/web/src/app/living-town.component.html",
    "utf8",
  );
  assert.match(html, /#helpDialog[\s\S]*?aria-labelledby="how-to-play-title"/);
  for (const topic of [
    "Game gold and native NEAR",
    "Waiting, unsold goods and restocking",
    "Pending or unknown wallet outcome",
    "Returning to your shop",
    'aria-live="polite"',
  ])
    assert.ok(html.includes(topic), topic);
});
