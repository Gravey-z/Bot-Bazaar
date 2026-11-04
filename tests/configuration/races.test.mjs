import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const fixture = JSON.parse(
  await readFile("tests/fixtures/chain/market.json", "utf8"),
);
const output = await build({
  stdin: {
    contents: `
  export {PurchaseController} from './apps/web/src/app/purchase.ts';
  export {RegistrationController} from './apps/web/src/app/registration.ts';
  export {WalletContextStore} from './apps/web/src/app/wallet-context.ts';
  export {WalletSession} from './apps/web/src/app/wallet-session.ts';
`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "races",
  write: false,
});
const sandbox = vm.createContext({
  URL,
  crypto,
  structuredClone,
  setTimeout,
  clearTimeout,
});
vm.runInContext(output.outputFiles[0].text, sandbox, { filename: "races.js" });
const {
  PurchaseController,
  RegistrationController,
  WalletContextStore,
  WalletSession,
} = sandbox.races;
const config = { networkId: "testnet", contractId: fixture.contract_id };
const alpha = "alpha.testnet",
  beta = "beta.testnet";
const time =
  Number(BigInt(fixture.seed.market.block_timestamp_ns) / 1000000n) + 1000;
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function observation(accountId = alpha, offset = 0) {
  const market = structuredClone(fixture.seed.market);
  market.block_height = (
    BigInt(market.block_height) + BigInt(offset)
  ).toString();
  market.market_revision = (
    BigInt(market.market_revision) + BigInt(offset)
  ).toString();
  market.block_timestamp_ns = (
    BigInt(market.block_timestamp_ns) + BigInt(offset)
  ).toString();
  const player = {
    block_height: market.block_height,
    market_revision: market.market_revision,
    block_timestamp_ns: market.block_timestamp_ns,
    data: {
      account_id: accountId,
      gold: accountId === alpha ? "100" : "57",
      inventory: {
        crystal: accountId === alpha ? "0" : "8",
        wood: "0",
        herb: "0",
        iron: "0",
      },
    },
  };
  return { accountId, market, player, receivedAt: time };
}
function harness(kind = "purchase") {
  const context = new WalletContextStore(
    config,
    storage(),
    "http://127.0.0.1:4200/",
    () => crypto.randomUUID(),
    () => time,
  );
  const behavior = {
    read: async (id) => observation(id),
    receipt: async () => ({ kind: "pending" }),
    send: async () => ({
      transaction: { hash: fixture.steps[1].transaction_hash },
    }),
  };
  const states = [],
    calls = { sends: 0 };
  const reads = {
    read: (id) => behavior.read(id),
    receipt: (pending) => behavior.receipt(pending),
  };
  const send = (pending, identityVersion) => {
    calls.sends++;
    return behavior.send(pending, identityVersion);
  };
  const changed = (state) => states.push(state);
  const controller =
    kind === "purchase"
      ? new PurchaseController(
          reads,
          context,
          send,
          changed,
          () => {},
          () => {},
          () => time,
        )
      : new RegistrationController(
          reads,
          context,
          send,
          changed,
          () => {},
          () => time,
        );
  return { context, behavior, states, calls, controller };
}
async function ready(h, id = alpha) {
  h.controller.setAccount(id);
  await settle();
}

test("a slow review cannot promote the newly selected account's quote", async () => {
  const h = harness();
  await ready(h);
  const old = deferred();
  h.behavior.read = (id) =>
    id === alpha ? old.promise : Promise.resolve(observation(id));
  const reviewing = h.controller.review();
  h.controller.setAccount(beta);
  await settle();
  assert.equal(h.controller.state.quote.gold, "57");
  old.resolve(observation(alpha));
  await reviewing;
  assert.equal(h.controller.state.accountId, beta);
  assert.equal(h.controller.state.phase, "editing");
  assert.equal(h.controller.state.reviewed, null);
  await h.controller.confirm();
  assert.equal(h.calls.sends, 0);
});

test("editing while review is pending requires a fresh explicit review", async () => {
  const h = harness();
  await ready(h);
  const old = deferred();
  let calls = 0;
  h.behavior.read = async (id) =>
    ++calls === 1 ? old.promise : observation(id);
  const reviewing = h.controller.review();
  h.controller.edit("rex", "crystal", "2");
  await settle();
  old.resolve(observation());
  await reviewing;
  assert.equal(h.controller.state.quantity, "2");
  assert.equal(h.controller.state.phase, "editing");
  assert.equal(h.controller.state.reviewed, null);
  await h.controller.confirm();
  assert.equal(h.calls.sends, 0);
});

for (const kind of ["purchase", "registration"]) {
  test(`${kind}: switching accounts clears cached data and ignores a late old-player read`, async () => {
    const h = harness(kind);
    await ready(h);
    const old = deferred();
    h.behavior.read = (id) =>
      id === alpha ? old.promise : Promise.resolve(observation(id));
    const refresh = h.controller.refresh();
    h.controller.setAccount(beta);
    assert.equal(h.controller.state.observation, null);
    await settle();
    old.resolve(observation(alpha));
    await refresh;
    assert.equal(h.controller.state.observation.player.data.account_id, beta);
    assert.equal(h.controller.state.observation.player.data.gold, "57");
    for (const state of h.states)
      if (state.observation)
        assert.equal(state.observation.player.data.account_id, state.accountId);
  });

  test(`${kind}: an A-to-B-to-A identity generation cancels an old A response`, async () => {
    const h = harness(kind);
    h.controller.setAccount(alpha, 1);
    await settle();
    const old = deferred();
    let calls = 0;
    h.behavior.read = async (id) => {
      if (++calls === 1) return old.promise;
      const value = observation(id, 1);
      value.player.data.gold = "73";
      return value;
    };
    const refresh = h.controller.refresh();
    h.controller.setAccount(alpha, 3);
    assert.equal(h.controller.state.observation, null);
    await settle();
    old.resolve(observation(alpha));
    await refresh;
    assert.equal(h.controller.state.observation.player.data.gold, "73");
  });

  for (const [name, mutate] of [
    ["regressed block", () => observation(alpha, 1)],
    [
      "conflicting block",
      () => {
        const value = observation(alpha, 2);
        value.player.data.gold = "8";
        return value;
      },
    ],
    [
      "mixed player revision",
      () => {
        const value = observation(alpha, 3);
        value.player.market_revision = "1";
        return value;
      },
    ],
    ["another player's response", () => observation(beta, 3)],
  ])
    test(`${kind}: ${name} cannot replace accepted player data`, async () => {
      const h = harness(kind);
      h.behavior.read = async () => observation(alpha, 2);
      await ready(h);
      h.behavior.read = async () => mutate();
      await h.controller.refresh();
      assert.equal(h.controller.state.observation, null);
      if (kind === "purchase") {
        await h.controller.review();
        await h.controller.confirm();
      } else await h.controller.register();
      assert.equal(h.calls.sends, 0);
    });

  test(`${kind}: reader-owned objects cannot mutate the displayed cache later`, async () => {
    const h = harness(kind),
      shared = observation();
    h.behavior.read = async () => shared;
    await ready(h);
    shared.player.data.account_id = beta;
    shared.player.data.gold = "999";
    assert.equal(h.controller.state.observation.player.data.account_id, alpha);
    assert.equal(h.controller.state.observation.player.data.gold, "100");
  });
}

test("two overlapping visitors retain separate inventories even when responses arrive backwards", async () => {
  const a = harness(),
    b = harness(),
    first = deferred(),
    second = deferred();
  a.behavior.read = async (id) => {
    assert.equal(id, alpha);
    return first.promise;
  };
  b.behavior.read = async (id) => {
    assert.equal(id, beta);
    return second.promise;
  };
  a.controller.setAccount(alpha);
  b.controller.setAccount(beta);
  second.resolve(observation(beta));
  await settle();
  first.resolve(observation(alpha));
  await settle();
  assert.equal(
    a.controller.state.observation.player.data.inventory.crystal,
    "0",
  );
  assert.equal(
    b.controller.state.observation.player.data.inventory.crystal,
    "8",
  );
  assert.equal(a.controller.state.quote.gold, "100");
  assert.equal(b.controller.state.quote.gold, "57");
});

test("a competing purchase invalidates the losing visitor's listing and requires another confirmation", async () => {
  const a = harness(),
    b = harness();
  let revision = 0;
  const players = {
    [alpha]: { gold: "100", crystal: "0" },
    [beta]: { gold: "57", crystal: "8" },
  };
  const results = new Map();
  function view(id) {
    const value = observation(id, revision);
    const merchant = value.market.data.merchants[0],
      listing = merchant.listings[0];
    listing.version = String(1 + revision);
    listing.quantity = String(15 - revision);
    merchant.inventory.crystal = String(15 - revision);
    merchant.gold = String(180 + revision * 4);
    value.player.data.gold = players[id].gold;
    value.player.data.inventory.crystal = players[id].crystal;
    return value;
  }
  for (const visitor of [a, b]) {
    visitor.behavior.read = async (id) => view(id);
    visitor.behavior.send = async (pending) => {
      const args = pending.call.args;
      if (args.listing_version !== String(1 + revision))
        results.set(pending.id, { kind: "failed", code: "E_STALE_LISTING" });
      else {
        players[pending.accountId].gold = String(
          BigInt(players[pending.accountId].gold) -
            BigInt(args.max_total_price),
        );
        players[pending.accountId].crystal = String(
          BigInt(players[pending.accountId].crystal) + BigInt(args.quantity),
        );
        revision++;
        results.set(pending.id, { kind: "succeeded" });
      }
      return { transaction: { hash: fixture.steps[1].transaction_hash } };
    };
    visitor.behavior.receipt = async (pending) => results.get(pending.id);
  }
  await Promise.all([ready(a, alpha), ready(b, beta)]);
  await Promise.all([a.controller.review(), b.controller.review()]);
  await Promise.all([a.controller.confirm(), b.controller.confirm()]);
  assert.equal(revision, 1);
  assert.equal(a.calls.sends, 1);
  assert.equal(b.calls.sends, 1);
  assert.equal(a.controller.state.observation.player.data.gold, "96");
  assert.equal(b.controller.state.observation.player.data.gold, "57");
  assert.equal(
    b.controller.state.observation.player.data.inventory.crystal,
    "8",
  );
  assert.equal(b.controller.state.phase, "failed");
  assert.match(b.controller.state.message, /listing changed/);
  assert.equal(b.controller.state.quote.args.listing_version, "2");
  assert.equal(b.controller.state.reviewed, null);
  await b.controller.confirm();
  assert.equal(b.calls.sends, 1);
});

test("a wallet selection invalidates a pending old account-list response", async () => {
  const context = new WalletContextStore(
    config,
    storage(),
    "http://127.0.0.1:4200/",
  );
  const pending = deferred();
  let slow = false;
  const accounts = [{ accountId: alpha }, { accountId: beta }];
  const port = {
    connect: async () => accounts,
    accounts: async () => (slow ? pending.promise : accounts),
    disconnect: async () => {},
    subscribe: () => () => {},
  };
  const session = new WalletSession(
    config,
    storage(),
    context,
    async () => port,
    () => {},
  );
  await session.connect();
  const initial = session.state.identityVersion;
  slow = true;
  const checking = session.refresh();
  await settle();
  session.select(beta);
  session.select(alpha);
  assert.equal(session.state.identityVersion, initial + 2);
  session.select(beta);
  pending.resolve([{ accountId: alpha }]);
  await checking;
  assert.equal(session.state.accountId, beta);
});

test("the wallet rejects an old review token even before the UI processes an A-to-B-to-A switch", async () => {
  const h = harness();
  let walletSends = 0;
  const accounts = [{ accountId: alpha }, { accountId: beta }];
  const port = {
    connect: async () => accounts,
    accounts: async () => accounts,
    disconnect: async () => {},
    subscribe: () => () => {},
    buy: async () => {
      walletSends++;
    },
  };
  const session = new WalletSession(
    config,
    storage(),
    h.context,
    async () => port,
    () => {},
  );
  await session.connect();
  h.controller.setAccount(alpha, session.state.identityVersion);
  await settle();
  await h.controller.review();
  const preflight = deferred();
  h.behavior.read = async () => preflight.promise;
  h.behavior.send = (pending, identityVersion) =>
    session.submitPurchase(pending, identityVersion);
  const confirming = h.controller.confirm();
  session.select(beta);
  session.select(alpha);
  preflight.resolve(observation(alpha));
  await confirming;
  assert.equal(walletSends, 0);
  assert.equal(h.context.read(), null);
  assert.equal(h.context.lastTransaction().lifecycle.phase, "not_submitted");
});

test("a stale-listing failure discovered by the monitor still refreshes the form and explains reconfirmation", async () => {
  const h = harness();
  await ready(h);
  const pending = h.context.prepareTransaction(
    alpha,
    "buy_from_merchant",
    h.controller.state.quote.args,
  );
  h.context.recordPurchaseHash(pending.id, fixture.steps[1].transaction_hash);
  h.context.settle(pending.id, "failed", "E_STALE_LISTING");
  h.behavior.read = async () => {
    const value = observation(alpha, 1);
    value.market.data.merchants[0].listings[0].version = "2";
    return value;
  };
  await h.controller.refresh();
  assert.equal(h.controller.state.quote.args.listing_version, "2");
  assert.match(h.controller.state.message, /listing changed/);
  assert.equal(h.controller.state.reviewed, null);
  await h.controller.confirm();
  assert.equal(h.calls.sends, 0);
});
