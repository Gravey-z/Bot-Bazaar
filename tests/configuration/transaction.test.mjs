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
  export * from './apps/web/src/app/wallet-context.ts';
  export * from './apps/web/src/app/transaction-lifecycle.ts';
  export * from './apps/web/src/app/transaction-errors.ts';
  export {createPurchaseReads} from './apps/web/src/app/registration-reader.ts';
  export {WalletSession} from './apps/web/src/app/wallet-session.ts';
`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "transactions",
  write: false,
});
let rpcResponse = structuredClone(fixture.steps[1].receipt);
const sandbox = vm.createContext({
  URL,
  crypto,
  setTimeout,
  clearTimeout,
  TextDecoder,
  TextEncoder,
  AbortSignal,
  btoa,
  atob,
  fetch: async (_url, options) => {
    const request = JSON.parse(options.body),
      block = fixture.final.finalized_block;
    const result =
      request.method === "status"
        ? { chain_id: "testnet", sync_info: { syncing: false } }
        : request.method === "block"
          ? {
              header: {
                hash: block.hash,
                height: block.height,
                timestamp_nanosec: block.timestamp_ns,
              },
            }
          : rpcResponse;
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    );
  },
});
vm.runInContext(output.outputFiles[0].text, sandbox, {
  filename: "transactions.js",
});
const {
  WalletContextStore,
  TransactionLifecycle,
  isMeteorRejection,
  WalletRejectedError,
  createPurchaseReads,
  WalletSession,
} = sandbox.transactions;
const config = {
  networkId: "testnet",
  contractId: fixture.contract_id,
  rpcUrl: "https://test.rpc.fastnear.com",
};
const page = "http://127.0.0.1:4200/";
const account = "player-bazaar.testnet";
const hash = fixture.steps[1].transaction_hash;
const plain = (value) => JSON.parse(JSON.stringify(value));
function storage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function harness(saved = storage()) {
  let now = 1793608000000;
  const context = new WalletContextStore(
    config,
    saved,
    page,
    () => crypto.randomUUID(),
    () => now,
  );
  const behavior = { receipt: async () => ({ kind: "pending" }) };
  const calls = { receipts: 0, settled: 0 };
  const controller = new TransactionLifecycle(
    context,
    (pending) => {
      calls.receipts++;
      return behavior.receipt(pending);
    },
    () => {},
    () => {
      calls.settled++;
    },
    () => now,
  );
  return {
    context,
    saved,
    controller,
    behavior,
    calls,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    prepare: () =>
      context.prepareTransaction(
        account,
        "buy_from_merchant",
        fixture.steps[1].args,
        fixture.seed.market.block_height,
      ),
  };
}

test("pending details and latest terminal state survive reconstruction", async () => {
  const h = harness();
  const pending = h.prepare();
  h.context.progress(pending.id, "awaiting_wallet");
  const reload = harness(h.saved);
  await reload.controller.restore(page);
  assert.equal(reload.controller.state.phase, "unknown");
  assert.equal(reload.calls.receipts, 0);
  assert.deepEqual(plain(reload.context.read().call), plain(pending.call));
  reload.context.recordPurchaseHash(pending.id, hash);
  reload.behavior.receipt = async () => ({ kind: "succeeded" });
  await reload.controller.refresh();
  assert.equal(reload.context.read(), null);
  const again = harness(h.saved);
  await again.controller.restore(page);
  assert.equal(again.controller.state.phase, "confirmed");
  assert.equal(again.controller.state.record.transactionHash, hash);
  assert.equal(again.calls.receipts, 0);
});

test("submitted means pending execution, and final failure is persisted without another send", async () => {
  const h = harness();
  const pending = h.prepare();
  h.context.recordPurchaseHash(pending.id, hash);
  await h.controller.refresh();
  assert.equal(h.controller.state.phase, "submitted");
  assert.equal(h.context.read().id, pending.id);
  h.behavior.receipt = async () => ({
    kind: "failed",
    code: "EXECUTION_FAILED",
  });
  await h.controller.refresh();
  assert.equal(h.controller.state.phase, "failed");
  assert.equal(h.context.read(), null);
  assert.equal(h.calls.settled, 1);
});

test("RPC failure retains exact intent and bounded retry backoff", async () => {
  const h = harness();
  const pending = h.prepare();
  h.context.recordPurchaseHash(pending.id, hash);
  h.behavior.receipt = async () => {
    throw new Error("private RPC response");
  };
  await h.controller.refresh(false);
  assert.equal(h.controller.state.phase, "unknown");
  assert.equal(h.context.read().id, pending.id);
  assert.equal(JSON.stringify(h.controller.state).includes("private"), false);
  for (const delay of [6000, 12000, 24000, 30000, 30000]) {
    const before = h.calls.receipts;
    h.advance(delay - 1);
    await h.controller.refresh(false);
    assert.equal(h.calls.receipts, before);
    h.advance(1);
    await h.controller.refresh(false);
    assert.equal(h.calls.receipts, before + 1);
  }
  assert.throws(() => h.prepare());
});

test("replayed, duplicated, cross-route or cross-account wallet callbacks cannot attach hashes", () => {
  const h = harness(),
    pending = h.prepare();
  for (const url of [
    `https://attacker.example/?bbWalletState=${pending.id}&transactionHashes=${hash}`,
    `${page}other?bbWalletState=${pending.id}&transactionHashes=${hash}`,
    `${pending.returnUrl}&bbWalletState=${pending.id}&transactionHashes=${hash}`,
    `${pending.returnUrl}&transactionHashes=${hash}&transactionHashes=${hash}`,
    `${pending.returnUrl}&transactionHashes=${hash}&account_id=other.testnet`,
    `${pending.returnUrl}&transactionHashes=${hash}&networkId=mainnet`,
    `${pending.returnUrl}&transactionHashes=${hash}&contractId=other.testnet`,
    `${pending.returnUrl}&transactionHashes=${hash},${hash}`,
  ])
    assert.equal(h.context.consumeReturn(url), "invalid");
  assert.equal(h.context.read().transactionHash, undefined);
  const callback = `${pending.returnUrl}&transactionHashes=${hash}`;
  assert.equal(h.context.consumeReturn(callback), "accepted");
  assert.equal(h.context.read().transactionHash, hash);
  assert.equal(h.context.read().transactionSource, "return");
  assert.equal(h.context.read().lifecycle.phase, "unknown");
  assert.equal(h.context.consumeReturn(callback), "invalid");
});

test("callback error text is an unknown hint, never a trusted rejection", () => {
  const h = harness(),
    pending = h.prepare();
  assert.equal(
    h.context.consumeReturn(
      `${pending.returnUrl}&errorCode=USER_REJECTED&errorMessage=%3Cscript%3E`,
    ),
    "accepted",
  );
  assert.equal(h.context.read().lifecycle.phase, "unknown");
  assert.equal(h.context.lastTransaction(), null);
  assert.equal(JSON.stringify(h.context.read()).includes("script"), false);
});

test("known SDK rejection tags are narrow; closures and text-only errors remain ambiguous", () => {
  assert.equal(
    isMeteorRejection({
      name: "MeteorActionError",
      _reason: { endTags: ["USER_CANCELLED"] },
    }),
    true,
  );
  for (const error of [
    new Error("User cancelled the action"),
    { code: 4001 },
    { name: "MeteorActionError", _reason: { endTags: ["WINDOW_CLOSED"] } },
    {
      name: "MeteorActionError",
      _reason: { endTags: ["USER_CANCELLED", "INCOMPLETE_ACTION"] },
    },
    {
      name: "MeteorActionError",
      transactionHash: hash,
      _reason: { endTags: ["USER_CANCELLED"] },
    },
  ])
    assert.equal(isMeteorRejection(error), false);
});

test("session rejection is archived; repeating an uncertain session request cannot sign again", async () => {
  for (const rejected of [true, false]) {
    const h = harness();
    let sends = 0;
    let outbound;
    const port = {
      connect: async () => [{ accountId: account }],
      accounts: async () => [{ accountId: account }],
      disconnect: async () => {},
      subscribe: () => () => {},
      buy: async () => {
        sends++;
        throw rejected ? new WalletRejectedError() : new Error("Wallet closed");
      },
    };
    const session = new WalletSession(
      config,
      storage(),
      h.context,
      async () => port,
      () => {},
      (context) => {
        outbound = context.returnUrl;
      },
    );
    await session.connect();
    const pending = h.prepare();
    await assert.rejects(session.submitPurchase(pending));
    assert.equal(outbound, pending.returnUrl);
    if (rejected) {
      assert.equal(h.context.read(), null);
      assert.equal(h.context.lastTransaction().lifecycle.phase, "rejected");
    } else {
      assert.equal(h.context.read().lifecycle.phase, "unknown");
    }
    await assert.rejects(session.submitPurchase(pending));
    assert.equal(sends, 1);
  }
});

test("archival write failure cannot release a pending purchase", () => {
  const saved = storage(),
    h = harness(saved),
    pending = h.prepare();
  h.context.recordPurchaseHash(pending.id, hash);
  const set = saved.setItem;
  saved.setItem = (key, value) => {
    if (key.endsWith(":last")) throw new Error("quota");
    set(key, value);
  };
  assert.throws(() => h.context.settle(pending.id, "confirmed"));
  assert.equal(h.context.read().id, pending.id);
  assert.throws(() => h.prepare());
});

test("late receipt replies cannot settle a newer attempt or restore a stopped view", async () => {
  const h = harness(),
    first = h.prepare();
  h.context.recordPurchaseHash(first.id, hash);
  let resolve;
  h.behavior.receipt = () =>
    new Promise((done) => {
      resolve = done;
    });
  const checking = h.controller.refresh();
  h.context.settle(first.id, "failed");
  const second = h.prepare();
  resolve({ kind: "succeeded" });
  await checking;
  assert.equal(h.context.read().id, second.id);
  assert.equal(h.context.lastTransaction().lifecycle.phase, "failed");
  h.controller.stop();
  const previous = plain(h.controller.state);
  await h.controller.refresh();
  assert.deepEqual(plain(h.controller.state), previous);
});

test("manual recovery never overwrites a wallet-bound hash; candidates can be corrected after failure", async () => {
  const h = harness(),
    pending = h.prepare();
  const other = fixture.steps[0].transaction_hash;
  await h.controller.recover(other);
  assert.equal(h.context.read().transactionSource, "manual");
  h.context.progress(pending.id, "unknown");
  await h.controller.recover(hash);
  assert.equal(h.context.read().transactionHash, hash);
  h.context.recordPurchaseHash(pending.id, hash);
  assert.equal(h.context.read().transactionSource, "wallet");
  await h.controller.recover(other);
  assert.equal(h.context.read().transactionHash, hash);
});

test("recovered old successes and unbound failures cannot unlock a new purchase", async () => {
  rpcResponse = structuredClone(fixture.steps[1].receipt);
  const reads = createPurchaseReads(config);
  const h = harness(),
    pending = h.prepare();
  h.context.recoverHash(pending.id, hash);
  assert.equal((await reads.receipt(h.context.read())).kind, "succeeded");
  h.context.finishPurchase(pending.id, "confirmed");
  const newer = h.context.prepareTransaction(
    account,
    "buy_from_merchant",
    fixture.steps[1].args,
    fixture.final.market.block_height,
  );
  h.context.recoverHash(newer.id, hash);
  await assert.rejects(reads.receipt(h.context.read()), /predates/);
  rpcResponse = structuredClone(fixture.steps[1].receipt);
  const failure = {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: "BB:E_STALE_LISTING" } },
    },
  };
  rpcResponse.status = { Failure: failure };
  rpcResponse.receipts_outcome.find(
    (row) => row.outcome.executor_id === fixture.contract_id,
  ).outcome.status = { Failure: failure };
  assert.equal((await reads.receipt(h.context.read())).kind, "unknown");
  assert.equal(h.context.read().id, newer.id);
});

test("malformed lifecycle metadata fails closed and preserves its raw context", () => {
  for (const mutate of [
    (value) => {
      value.lifecycle = null;
    },
    (value) => {
      value.lifecycle.phase = "confirmed";
    },
    (value) => {
      value.lifecycle.updatedAt = -1;
    },
    (value) => {
      value.transactionSource = "wallet";
    },
    (value) => {
      value.referenceBlockHeight = "-1";
    },
  ]) {
    const h = harness();
    h.prepare();
    const [key, raw] = [...h.saved.values][0];
    const value = JSON.parse(raw);
    mutate(value);
    h.saved.setItem(key, JSON.stringify(value));
    h.controller.sync();
    assert.equal(h.controller.state.phase, "unavailable");
    assert.throws(() => h.prepare());
    assert.equal(h.saved.values.has(key), true);
  }
});

test("legacy unknown attempts cannot re-enter the wallet submission path", async () => {
  const h = harness(),
    pending = h.prepare();
  const [key, raw] = [...h.saved.values][0];
  const legacy = JSON.parse(raw);
  delete legacy.lifecycle;
  h.saved.setItem(key, JSON.stringify(legacy));
  let sends = 0;
  const port = {
    connect: async () => [{ accountId: account }],
    accounts: async () => [{ accountId: account }],
    disconnect: async () => {},
    subscribe: () => () => {},
    buy: async () => {
      sends++;
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
  await assert.rejects(session.submitPurchase(h.context.read()), /not opened/);
  assert.equal(sends, 0);
  assert.equal(h.context.read().id, pending.id);
});

test("an unreadable last-transaction archive blocks a new transaction without deleting evidence", () => {
  const h = harness(),
    pending = h.prepare();
  h.context.settle(pending.id, "not_submitted");
  const [key] = [...h.saved.values][0];
  h.saved.setItem(key, "invalid json");
  h.controller.sync();
  assert.equal(h.controller.state.phase, "unavailable");
  assert.throws(() => h.prepare());
  assert.equal(h.context.read(), null);
  assert.equal(h.saved.getItem(key), "invalid json");
});
