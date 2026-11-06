import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  createLivingTownCompletionCall,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
} from "../../packages/chain/dist/index.js";
import { LivingTownProjectionStore } from "../../apps/worker/dist/private/living-town/store.js";

const bundle = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/app/living-town-sales-ui.ts'; export * from './apps/web/src/app/living-town-controller.ts'; export * from './apps/web/src/app/living-town-transactions.ts'; export * from './apps/web/src/app/living-town-port.ts'; export * from './apps/web/src/app/living-town-sales.component.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "controlled-ui-framework",
      setup(b) {
        b.onResolve({ filter: /^@angular\/(core|common)$/ }, (a) => ({
          path: a.path,
          namespace: "ui",
        }));
        b.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({
          path: "wallet",
          namespace: "ui",
        }));
        b.onLoad({ filter: /.*/, namespace: "ui" }, (a) => ({
          contents:
            a.path === "wallet"
              ? 'export class NearConnector {constructor(){throw Error("Real wallet forbidden");}} export class SandboxWallet {}'
              : a.path.endsWith("common")
                ? "export class DatePipe {}"
                : "export const Component=()=>c=>c; export const computed=f=>f; export const untracked=f=>f(); export const effect=()=>{}; export const input=Object.assign(v=>()=>v,{required:()=>()=>undefined}); export function signal(v){const f=()=>v;f.set=n=>v=n;return f;}",
        }));
      },
    },
  ],
});
const {
  listingQuote,
  listingReviewMatches,
  productDemandText,
  LivingTownTransactions,
  LivingTownController,
  LivingTownSalesComponent,
  createLivingTownPort,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const p = JSON.parse(
    readFileSync(
      "tests/fixtures/chain/living-town-customers-sandbox.json",
      "utf8",
    ),
  ),
  listings = JSON.parse(
    readFileSync(
      "tests/fixtures/chain/living-town-listings-sandbox.json",
      "utf8",
    ),
  ),
  recipeCapture = JSON.parse(
    readFileSync(
      "tests/fixtures/chain/living-town-recipes-sandbox.json",
      "utf8",
    ),
  );
const clone = structuredClone,
  block = (b) => ({
    hash: b.header.hash,
    height: String(b.header.height),
    timestampNs: b.header.timestamp_nanosec,
  });
const identity = {
  deployment: p.steps[0].foundation.deployment,
  codeHash: p.steps[0].account.code_hash,
  ownerId: p.steps[0].foundation.data.owner_account_id,
  operatorId: p.steps[0].foundation.data.operator_account_id,
  controllers: p.steps[0].foundation.data.merchant_controllers,
};
function observation(source = p.before) {
  return {
    accountId: source.shops[0].shop.data.owner.account_id,
    town: clone(source.town.data),
    player: { shop_id: "4" },
    shop: clone(source.shops[0].shop.data),
    ledger: clone(source.shops[0].ledger.data),
    ownListings: clone(
      source.listings_pages[0].data.items.filter((l) => l.shop_id === "4"),
    ),
    listings: [],
    receivedAt: Date.now(),
    stale: false,
    ownershipKnown: true,
    source: "chain",
    ownershipUrl: null,
  };
}
async function harness() {
  let source = observation(),
    changed,
    historyReads = 0,
    reads = 0,
    historyResponse = null;
  const calls = [];
  const port = {
    accounts: async () => [{ accountId: source.accountId }],
    subscribe: (fn) => {
      changed = fn;
      return () => {};
    },
    restore: async () => null,
    pending: async () => null,
    last: async () => null,
    read: async () => {
      reads++;
      return clone(source);
    },
    history: async () => {
      historyReads++;
      return typeof historyResponse === "function"
        ? historyResponse()
        : clone(historyResponse);
    },
    prepare: async (account, method, args) => {
      calls.push({ account, method, args });
      return { id: "request", accountId: account, call: { method, args } };
    },
    submit: async () => {},
    reconcile: async () => null,
  };
  const controller = new LivingTownController(port, () => {});
  await controller.start();
  return {
    controller,
    calls,
    get reads() {
      return reads;
    },
    get historyReads() {
      return historyReads;
    },
    source: (o) => {
      source = o;
    },
    notify: () => changed(),
    history: (r) => {
      historyResponse = r;
    },
  };
}
function historyPage(row) {
  return {
    shopId: "4",
    items: row ? [row] : [],
    costs: {
      recorded_sales_revenue: "18",
      recorded_material_spending: "0",
      recorded_grants: "0",
      recorded_upgrade_spending: "0",
      recorded_cogs: null,
      recorded_profit: null,
      cost_history_complete: false,
      through_event_sequence: "1",
      gap_from_sequence: "2",
    },
    nextCursor: null,
    stale: false,
    receivedAt: Date.now(),
    historyComplete: false,
  };
}

test("listing review reuses its reserved stock, bounds quantity/price and preserves inactive listing identity", () => {
  const o = observation(),
    q = listingQuote(o, "health_potion", "3", "19");
  assert.equal(q.reason, "");
  assert.equal(q.review.revision, o.ownListings[0].revision);
  assert.equal(q.review.previousQuantity, "3");
  assert.match(
    productDemandText("health_potion", "19"),
    /no baseline customer/,
  );
  assert.match(productDemandText("iron_tool", "24"), /still depend/);
  for (const [quantity, price] of [
    ["4", "18"],
    ["0", "18"],
    ["1", "101"],
    ["01", "18"],
    ["1.5", "18"],
    [1, "18"],
  ])
    assert(listingQuote(o, "health_potion", quantity, price).reason);
  assert(listingQuote(o, "crystal", "1", "4").reason);
  const inactive = clone(o);
  inactive.ownListings[0].active = false;
  inactive.ownListings[0].remaining_quantity = "0";
  inactive.ledger.inventory.listing_reserved.health_potion = "0";
  inactive.ledger.inventory.available.health_potion = "3";
  assert.equal(
    listingQuote(inactive, "health_potion", "1", "18").review.revision,
    o.ownListings[0].revision,
  );
  assert(
    listingQuote({ ...o, ownListings: undefined }, "health_potion", "1", "18")
      .reason,
  );
});

test("reviewed terms reject sales, reprices, ledger/account changes and show exact user costs", () => {
  const o = observation(),
    r = listingQuote(o, "health_potion", "2", "18").review;
  for (const mutate of [
    (v) => (v.ownListings[0].revision = "999"),
    (v) => (v.ledger.revision = "999"),
    (v) => (v.accountId = "other.testnet"),
    (v) => (v.stale = true),
  ]) {
    const next = clone(o);
    mutate(next);
    assert.equal(listingReviewMatches(r, next), false);
  }
  assert.equal(listingReviewMatches(r, o), true);
  // Actual component logic under a minimal signal/framework double; real Angular templates also compile.
  const component = new LivingTownSalesComponent();
  component.state = () => ({ observation: o });
  component.explorer = () => "https://testnet.nearblocks.io";
  const row = {
    kind: "customer_sale",
    gold_amount: "18",
    cogs: null,
    profit: null,
    transaction_hash: p.steps[0].transaction_hash,
  };
  assert.equal(component.cost(row), "Unknown");
  assert.equal(component.amount(row), "18 revenue");
  assert.match(component.url(row), /testnet.nearblocks.io\/txns\//);
  assert.equal(
    component.url({ ...row, transaction_hash: "javascript:evil" }),
    null,
  );
  assert.equal(
    component.amount({ ...row, kind: "player_grant", gold_amount: "100" }),
    "100 grant (not revenue)",
  );
});

test("owner controller blocks stale or forged listing revisions and allows cancellation during pause", async () => {
  const f = await harness(),
    o = observation(),
    l = o.ownListings[0];
  await f.controller.act("set_listing", {
    shop_id: "4",
    item_id: "health_potion",
    quantity: "1",
    unit_price: "18",
    expected_listing_revision: "999",
  });
  assert.equal(f.calls.length, 0);
  await f.controller.act("cancel_listing", {
    listing_id: l.listing_id,
    expected_listing_revision: "999",
  });
  assert.equal(f.calls.length, 0);
  o.town.paused = true;
  f.source(o);
  await f.controller.refresh();
  await f.controller.act("cancel_listing", {
    listing_id: l.listing_id,
    expected_listing_revision: l.revision,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "cancel_listing");
  f.controller.stop();
});

test("fresh wallet admission rejects a changed listing before handoff while preserving the original unsigned request", async () => {
  const step = listings.steps[0],
    foundation = step.foundation,
    who = {
      deployment: foundation.deployment,
      codeHash: step.account.code_hash,
      ownerId: foundation.data.owner_account_id,
      operatorId: foundation.data.operator_account_id,
      controllers: foundation.data.merchant_controllers,
    };
  const body = JSON.parse(
    Buffer.from(step.receipt.status.SuccessValue, "base64").toString(),
  );
  let rows = [],
    sends = 0;
  let frame = step,
    paused = false;
  // Controlled pre-listing stock derived from the actual first listing effect.
  const ledger = clone(body.data.outcome.ledger);
  ledger.inventory.available.health_potion =
    ledger.inventory.held.health_potion;
  ledger.inventory.listing_reserved.health_potion = "0";
  const data = new Map();
  const client = {
    identity: who,
    finalized: async () => ({
      block: { ...block(frame.block), height: frame.reference_block_height },
      getTown: async () => ({
        ...listings.before_state.town,
        data: { ...listings.before_state.town.data, paused },
      }),
      getPlayer: async () => ({
        data: { shop_id: body.data.outcome.listing.shop_id },
      }),
      getShop: async () => listings.before_state.shops[0].shop,
      getShopInventory: async () => ({ data: ledger }),
      getCommand: async () => ({
        data: {
          kind: "not_applied",
          next_sequence: frame.args.command.sequence,
        },
      }),
      getListings: async () => ({ data: { items: rows, has_more: false } }),
    }),
    receipt: async (proof) =>
      verifyLivingTownReceipt(frame.receipt, proof, async () =>
        block(frame.block),
      ),
  };
  const journal = new LivingTownTransactions(
    client,
    {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    },
    async () => {
      sends++;
      return { transaction: { hash: frame.transaction_hash } };
    },
    async (_k, work) => work(),
    () => "00000000-0000-4000-8000-000000000001",
  );
  const attempt = await journal.prepare(
    step.signer_id,
    "set_listing",
    step.args,
  );
  rows = [clone(body.data.outcome.listing)];
  await assert.rejects(journal.submit(attempt.id));
  assert.equal(sends, 0);
  assert.equal((await journal.read()).phase, "prepared");
  assert.deepEqual((await journal.read()).call.args, step.args);
  await journal.discardPrepared(attempt.id);
  frame = listings.steps.find(
    (s) => s.method === "cancel_listing" && s.signer_id === step.signer_id,
  );
  assert(frame);
  rows = [
    {
      ...clone(body.data.outcome.listing),
      revision: frame.args.expected_listing_revision,
      active: true,
    },
  ];
  paused = true;
  const cancellation = await journal.prepare(
    step.signer_id,
    "cancel_listing",
    frame.args,
  );
  await journal.submit(cancellation.id);
  assert.equal((await journal.refresh()).kind, "succeeded");
  assert.equal(await journal.refresh(), null);
  assert.equal(sends, 1);
});

test("confirmed history refreshes finalized inventory once per receipt/log and never treats unknown cost as profit", async () => {
  const f = await harness(),
    sale = {
      event_sequence: "17",
      kind: "customer_sale",
      receipt_id:
        p.steps[0].receipt.transaction_outcome.outcome.status.SuccessReceiptId,
      log_index: "0",
    };
  f.history(historyPage(sale));
  const before = f.reads;
  await f.controller.loadHistory();
  assert.equal(f.reads, before + 1);
  assert.equal(f.controller.state.history.costs.recorded_profit, null);
  await f.controller.loadHistory();
  assert.equal(f.reads, before + 1);
  f.history(
    historyPage({
      ...sale,
      event_sequence: "18",
      receipt_id:
        p.steps[2].receipt.transaction_outcome.outcome.status.SuccessReceiptId,
    }),
  );
  await f.controller.loadHistory();
  assert.equal(f.reads, before + 2);
  f.controller.stop();
});

test("account changes discard late history and cursor failures retain explicit stale data", async () => {
  const f = await harness();
  let finish;
  f.history(() => new Promise((resolve) => (finish = resolve)));
  const pending = f.controller.loadHistory();
  await Promise.resolve();
  const changed = observation();
  changed.accountId = "other.testnet";
  changed.shop = {
    ...changed.shop,
    shop_id: "5",
    owner: { kind: "player", account_id: changed.accountId },
  };
  f.source(changed);
  await f.controller.syncAccounts();
  finish(historyPage());
  await pending;
  assert.equal(f.controller.state.history, null);
  f.history({ ...historyPage(), shopId: "5" });
  await f.controller.loadHistory();
  f.history(() => {
    throw Error("409 reset");
  });
  await f.controller.loadHistory(false); // no next cursor means no duplicate read
  await f.controller.loadHistory();
  assert.equal(f.controller.state.history.stale, true);
  assert.match(f.controller.state.salesMessage, /Refresh history/);
  f.controller.stop();
});

async function portFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-sales-ui-")),
    store = new LivingTownProjectionStore(dir, identity, true),
    source = p.after;
  t.after(() => {
    store.close();
    assert(dir.startsWith(join(tmpdir(), "bazaar-sales-ui-")));
    rmSync(dir, { recursive: true, force: true });
  });
  store.baseline({
    block: block(source.block),
    town: source.town,
    shops: source.shops.map((r) => ({ shop: r.shop, ledger: r.ledger })),
    listings: source.listings_pages,
    production: [
      ...["1", "2", "3"].map((shopId) => ({
        shopId,
        pages: [
          {
            ...source.town,
            data: {
              items: [],
              next_after_id: null,
              has_more: false,
              history_gap: false,
              pruned_through: "0",
            },
          },
        ],
      })),
      ...source.shops.map((r) => ({
        shopId: r.shop.data.shop_id,
        pages: [r.jobs],
      })),
    ],
  });
  for (const step of [...p.setup_steps, ...p.steps]) {
    const completion = step.method === "complete_production",
      proof = {
        transactionHash: step.transaction_hash,
        signerId: step.signer_id,
        deployment: identity.deployment,
        call: completion
          ? createLivingTownCompletionCall(step.args)
          : createLivingTownCall(step.method, step.args),
        referenceBlockHeight: step.reference_block_height,
      },
      status = await (
        completion ? verifyLivingTownCompletionReceipt : verifyLivingTownReceipt
      )(step.receipt, proof, async () => block(step.block));
    store.commit(
      (completion ? livingTownIndexedCompletion : livingTownIndexedReceipt)(
        proof,
        { status, response: step.receipt },
      ),
    );
  }
  const requests = [];
  let wrongShop = false,
    wrongCode = false;
  const profile = {
    identity,
    public: {
      rpcUrl: "https://test.rpc.fastnear.com",
      workerUrl: "https://worker.example.test",
      explorerUrl: "https://testnet.nearblocks.io",
      networkId: "testnet",
      contractId: identity.deployment.contract_id,
    },
  };
  const fetcher = async (url, init) => {
    const u = new URL(url);
    requests.push({ url: u, init });
    if (u.hostname === "worker.example.test") {
      let result =
        u.pathname === "/api/market/listings"
          ? store.listings(null, 20)
          : store.history("4", null, 20);
      result = clone(result);
      if (wrongShop && result.snapshot.data.shop_id)
        result.snapshot.data.shop_id = "5";
      if (wrongCode)
        result.checkpoint.verified_code_hash =
          "11111111111111111111111111111111";
      return new Response(JSON.stringify(result));
    }
    // Controlled finalized RPC facade around actual captures; no real wallet/RPC is used.
    const { method, params: a, id } = JSON.parse(init.body);
    let result;
    const snap = (data) => ({ ...clone(source.town), data });
    if (method === "status")
      result = { chain_id: "testnet", sync_info: { syncing: false } };
    else if (method === "EXPERIMENTAL_genesis_config")
      result = { chain_id: "testnet", genesis_height: 7 };
    else if (method === "block")
      result = {
        header:
          a.block_id === 7
            ? { hash: identity.deployment.genesis_hash, height: 7 }
            : source.block.header,
      };
    else if (method === "query") {
      if (a.request_type === "view_account")
        result = { code_hash: identity.codeHash };
      else {
        const args = JSON.parse(
          Buffer.from(a.args_base64, "base64").toString(),
        );
        let value;
        if (a.method_name === "get_town") value = source.town;
        else if (a.method_name === "get_foundation")
          value = snap(p.steps[0].foundation.data);
        else if (a.method_name === "get_player")
          value = snap({
            ...JSON.parse(
              Buffer.from(
                p.setup_steps[0].receipt.status.SuccessValue,
                "base64",
              ).toString(),
            ).data.outcome.player,
            shop_id: "4",
            ledger: source.shops[0].ledger.data,
          });
        else if (a.method_name === "get_shop") value = source.shops[0].shop;
        else if (a.method_name === "get_shop_inventory")
          value = source.shops[0].ledger;
        else if (a.method_name === "get_production_jobs")
          value = source.shops[0].jobs;
        else if (a.method_name === "get_recipes")
          value = snap(
            JSON.parse(Buffer.from(recipeCapture.recipes.result).toString())
              .data,
          );
        else if (a.method_name === "get_listings") {
          const items = source.listings_pages[0].data.items.filter(
            (l) =>
              (args.shop_id === null || l.shop_id === args.shop_id) &&
              (!args.active_only || l.active),
          );
          value = snap({
            items,
            next_after_id: items.at(-1)?.listing_id ?? null,
            has_more: false,
            history_gap: false,
            pruned_through: "0",
          });
        } else throw Error(a.method_name);
        result = { result: [...Buffer.from(JSON.stringify(value))] };
      }
      result.block_hash = source.block.header.hash;
      result.block_height = source.block.header.height;
    } else throw Error("Unexpected mutation RPC");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const port = createLivingTownPort(
    profile,
    { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetcher,
    async () => {
      throw Error("Wallet forbidden");
    },
  );
  return {
    port,
    requests,
    source,
    wrongShop: () => (wrongShop = true),
    wrongCode: () => (wrongCode = true),
  };
}

test("the actual port reads scoped confirmed costs and retained inactive listing identities without wallet access", async (t) => {
  const f = await portFixture(t),
    account = f.source.shops[0].shop.data.owner.account_id;
  const observed = await f.port.read(account);
  assert.equal(observed.ownListings.length, 1);
  assert.equal(observed.ownListings[0].active, false);
  assert.equal(observed.ownListings[0].listing_id, "5");
  const history = await f.port.history("4", null);
  assert.equal(history.costs.recorded_sales_revenue, "54");
  assert.equal(history.costs.recorded_profit, "24");
  assert(history.items.some((r) => r.kind === "customer_sale"));
  await f.port.market("opaque_cursor");
  const req = f.requests.find((r) => r.url.searchParams.has("after"));
  assert.equal(req.url.searchParams.get("after"), "opaque_cursor");
  assert.equal(req.init.credentials, "omit");
  assert.equal(req.init.cache, "no-store");
  f.wrongShop();
  await assert.rejects(f.port.history("4", null), /shop mismatch/);
});

test("sales view rejects mismatched deployment/code evidence and templates keep confirmations separate", async (t) => {
  const f = await portFixture(t);
  f.wrongCode();
  await assert.rejects(f.port.market(null), /identity mismatch/);
  const html = readFileSync(
    "apps/web/src/app/living-town-sales.component.html",
    "utf8",
  );
  assert.match(html, /track row.event_sequence/);
  assert.match(html, /Pending wallet requests/);
  assert.match(html, /Unknown/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /innerHTML|animation/);
});
