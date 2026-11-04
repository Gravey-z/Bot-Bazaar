import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

async function bundle(entry, name) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: name,
    write: false,
  });
  const context = vm.createContext({ URL, crypto, setTimeout, clearTimeout });
  vm.runInContext(result.outputFiles[0].text, context, {
    filename: `${name}.js`,
  });
  return context[name];
}
const { WalletContextStore, isTestnetAccount } = await bundle(
  "apps/web/src/app/wallet-context.ts",
  "journal",
);
const { WalletSession } = await bundle(
  "apps/web/src/app/wallet-session.ts",
  "sessions",
);
const config = {
  networkId: "testnet",
  contractId: "vaultkeeper-bazaar.testnet",
};
const page = "http://127.0.0.1:4200/";
const id = "12c1d85e-4e5a-4a42-9e0d-e9a1d5adfd18";
const hint = `bot-bazaar:wallet:testnet:${config.contractId}`;
function storage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function journal(saved = storage()) {
  return new WalletContextStore(
    config,
    saved,
    page,
    () => id,
    () => 1793608000000,
  );
}
function harness(saved = storage(), preferences = storage()) {
  const context = journal(saved);
  let accounts = [{ accountId: "player.testnet" }];
  let failure;
  let listener;
  const calls = {
    load: 0,
    connect: 0,
    accounts: 0,
    disconnect: 0,
    unsubscribe: 0,
  };
  const port = {
    async connect() {
      calls.connect++;
      if (failure) throw failure;
      return accounts;
    },
    async accounts() {
      calls.accounts++;
      if (failure) throw failure;
      return accounts;
    },
    async disconnect() {
      calls.disconnect++;
    },
    subscribe(callback) {
      listener = callback;
      return () => {
        calls.unsubscribe++;
      };
    },
  };
  const session = new WalletSession(
    config,
    preferences,
    context,
    async () => {
      calls.load++;
      return port;
    },
    () => {},
  );
  return {
    context,
    saved,
    preferences,
    session,
    calls,
    port,
    accounts(value) {
      accounts = value;
    },
    fail(value) {
      failure = value;
    },
    event() {
      listener();
    },
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("spectators never load a wallet or treat URL account IDs as a session", async () => {
  const h = harness();
  await h.session.restore(
    `${page}?account_id=attacker.testnet&transactionHashes=anything`,
  );
  await h.session.refresh();
  assert.equal(h.calls.load, 0);
  assert.equal(h.session.state.accountId, null);
});

test("connection is serialized, re-reads wallet accounts, and restores without signing in again", async () => {
  const h = harness();
  await Promise.all([h.session.connect(), h.session.connect()]);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.accounts, 1);
  assert.equal(h.session.state.accountId, "player.testnet");
  assert.equal(h.context.read(), null);
  const reloaded = harness(h.saved, h.preferences);
  await reloaded.session.restore(page);
  assert.equal(reloaded.calls.connect, 0);
  assert.equal(reloaded.calls.accounts, 1);
  assert.equal(reloaded.session.state.status, "connected");
});

test("wallet rejection exposes a fixed message and permits explicit retry", async () => {
  const h = harness();
  h.fail(new Error("<script>private wallet transport error</script>"));
  await h.session.connect();
  assert.equal(h.session.state.status, "blocked");
  assert.equal(h.context.read(), null);
  assert.equal(JSON.stringify(h.session.state).includes("<script>"), false);
  h.fail(null);
  await h.session.connect();
  assert.equal(h.session.state.status, "connected");
});

test("account changes replace identity, preserve authorized selection, and clear removed accounts", async () => {
  const h = harness();
  await h.session.connect();
  h.accounts([{ accountId: "one.testnet" }, { accountId: "two.testnet" }]);
  h.event();
  await settle();
  assert.equal(h.session.state.accountId, "one.testnet");
  h.session.select("two.testnet");
  await h.session.refresh();
  assert.equal(h.session.state.accountId, "two.testnet");
  h.session.select("attacker.testnet");
  assert.equal(h.session.state.accountId, "two.testnet");
  h.accounts([]);
  await h.session.refresh();
  assert.equal(h.session.state.accountId, null);
  assert.equal(h.session.state.status, "disconnected");
});

test("mainnet or malformed accounts and network failures clear the previously displayed identity", async () => {
  const h = harness();
  await h.session.connect();
  for (const account of ["player.near", "<img>.testnet", "a..b.testnet"]) {
    h.accounts([{ accountId: account }]);
    await h.session.refresh();
    assert.equal(h.session.state.status, "blocked");
    assert.equal(h.session.state.accountId, null);
  }
  h.fail(new Error("wrong network"));
  await h.session.refresh();
  assert.equal(h.session.state.accountId, null);
  assert.equal(isTestnetAccount("a".repeat(64)), true);
});

test("disconnect invalidates a pending response and does not silently reconnect", async () => {
  const h = harness();
  await h.session.connect();
  let resolve;
  h.port.accounts = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.session.refresh();
  await settle();
  await h.session.disconnect();
  resolve([{ accountId: "late.testnet" }]);
  await pending;
  await h.session.refresh();
  assert.equal(h.session.state.status, "disconnected");
  assert.equal(h.session.state.accountId, null);
  assert.equal(h.preferences.getItem(hint), null);
});

test("destroy removes listeners and ignores a late connection result", async () => {
  const h = harness();
  let resolve;
  h.port.connect = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.session.connect();
  await settle();
  h.session.destroy();
  resolve([]);
  await pending;
  assert.equal(h.calls.unsubscribe, 1);
  assert.equal(h.session.state.accountId, null);
  assert.equal(h.context.read().kind, "connect");
});

test("connection context survives reload and clears only after wallet account verification", async () => {
  const h = harness();
  const first = h.context.beginConnect();
  assert.equal(first.returnUrl, `${page}?bbWalletState=${id}`);
  const reloaded = harness(h.saved);
  await reloaded.session.restore(first.returnUrl);
  assert.equal(reloaded.calls.connect, 0);
  assert.equal(reloaded.session.state.accountId, "player.testnet");
  assert.equal(reloaded.context.read(), null);
});

test("transaction intent survives return, disconnect and account switching without resubmission", async () => {
  const h = harness();
  const first = h.context.prepareTransaction(
    "original.testnet",
    "buy_from_merchant",
    {
      merchant_id: "rex",
      resource: "crystal",
      quantity: "12",
      max_total_price: "48",
      listing_version: "1",
    },
  );
  await h.session.restore(
    `${first.returnUrl}&transactionHashes=unverified&errorCode=arbitrary`,
  );
  assert.equal(h.calls.connect, 0);
  assert.match(h.session.state.message, /another account/);
  assert.deepEqual(plain(h.context.read()), plain(first));
  await h.session.disconnect();
  await h.session.connect();
  assert.equal(h.calls.connect, 0);
  assert.deepEqual(plain(h.context.read()), plain(first));
  assert.throws(() => h.context.finishConnect(first.id));
  assert.throws(() =>
    h.context.prepareTransaction("other.testnet", "register_player", {}),
  );
});

test("return correlation requires the same origin, route and a single matching state", () => {
  const context = journal();
  const first = context.beginConnect();
  assert.equal(context.returned(first.returnUrl), true);
  for (const url of [
    `https://attacker.example/?bbWalletState=${id}`,
    `${page}other?bbWalletState=${id}`,
    `${first.returnUrl}&bbWalletState=${id}`,
    `${page}?bbWalletState=wrong`,
    `${page}?account_id=player.testnet`,
  ])
    assert.equal(context.returned(url), false);
  context.finishConnect(first.id);
  assert.equal(context.returned(first.returnUrl), false);
});

test("malformed or unavailable saved state blocks connect before any wallet call", async () => {
  for (const unavailable of [false, true]) {
    const saved = storage();
    if (unavailable)
      saved.getItem = () => {
        throw new Error("storage denied");
      };
    else
      saved.setItem(
        `bot-bazaar:wallet-context:v1:testnet:${config.contractId}`,
        "malformed",
      );
    const h = harness(saved);
    await h.session.restore(page);
    await h.session.connect();
    assert.equal(h.session.state.status, "blocked");
    assert.equal(h.calls.load, 0);
  }
});

test("context rejects admin calls, wrong-network signers and invalid purchase fields", () => {
  const context = journal();
  assert.throws(() =>
    context.prepareTransaction("player.near", "register_player", {}),
  );
  assert.throws(() =>
    context.prepareTransaction("player.testnet", "pause_market", {}),
  );
  assert.throws(() =>
    context.prepareTransaction("player.testnet", "buy_from_merchant", {
      quantity: 12,
    }),
  );
  assert.equal(context.read(), null);
});

test("saved deployment mismatch and extra fields remain preserved but unusable", () => {
  for (const mutation of [
    (value) => {
      value.networkId = "mainnet";
    },
    (value) => {
      value.contractId = "other.testnet";
    },
    (value) => {
      value.returnUrl = "https://attacker.example/";
    },
    (value) => {
      value.secret = "never accepted";
    },
  ]) {
    const saved = storage();
    const context = journal(saved);
    context.beginConnect();
    const [key, raw] = [...saved.values][0];
    const value = JSON.parse(raw);
    mutation(value);
    saved.setItem(key, JSON.stringify(value));
    assert.throws(() => context.read());
    assert.equal(saved.values.size, 1);
  }
});

test("wallet dependency is exact and introduces no runtime dependency tree", async () => {
  const app = JSON.parse(await readFile("apps/web/package.json", "utf8"));
  const sdk = JSON.parse(
    await readFile(
      "apps/web/node_modules/@hot-labs/near-connect/package.json",
      "utf8",
    ),
  );
  assert.equal(app.dependencies["@hot-labs/near-connect"], "0.11.4");
  assert.deepEqual(sdk.dependencies ?? {}, {});
});

test("disconnect in another tab clears identity and keeps transaction context", async () => {
  const h = harness();
  await h.session.connect();
  const pending = h.context.prepareTransaction(
    "player.testnet",
    "register_player",
    {},
  );
  h.preferences.removeItem(hint);
  h.session.preferencesChanged();
  await h.session.refresh();
  assert.equal(h.session.state.accountId, null);
  assert.equal(h.session.state.status, "disconnected");
  assert.deepEqual(plain(h.context.read()), plain(pending));
});

test("a failed intent write cannot open the wallet", async () => {
  const saved = storage();
  saved.setItem = () => {
    throw new Error("quota exceeded");
  };
  const h = harness(saved);
  await h.session.connect();
  assert.equal(h.calls.load, 0);
  assert.equal(h.session.state.status, "blocked");
});

test("cancelling during lazy loading prevents a later sign-in prompt", async () => {
  const saved = storage();
  const context = journal(saved);
  let resolve;
  let signIns = 0;
  const session = new WalletSession(
    config,
    storage(),
    context,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    () => {},
  );
  const connecting = session.connect();
  const disconnecting = session.disconnect();
  resolve({
    connect: async () => {
      signIns++;
    },
    disconnect: async () => {},
    subscribe: () => () => {},
  });
  await Promise.all([connecting, disconnecting]);
  assert.equal(signIns, 0);
  assert.equal(context.read(), null);
});

test("reconnecting with an unresolved registration preserves intent and opens no transaction", async () => {
  const h = harness();
  const pending = h.context.prepareTransaction(
    "player.testnet",
    "register_player",
    {},
  );
  await h.session.restore(page);
  await h.session.disconnect();
  await h.session.connect();
  assert.equal(h.calls.connect, 1);
  assert.equal(h.session.state.accountId, "player.testnet");
  assert.deepEqual(plain(h.context.read()), plain(pending));
  assert.equal(h.session.state.pending.id, pending.id);
});

test("registration submission needs the matching stored intent and cannot run twice concurrently", async () => {
  const h = harness();
  await h.session.connect();
  const pending = h.context.prepareTransaction(
    "player.testnet",
    "register_player",
    {},
  );
  let resolve;
  let registrations = 0;
  h.port.register = () => {
    registrations++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const first = h.session.submitRegistration(pending);
  await settle();
  await assert.rejects(h.session.submitRegistration(pending), /not opened/);
  resolve({});
  await first;
  assert.equal(registrations, 1);
  assert.equal(h.context.read().id, pending.id);
  await assert.rejects(
    h.session.submitRegistration({ ...pending, contractId: "other.testnet" }),
    /not opened/,
  );
});

test("disconnect during registration account verification prevents the wallet request", async () => {
  const h = harness();
  await h.session.connect();
  const pending = h.context.prepareTransaction(
    "player.testnet",
    "register_player",
    {},
  );
  let resolve;
  let registrations = 0;
  h.port.accounts = () =>
    new Promise((done) => {
      resolve = done;
    });
  h.port.register = async () => {
    registrations++;
  };
  const first = h.session.submitRegistration(pending);
  await settle();
  await h.session.disconnect();
  resolve([{ accountId: "player.testnet" }]);
  await assert.rejects(first, /not opened/);
  assert.equal(registrations, 0);
  assert.equal(h.context.read().id, pending.id);
});

test("adapter pins Meteor, explicitly selects Testnet, never requests keys, and checks RPC network", async () => {
  const capture = {
    signIns: [],
    accountReads: [],
    signOuts: [],
    registrations: [],
    options: null,
    connector: null,
  };
  let network = "testnet";
  const output = await build({
    entryPoints: ["apps/web/src/app/wallet-adapter.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "adapter",
    write: false,
    plugins: [
      {
        name: "wallet-double",
        setup(builder) {
          builder.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({
            path: "mock",
            namespace: "wallet-double",
          }));
          builder.onLoad({ filter: /.*/, namespace: "wallet-double" }, () => ({
            contents: `
        export class NearConnector {
          constructor(options) { capture.options = options; capture.connector = this; this.network = options.network; }
          on() {} off() {}
        }
        export class SandboxWallet {
          constructor(connector, manifest) { this.manifest = manifest; }
          async signIn(options) { capture.signIns.push(options); return [{ accountId: 'player.testnet' }]; }
          async getAccounts(options) { capture.accountReads.push(options); return [{ accountId: 'player.testnet' }]; }
          async signOut(options) { capture.signOuts.push(options); }
          async signAndSendTransaction(options) { capture.registrations.push(options); return { transaction: { hash: 'candidate' } }; }
        }
      `,
          }));
        },
      },
    ],
  });
  const context = vm.createContext({
    capture,
    URL,
    structuredClone,
    AbortSignal,
    TextDecoder,
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, "status");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { chain_id: network, sync_info: { syncing: false } },
        }),
      );
    },
  });
  vm.runInContext(output.outputFiles[0].text, context, {
    filename: "wallet-adapter.js",
  });
  const saved = storage();
  const port = await context.adapter.createWalletPort(
    { ...config, rpcUrl: "https://test.rpc.fastnear.com" },
    saved,
  );
  assert.equal(capture.options.autoConnect, false);
  assert.equal(capture.options.network, "testnet");
  assert.equal(capture.options.manifest.wallets.length, 1);
  assert.equal(capture.options.manifest.wallets[0].id, "meteor-wallet");
  assert.match(
    capture.options.manifest.wallets[0].executor,
    /\/911f9d645b912fadbb1af0d0953cba44b005c82f\//,
  );
  await port.connect();
  await port.accounts();
  saved.setItem(
    "meteor-wallet:meteor-account-data",
    JSON.stringify({
      account: { accountId: "player.testnet" },
      identifier: {
        accountId: "player.testnet",
        network: "testnet",
        blockchain: "near",
      },
    }),
  );
  await port.register("player.testnet");
  assert.deepEqual(plain(capture.registrations), [
    {
      network: "testnet",
      signerId: "player.testnet",
      receiverId: config.contractId,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "register_player",
            args: {},
            gas: "30000000000000",
            deposit: "0",
          },
        },
      ],
    },
  ]);
  await assert.rejects(port.register("other.testnet"), /not opened/);
  saved.setItem(
    "meteor-wallet:meteor-account-data",
    JSON.stringify({
      account: { accountId: "player.testnet" },
      identifier: {
        accountId: "player.testnet",
        network: "mainnet",
        blockchain: "near",
      },
    }),
  );
  await assert.rejects(port.register("player.testnet"), /not opened/);
  assert.equal(capture.registrations.length, 1);
  await port.disconnect();
  assert.deepEqual(plain(capture.signIns), [{ network: "testnet" }]);
  assert.ok(capture.accountReads.length >= 2);
  assert.ok(capture.accountReads.every((row) => row.network === "testnet"));
  assert.deepEqual(plain(capture.signOuts), [{ network: "testnet" }]);
  network = "mainnet";
  await assert.rejects(port.connect(), /Testnet unavailable/);
  assert.equal(capture.signIns.length, 1);
  network = "testnet";
  capture.connector.network = "mainnet";
  await assert.rejects(port.accounts(), /Testnet required/);
});
