import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { build } from "esbuild";
import {
  createLivingTownCall,
  livingTownCommandDigest,
  verifyLivingTownReceipt,
  parseLivingTownWebProfile,
} from "../../packages/chain/dist/index.js";

const f = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
const body = (s) =>
  JSON.parse(Buffer.from(s.receipt.status.SuccessValue, "base64").toString());
const foundation = JSON.parse(
  Buffer.from(f.steps[0].foundation.result).toString(),
);
const identity = {
  deployment: foundation.deployment,
  codeHash: f.steps[0].account.code_hash,
  ownerId: f.contract_id,
  operatorId: "operator.testnet",
  controllers: {
    rex: "rex.testnet",
    luna: "luna.testnet",
    bolt: "bolt.testnet",
  },
};
const block = (s) => ({
  hash: s.block.header.hash,
  height: String(s.block.header.height),
  timestampNs: s.block.header.timestamp_nanosec,
});
const verified = await Promise.all(
  f.steps.map((s) =>
    verifyLivingTownReceipt(
      s.receipt,
      {
        transactionHash: s.transaction_hash,
        signerId: f.player_id,
        deployment: identity.deployment,
        call: createLivingTownCall(s.method, s.args),
        referenceBlockHeight: String(s.reference_block_height),
      },
      async () => block(s),
    ),
  ),
);
const result = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/app/living-town-controller.ts'; export * from './apps/web/src/app/living-town-port.ts'; export * from './apps/web/src/app/living-town-profile.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "ui-ports",
      setup(b) {
        b.onResolve({ filter: /^@angular\/core$/ }, () => ({
          path: "angular",
          namespace: "ports",
        }));
        b.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({
          path: "wallet",
          namespace: "ports",
        }));
        b.onLoad({ filter: /.*/, namespace: "ports" }, (args) => ({
          contents:
            args.path === "angular"
              ? "export class InjectionToken {constructor(name){this.name=name;}}"
              : 'export class NearConnector {constructor(){throw Error("Unexpected real wallet load");}} export class SandboxWallet {}',
        }));
      },
    },
  ],
});
const {
  LivingTownController,
  inventoryRows,
  describeTownAttempt,
  loadLivingTownSetup,
  createLivingTownPort,
  townTransactionUrl,
} = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
);
const copy = (v) => structuredClone(v);
const id = "00000000-0000-4000-8000-000000000001";
function harness() {
  let stage = 0,
    accounts = [],
    pending = null,
    forced = null,
    reads = 0,
    preparing = null,
    subscriber;
  const calls = { prepared: [], sent: [], discarded: 0 };
  let clock = Date.now();
  const observation = (account) => {
    const player = stage ? copy(body(f.steps[0]).data.outcome.player) : null;
    const shop =
      stage >= 2
        ? copy(body(f.steps[stage >= 3 ? 2 : 1]).data.outcome.shop)
        : null;
    const ledger =
      stage >= 4
        ? copy(body(f.steps[3]).data.outcome.buyer)
        : (player?.ledger ?? null);
    if (player) {
      player.shop_id = shop?.shop_id ?? null;
      player.ledger = ledger;
    }
    return {
      accountId: account,
      town: copy(
        stage >= 4 ? f.final_views.get_town.data : f.initial_town.data,
      ),
      player: account === f.player_id ? player : null,
      shop: account === f.player_id ? shop : null,
      ledger: account === f.player_id ? ledger : null,
      listings: [copy(body(f.steps[3]).data.outcome.listing)],
      receivedAt: clock,
      stale: false,
      ownershipKnown: !!account,
      source: "chain",
      ownershipUrl:
        shop && account === f.player_id
          ? townTransactionUrl(
              "https://testnet.nearblocks.io",
              f.steps[1].transaction_hash,
            )
          : null,
    };
  };
  const port = {
    accounts: async () => accounts.map((accountId) => ({ accountId })),
    connect: async () => {
      accounts = [f.player_id];
      return [{ accountId: f.player_id }];
    },
    disconnect: async () => {
      accounts = [];
    },
    subscribe: (cb) => {
      subscriber = cb;
      return () => {
        subscriber = null;
      };
    },
    read: async (account) => {
      reads++;
      return observation(account);
    },
    restore: async () => pending,
    pending: async () => pending,
    prepare: async (account, method, args) => {
      calls.prepared.push({ account, method, args: copy(args) });
      if (preparing) await preparing;
      const step = f.steps[stage];
      pending = {
        id,
        accountId: account,
        call: createLivingTownCall(method, {
          ...args,
          command: step.args.command,
        }),
        digest: await livingTownCommandDigest(
          identity.deployment,
          account,
          createLivingTownCall(method, { ...args, command: step.args.command }),
        ),
        referenceBlockHeight: String(step.reference_block_height),
        phase: "prepared",
        transactionHash: null,
        hashSource: null,
      };
      return pending;
    },
    submit: async (attempt) => {
      assert.equal(attempt, pending.id);
      calls.sent.push(pending.call.method);
      pending = {
        ...pending,
        phase: "submitted",
        transactionHash: f.steps[stage].transaction_hash,
        hashSource: "wallet",
      };
    },
    reconcile: async () => {
      if (!pending) return null;
      const r = forced ?? verified[stage];
      if (r.kind === "succeeded") {
        stage++;
        pending = null;
      } else if (r.kind === "failed") pending = null;
      return r;
    },
    recoverHash: async () => {},
    discardPrepared: async () => {
      calls.discarded++;
      pending = null;
    },
  };
  let stateObserver;
  const c = new LivingTownController(
    port,
    (state) => stateObserver?.(state),
    () => clock,
  );
  return {
    c,
    port,
    calls,
    get reads() {
      return reads;
    },
    clock: (v) => {
      clock = v;
    },
    advanceClock: (n) => {
      clock += n;
    },
    force: (v) => {
      forced = v;
    },
    setAccounts: (v) => {
      accounts = v;
    },
    setStage: (v) => {
      stage = v;
    },
    setPending: (v) => {
      pending = v;
    },
    waitPrepare: (p) => {
      preparing = p;
    },
    notify: () => subscriber?.(),
    onState: (fn) => {
      stateObserver = fn;
    },
  };
}

test("unconfigured storefront remains a spectator preview with no balances, ownership or wallet calls", async () => {
  const c = new LivingTownController(null, () => {});
  await c.start();
  await c.connect();
  await c.act("register_player", {});
  assert.equal(c.state.phase, "preview");
  assert.equal(c.state.observation, null);
  assert.equal(c.state.ownershipUrl, null);
  assert.equal(c.canTransact, false);
  c.stop();
});

test("onboarding requires separate explicit registration and shop approvals before confirmed ownership", async () => {
  const h = harness();
  await h.c.start();
  assert.equal(h.c.state.accountId, null);
  assert.equal(h.calls.sent.length, 0);
  await h.c.connect();
  await h.c.act("create_shop", { name: "Adapter Shop" });
  assert.equal(h.calls.sent.length, 0);
  await h.c.act("register_player", {});
  assert.deepEqual(h.calls.sent, ["register_player"]);
  assert.equal(h.c.state.observation.player.ledger.gold.held, "100");
  assert.equal(h.c.state.observation.shop, null);
  await h.c.act("create_shop", { name: "Adapter Shop" });
  assert.deepEqual(h.calls.sent, ["register_player", "create_shop"]);
  assert.equal(h.c.state.observation.shop.shop_id, "4");
  assert.equal(h.c.state.observation.ledger.gold.held, "100");
  assert.match(h.c.state.ownershipUrl, /\/txns\//);
  await h.c.act("create_shop", { name: "Another Shop" });
  assert.equal(h.calls.sent.length, 2);
  h.c.stop();
});

test("pending or rejected creation produces no phantom shop and refresh never signs a replacement", async () => {
  const h = harness();
  h.setStage(1);
  h.setAccounts([f.player_id]);
  h.force({ kind: "unknown" });
  await h.c.start();
  await h.c.act("create_shop", { name: "Adapter Shop" });
  assert.equal(h.c.state.observation.shop, null);
  assert.equal(h.c.state.ownershipUrl, null);
  assert.equal(h.calls.sent.length, 1);
  await h.c.refresh();
  await h.c.checkTransaction();
  await h.c.act("create_shop", { name: "Adapter Shop" });
  assert.equal(h.calls.sent.length, 1);
  assert(h.c.state.pending);
  h.force({ kind: "failed", code: "EXECUTION_FAILED" });
  await h.c.checkTransaction();
  assert.equal(h.c.state.observation.shop, null);
  assert.equal(h.c.state.observation.ledger.gold.held, "100");
  h.c.stop();
});

test("reviewed rename and purchase terms reach the action adapter unchanged and update confirmed inventory", async () => {
  const h = harness();
  h.setStage(2);
  h.setAccounts([f.player_id]);
  await h.c.start();
  await h.c.act("rename_shop", {
    shop_id: "4",
    expected_shop_revision: "1",
    name: "Verified Shop",
  });
  assert.equal(h.c.state.observation.shop.name, "Verified Shop");
  const args = {
    merchant_id: "rex",
    item_id: "crystal",
    quantity: "1",
    expected_listing_revision: "1",
    max_total_price: "4",
  };
  await h.c.act("buy_from_merchant", args);
  assert.deepEqual(h.calls.prepared.at(-1).args, args);
  assert.equal(h.c.state.observation.ledger.gold.held, "96");
  assert.equal(h.c.state.observation.ledger.inventory.held.crystal, "1");
  h.c.stop();
});

test("stale, paused, unavailable and expired views block wallet actions without inventing new balances", async () => {
  const h = harness();
  h.setStage(1);
  h.setAccounts([f.player_id]);
  await h.c.start();
  h.advanceClock(31000);
  await h.c.act("create_shop", { name: "Adapter Shop" });
  assert.equal(h.calls.sent.length, 0);
  const original = h.port.read;
  h.port.read = async (account) => ({
    ...(await original(account)),
    stale: true,
  });
  await h.c.refresh();
  await h.c.act("create_shop", { name: "Adapter Shop" });
  assert.equal(h.calls.sent.length, 0);
  h.port.read = async (account) => {
    const value = await original(account);
    value.town.paused = true;
    return value;
  };
  await h.c.refresh();
  await h.c.act("create_shop", { name: "Adapter Shop" });
  assert.equal(h.calls.sent.length, 0);
  h.port.read = async () => {
    throw Error("unavailable");
  };
  await h.c.refresh();
  assert.equal(h.c.state.phase, "unavailable");
  assert.equal(h.c.state.observation.ledger.gold.held, "100");
  assert.equal(h.c.state.observation.stale, true);
  assert.equal(h.c.canTransact, false);
  h.c.stop();
});

test("an account switch during preparation discards the unsigned request before any wallet handoff", async () => {
  const h = harness();
  h.setStage(1);
  h.setAccounts([f.player_id]);
  await h.c.start();
  let resolve;
  h.waitPrepare(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const action = h.c.act("create_shop", { name: "Adapter Shop" });
  h.setAccounts(["other.testnet"]);
  await h.c.syncAccounts();
  assert.equal(h.c.state.observation, null);
  assert.equal(h.c.state.ownershipUrl, null);
  resolve();
  await action;
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.calls.discarded, 1);
  assert.equal(h.c.state.accountId, "other.testnet");
  assert.equal(h.c.state.observation.shop, null);
  h.c.stop();
});

test("prepared requests restore without signing and require explicit submit or explicit discard", async () => {
  const h = harness();
  h.setStage(1);
  h.setAccounts([f.player_id]);
  await h.port.prepare(f.player_id, "create_shop", { name: "Adapter Shop" });
  await h.c.start();
  assert.equal(h.calls.sent.length, 0);
  await h.c.refresh();
  assert.equal(h.calls.sent.length, 0);
  await h.c.resumePrepared();
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.c.state.observation.shop.shop_id, "4");
  h.c.stop();
  const other = harness();
  other.setStage(1);
  other.setAccounts([f.player_id]);
  await other.port.prepare(f.player_id, "create_shop", {
    name: "Adapter Shop",
  });
  await other.c.start();
  await other.c.discardPrepared();
  assert.equal(other.calls.sent.length, 0);
  assert.equal(other.c.state.pending, null);
  other.c.stop();
});

test("inventory displays six exact held, available, reserved and promised-capacity amounts", () => {
  const ledger = copy(body(f.steps[3]).data.outcome.buyer);
  ledger.inventory.held.crystal = "10";
  ledger.inventory.available.crystal = "3";
  ledger.inventory.listing_reserved.crystal = "5";
  ledger.inventory.trade_reserved.crystal = "2";
  ledger.inventory.production_output_reserved.crystal = "7";
  ledger.inventory.trade_inbound_reserved.crystal = "9";
  const rows = inventoryRows(ledger);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], {
    id: "crystal",
    name: "Crystals",
    held: "10",
    available: "3",
    reserved: "7",
    incoming: "16",
  });
  assert.equal(rows[4].held, "0");
  assert.equal(rows[5].id, "iron_tool");
});

const named = {
  schema: "living-town-web-v1",
  public: {
    networkId: "testnet",
    contractId: "new-town.testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    explorerUrl: "https://testnet.nearblocks.io",
    workerUrl: "http://127.0.0.1:3011",
  },
  identity: {
    ...identity,
    deployment: { ...identity.deployment, contract_id: "new-town.testnet" },
  },
};
test("fresh web profile is explicit and bounded; absent config opens preview without selecting old targets", async () => {
  assert.equal(
    parseLivingTownWebProfile(named).public.contractId,
    "new-town.testnet",
  );
  assert.throws(() =>
    parseLivingTownWebProfile({ ...named, private_key: "unexpected" }),
  );
  assert.throws(() =>
    parseLivingTownWebProfile({
      ...named,
      public: { ...named.public, contractId: "other.testnet" },
    }),
  );
  const base = new URL("http://127.0.0.1:4200/");
  let calls = 0;
  assert.equal(
    (
      await loadLivingTownSetup(base, async (url) => {
        calls++;
        assert.equal(url.pathname, "/living-town.json");
        return new Response("", { status: 404 });
      })
    ).kind,
    "unconfigured",
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await loadLivingTownSetup(
        base,
        async () =>
          new Response("<html>app</html>", {
            headers: { "content-type": "text/html" },
          }),
      )
    ).kind,
    "unconfigured",
  );
  assert.equal(
    (
      await loadLivingTownSetup(
        base,
        async () => new Response(JSON.stringify(named)),
      )
    ).kind,
    "ready",
  );
  assert.equal(
    (
      await loadLivingTownSetup(
        base,
        async () => new Response('{"schema":"a","schema":"b"}'),
      )
    ).kind,
    "unavailable",
  );
  assert.equal(
    (
      await loadLivingTownSetup(
        base,
        async () => new Response("x".repeat(17000)),
      )
    ).kind,
    "unavailable",
  );
});

function receiptRpc() {
  return async (_url, options) => {
    const { id, method, params: p } = JSON.parse(options.body),
      last = f.steps.at(-1);
    let data;
    const chosen =
        f.steps.find((s) => s.block.header.hash === p.block_id) ?? last,
      header = p.block_id ? chosen.block.header : last.block.header;
    if (method === "status")
      data = { chain_id: "testnet", sync_info: { syncing: false } };
    else if (method === "EXPERIMENTAL_genesis_config")
      data = { chain_id: "testnet", genesis_height: 7 };
    else if (method === "block")
      data =
        p.block_id === 7
          ? { header: { height: 7, hash: identity.deployment.genesis_hash } }
          : { header };
    else if (method === "tx")
      data = f.steps.find((s) => s.transaction_hash === p.tx_hash).receipt;
    else if (method === "query") {
      if (p.request_type === "view_account")
        data = {
          ...chosen.account,
          block_hash: header.hash,
          block_height: header.height,
        };
      else {
        let snapshot;
        if (p.method_name === "get_foundation")
          snapshot = JSON.parse(
            Buffer.from(chosen.foundation.result).toString(),
          );
        else if (p.method_name === "get_town")
          snapshot = copy(f.final_views.get_town);
        else if (p.method_name === "get_player")
          snapshot = {
            ...copy(f.final_views.get_town),
            data: {
              ...copy(body(f.steps[0]).data.outcome.player),
              shop_id: "4",
              ledger: copy(body(f.steps[3]).data.outcome.buyer),
            },
          };
        else if (p.method_name === "get_shop")
          snapshot = copy(f.final_views.get_shop);
        else if (p.method_name === "get_shop_inventory")
          snapshot = copy(f.final_views.get_shop_inventory);
        else if (p.method_name === "get_listings")
          snapshot = {
            ...copy(f.final_views.get_town),
            data: {
              items: [copy(body(f.steps[3]).data.outcome.listing)],
              next_after_id: "1",
              has_more: false,
              history_gap: false,
              pruned_through: "0",
            },
          };
        else throw Error("Unexpected RPC " + p.method_name);
        snapshot.block_height = String(header.height);
        snapshot.block_timestamp_ns = header.timestamp_nanosec;
        snapshot.market_revision = "5";
        snapshot.event_sequence = "5";
        data = {
          block_hash: header.hash,
          block_height: header.height,
          result: Array.from(Buffer.from(JSON.stringify(snapshot))),
        };
      }
    } else throw Error("Unexpected RPC " + method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: data }));
  };
}
test("a stored creation transaction becomes an ownership link only after original receipt verification", async () => {
  const profile = {
      public: { ...named.public, contractId: f.contract_id },
      identity,
    },
    map = new Map(),
    storage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };
  const step = f.steps[1],
    proof = {
      transactionHash: step.transaction_hash,
      signerId: f.player_id,
      deployment: identity.deployment,
      call: createLivingTownCall(step.method, step.args),
      referenceBlockHeight: String(step.reference_block_height),
    };
  const key = `bot-bazaar:living-town:ownership:1:${identity.deployment.genesis_hash}:${f.contract_id}:${f.player_id}:4:2`;
  map.set(key, JSON.stringify({ identity, proof }));
  const port = createLivingTownPort(
    profile,
    storage,
    receiptRpc(),
    async () => {
      throw Error("must not sign");
    },
  );
  const observation = await port.read(f.player_id);
  assert.equal(observation.shop.name, "Verified Shop");
  assert.equal(observation.ledger.gold.held, "96");
  assert.equal(
    observation.ownershipUrl,
    `https://testnet.nearblocks.io/txns/${step.transaction_hash}`,
  );
  map.set(
    key,
    JSON.stringify({
      identity,
      proof: { ...proof, transactionHash: f.steps[3].transaction_hash },
    }),
  );
  const rejected = await createLivingTownPort(
    profile,
    storage,
    receiptRpc(),
    async () => {
      throw Error("must not sign");
    },
  ).read(f.player_id);
  assert.equal(rejected.ownershipUrl, null);
  assert.equal(
    townTransactionUrl("https://attacker.example", step.transaction_hash),
    null,
  );
  assert.equal(
    townTransactionUrl(named.public.explorerUrl, "javascript:bad"),
    null,
  );
});

test("the actual default bootstrap loads the new storefront without old deployment or wallet state", async () => {
  const stubs = {
    "@angular/platform-browser":
      "export async function bootstrapApplication(c,p){globalThis.done({name:c.name,setup:p.providers[0].useValue});}",
    "./app/living-town.component": "export class LivingTownComponent {}",
    "./app/living-town-profile":
      'export const LIVING_TOWN_SETUP={};export async function loadLivingTownSetup(url){globalThis.reads.push(url.href);return {kind:"unconfigured"};}',
    "./app/app.component":
      'throw Error("Old app loaded");export class AppComponent {}',
    "./load-public-config":
      'export async function loadPublicDeployment(){throw Error("Old config read");}',
    "./app/deployment-session":
      'export class DeploymentSession {constructor(){throw Error("Old state read");}}',
    "./app/public-config": "export const PUBLIC_CONFIG={};",
    "./app/deployment.service": "export const DEPLOYMENT_SESSION={};",
    "./app/replay.component": "export class ReplayComponent {}",
  };
  const bundle = await build({
    entryPoints: ["apps/web/src/main.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    plugins: [
      {
        name: "fresh-bootstrap",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) =>
            stubs[a.path] ? { path: a.path, namespace: "boot" } : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "boot" }, (a) => ({
            contents: stubs[a.path],
          }));
        },
      },
    ],
  });
  const reads = [];
  let complete;
  const finished = new Promise((r) => {
    complete = r;
  });
  vm.runInNewContext(bundle.outputFiles[0].text, {
    URL,
    location: { href: "http://127.0.0.1:4200/" },
    document: {
      baseURI: "http://127.0.0.1:4200/",
      querySelector() {
        throw Error("boot failed");
      },
    },
    done: complete,
    reads,
    console: {
      error() {
        complete({ name: "error" });
      },
    },
  });
  const boot = await finished;
  assert.equal(boot.name, "LivingTownComponent");
  assert.equal(boot.setup.kind, "unconfigured");
  assert.deepEqual(reads, ["http://127.0.0.1:4200/"]);
});

test("stored-wallet errors disable new approvals and prepared summaries retain reviewed terms", async () => {
  const h = harness();
  h.setAccounts([f.player_id]);
  h.port.restore = async () => {
    throw Error("storage unavailable");
  };
  await h.c.start();
  assert.equal(h.c.canTransact, false);
  await h.c.act("register_player", {});
  assert.equal(h.calls.sent.length, 0);
  h.c.stop();
  const a = {
    call: createLivingTownCall("buy_from_merchant", f.steps[3].args),
  };
  assert.match(describeTownAttempt(a), /maximum 4 game gold/);
});

test(
  "a slow pre-creation read cannot replace newly confirmed shop state",
  { timeout: 5000 },
  async () => {
    const h = harness();
    h.setStage(1);
    h.setAccounts([f.player_id]);
    await h.c.start();
    const original = h.port.read;
    const old = await original(f.player_id);
    let release;
    h.port.read = async () =>
      new Promise((resolve) => {
        release = () => resolve(old);
      });
    const background = h.c.refresh();
    await Promise.resolve();
    await h.c.act("create_shop", { name: "Adapter Shop" });
    const updated = new Promise((resolve) =>
      h.onState((state) => {
        if (state.observation?.shop?.shop_id === "4") resolve();
      }),
    );
    h.port.read = original;
    release();
    await background;
    await updated;
    assert.equal(h.c.state.observation.shop.shop_id, "4");
    assert.equal(h.calls.sent.length, 1);
    h.c.stop();
  },
);

test("spectators can read the town when wallet restoration is unavailable", async () => {
  const h = harness();
  h.port.accounts = async () => {
    throw Error("wallet offline");
  };
  await h.c.start();
  assert.equal(h.c.state.accountId, null);
  assert(h.c.state.observation);
  assert.equal(h.c.state.phase, "disconnected");
  assert.match(h.c.state.message, /Wallet connection/);
  assert.equal(h.calls.sent.length, 0);
  assert.equal(h.c.canTransact, false);
  h.c.stop();
});
