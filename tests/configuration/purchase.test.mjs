import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

const fixture = JSON.parse(
  await readFile("tests/fixtures/chain/market.json", "utf8"),
);
async function load(entry, name, globals = {}) {
  const output = await build({
    stdin: {
      contents: `export * from './${entry}'; export {PurchaseNotOpenedError} from './apps/web/src/app/registration-reader.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: name,
    write: false,
  });
  const context = vm.createContext({
    URL,
    crypto,
    setTimeout,
    clearTimeout,
    structuredClone,
    ...globals,
  });
  vm.runInContext(output.outputFiles[0].text, context, {
    filename: `${name}.js`,
  });
  return context[name];
}
const { PurchaseController, quotePurchase, PurchaseNotOpenedError } =
  await load("apps/web/src/app/purchase.ts", "buying");
const { WalletContextStore } = await load(
  "apps/web/src/app/wallet-context.ts",
  "journal",
);
const account = "player-bazaar.testnet";
const config = {
  networkId: "testnet",
  contractId: fixture.contract_id,
  rpcUrl: "https://test.rpc.fastnear.com",
};
const time =
  Number(BigInt(fixture.seed.market.block_timestamp_ns) / 1000000n) + 1000;
const txHash = fixture.steps[1].transaction_hash;
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
function observation(accountId = account) {
  const market = structuredClone(fixture.seed.market);
  const { block_height, block_timestamp_ns, market_revision } = market;
  return {
    accountId,
    market,
    player: {
      block_height,
      block_timestamp_ns,
      market_revision,
      data: {
        account_id: accountId,
        gold: "100",
        inventory: { crystal: "0", wood: "0", herb: "0", iron: "0" },
      },
    },
    receivedAt: time,
  };
}
function quote(value = observation(), quantity = "1") {
  return quotePurchase(value, account, "rex", "crystal", quantity, time);
}
function advance(value) {
  value.market.block_height = (
    BigInt(value.market.block_height) + 1n
  ).toString();
  value.market.market_revision = (
    BigInt(value.market.market_revision) + 1n
  ).toString();
  value.player.block_height = value.market.block_height;
  value.player.market_revision = value.market.market_revision;
  return value;
}
function harness() {
  const values = new Map();
  const context = new WalletContextStore(
    config,
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    "http://127.0.0.1:4200/",
    () => crypto.randomUUID(),
    () => time,
  );
  const calls = { sends: 0, settled: 0, receipts: 0 };
  const behavior = {
    read: async (id) => observation(id),
    receipt: async () => ({ kind: "pending" }),
    send: async () => ({ transaction: { hash: txHash } }),
  };
  const controller = new PurchaseController(
    {
      read: (id) => behavior.read(id),
      receipt: (pending) => {
        calls.receipts++;
        return behavior.receipt(pending);
      },
    },
    context,
    async (pending) => {
      calls.sends++;
      assert.equal(context.read()?.id, pending.id);
      return behavior.send(pending);
    },
    () => {},
    () => {},
    () => {
      calls.settled++;
    },
    () => time,
  );
  return { controller, context, behavior, calls };
}
async function ready(h) {
  h.controller.setAccount(account);
  await settle();
}

test("repeated degraded read retries preserve the original spend and never open another wallet request", async () => {
  const h = harness();
  await ready(h);
  await h.controller.review();
  await h.controller.confirm();
  const original = h.context.read();
  assert.equal(h.calls.sends, 1);
  h.behavior.read = async () => {
    throw new Error("private RPC error");
  };
  h.behavior.receipt = async () => {
    throw new Error("unavailable");
  };
  for (let retry = 0; retry < 3; retry++) await h.controller.refresh();
  assert.equal(h.context.read().id, original.id);
  assert.equal(h.context.read().transactionHash, original.transactionHash);
  assert.equal(h.controller.state.quote, null);
  assert.doesNotMatch(h.controller.state.message, /private RPC/);
  h.behavior.read = async (id) => observation(id);
  await h.controller.refresh();
  await h.controller.confirm();
  assert.equal(h.calls.sends, 1);
  assert.equal(h.context.read().id, original.id);
});

test("purchase quote uses listed stock and exact total/version, without signing", () => {
  const value = quote(observation(), "12");
  assert.deepEqual(plain(value.args), {
    merchant_id: "rex",
    resource: "crystal",
    quantity: "12",
    max_total_price: "48",
    listing_version: "1",
  });
  assert.equal(value.stock, "15");
  assert.equal(value.unitPrice, "4");
  assert.equal(value.gold, "100");
});
for (const quantity of [
  "",
  "0",
  "-1",
  "1.5",
  "1e2",
  "01",
  "+1",
  " 1",
  "1 ",
  "101",
  "99999999999999999999",
  "NaN",
]) {
  test(`reject invalid quantity ${JSON.stringify(quantity)}`, () =>
    assert.throws(() => quote(observation(), quantity), /whole quantity/));
}
for (const [name, change, error] of [
  [
    "unregistered player",
    (v) => {
      v.player.data = null;
    },
    /Register/,
  ],
  [
    "wrong account",
    (v) => {
      v.player.data.account_id = "other.testnet";
    },
    /Register/,
  ],
  [
    "paused",
    (v) => {
      v.market.data.paused = true;
    },
    /paused/,
  ],
  [
    "inactive",
    (v) => {
      v.market.data.merchants[0].listings[0].active = false;
    },
    /not currently listed/,
  ],
  [
    "sold out",
    (v) => {
      v.market.data.merchants[0].listings[0].quantity = "0";
    },
    /stock/,
  ],
  [
    "insufficient gold",
    (v) => {
      v.player.data.gold = "3";
    },
    /enough virtual gold/,
  ],
  [
    "buyer inventory cap",
    (v) => {
      v.player.data.inventory.crystal = "1000";
    },
    /balance limit/,
  ],
  [
    "seller gold cap",
    (v) => {
      v.market.data.merchants[0].gold = "1000000";
    },
    /balance limit/,
  ],
  [
    "stale receipt time",
    (v) => {
      v.receivedAt -= 16000;
    },
    /out of date/,
  ],
  [
    "stale chain time",
    (v) => {
      v.market.block_timestamp_ns = "1";
    },
    /out of date/,
  ],
  [
    "mixed block",
    (v) => {
      v.player.block_height = "1";
    },
    /do not match/,
  ],
])
  test(`quote blocks ${name}`, () => {
    const value = observation();
    change(value);
    assert.throws(() => quote(value), error);
  });

test("buying requires review, persists the exact intent, and serializes confirmation", async () => {
  const h = harness();
  await ready(h);
  await h.controller.confirm();
  assert.equal(h.calls.sends, 0);
  h.controller.edit("rex", "crystal", "12");
  await h.controller.review();
  assert.equal(h.calls.sends, 0);
  assert.equal(h.controller.state.phase, "review");
  await Promise.all([h.controller.confirm(), h.controller.confirm()]);
  assert.equal(h.calls.sends, 1);
  assert.equal(h.context.read().call.args.max_total_price, "48");
  assert.equal(h.context.read().transactionHash, txHash);
  assert.equal(h.controller.state.phase, "unknown");
  await h.controller.review();
  await h.controller.confirm();
  assert.equal(h.calls.sends, 1);
});

test("editing invalidates review; version/price changes require another confirmation", async () => {
  const h = harness();
  await ready(h);
  await h.controller.review();
  h.controller.edit("rex", "crystal", "2");
  await h.controller.confirm();
  assert.equal(h.calls.sends, 0);
  await h.controller.review();
  h.behavior.read = async () => {
    const value = observation();
    value.market.data.merchants[0].listings[0].unit_price = "5";
    value.market.data.merchants[0].listings[0].version = "2";
    return advance(value);
  };
  await h.controller.confirm();
  assert.equal(h.calls.sends, 0);
  assert.equal(h.controller.state.phase, "editing");
  assert.equal(h.controller.state.reviewed, null);
  assert.equal(h.controller.state.quote.args.max_total_price, "10");
  await h.controller.review();
  await h.controller.confirm();
  assert.equal(h.calls.sends, 1);
  assert.equal(h.context.read().call.args.listing_version, "2");
});

test("unknown wallet outcomes survive balance changes, reload-style reads and disconnect", async () => {
  const h = harness();
  h.behavior.send = async () => {
    throw new Error("<script>private transport error</script>");
  };
  await ready(h);
  await h.controller.review();
  await h.controller.confirm();
  const pending = h.context.read();
  h.behavior.read = async () => {
    const value = observation();
    value.player.data.gold = "96";
    value.player.data.inventory.crystal = "1";
    return advance(value);
  };
  await h.controller.refresh();
  assert.equal(h.controller.state.phase, "unknown");
  assert.deepEqual(plain(h.context.read()), plain(pending));
  assert.equal(
    JSON.stringify(h.controller.state).includes("private transport"),
    false,
  );
  h.controller.setAccount(null);
  await ready(h);
  await h.controller.confirm();
  assert.equal(h.calls.sends, 1);
});

for (const kind of ["succeeded", "failed"])
  test(`only a verified final ${kind} receipt releases a purchase`, async () => {
    const h = harness();
    const pending = h.context.prepareTransaction(
      account,
      "buy_from_merchant",
      quote().args,
    );
    h.context.recordPurchaseHash(pending.id, txHash);
    h.behavior.receipt = async () => ({ kind, code: "EXECUTION_FAILED" });
    await ready(h);
    assert.equal(h.context.read(), null);
    assert.equal(h.controller.state.phase, kind);
    assert.equal(h.calls.settled, 1);
    assert.equal(h.calls.sends, 0);
  });

test("a request proven not to have opened can be explicitly reviewed again", async () => {
  const h = harness();
  h.behavior.send = async () => {
    throw new PurchaseNotOpenedError();
  };
  await ready(h);
  await h.controller.review();
  await h.controller.confirm();
  assert.equal(h.context.read(), null);
  assert.equal(h.controller.state.reviewed, null);
  assert.equal(h.controller.state.phase, "editing");
  await h.controller.confirm();
  assert.equal(h.calls.sends, 1);
});

test("registration or another account's intent blocks buying and cannot be cleared", async () => {
  for (const [id, method, args] of [
    [account, "register_player", {}],
    ["other.testnet", "buy_from_merchant", quote().args],
  ]) {
    const h = harness();
    const pending = h.context.prepareTransaction(id, method, args);
    await ready(h);
    await h.controller.review();
    await h.controller.confirm();
    assert.equal(h.controller.state.phase, "unknown");
    assert.deepEqual(plain(h.context.read()), plain(pending));
    assert.equal(h.calls.sends, 0);
  }
});

test("an account switch during preflight invalidates the old confirmation", async () => {
  const h = harness();
  await ready(h);
  await h.controller.review();
  let resolve;
  h.behavior.read = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.controller.confirm();
  h.controller.setAccount(null);
  resolve(observation());
  await pending;
  assert.equal(h.calls.sends, 0);
  assert.equal(h.context.read(), null);
  assert.equal(h.controller.state.quote, null);
});

test("RPC failure cannot invent a quote or enable confirmation", async () => {
  const h = harness();
  h.behavior.read = async () => {
    throw new Error("offline");
  };
  await ready(h);
  await h.controller.review();
  await h.controller.confirm();
  assert.equal(h.controller.state.quote, null);
  assert.equal(h.calls.sends, 0);
});

test("purchase receipt reader checks the captured purchase's exact original terms", async () => {
  let response = structuredClone(fixture.steps[1].receipt);
  const { createPurchaseReads } = await load(
    "apps/web/src/app/registration-reader.ts",
    "receipts",
    {
      TextEncoder,
      TextDecoder,
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
              : response;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        );
      },
    },
  );
  const h = harness();
  const pending = h.context.prepareTransaction(
    account,
    "buy_from_merchant",
    fixture.steps[1].args,
  );
  h.context.recordPurchaseHash(pending.id, txHash);
  const reads = createPurchaseReads(config);
  assert.equal((await reads.receipt(h.context.read())).kind, "succeeded");
  response.transaction.signer_id = "other.testnet";
  await assert.rejects(reads.receipt(h.context.read()), /provenance mismatch/);
  response = structuredClone(fixture.steps[1].receipt);
  response.transaction.actions[0].FunctionCall.args = btoa(
    JSON.stringify({ ...fixture.steps[1].args, quantity: "1" }),
  );
  await assert.rejects(reads.receipt(h.context.read()), /call mismatch/);
});
