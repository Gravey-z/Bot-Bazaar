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
      contents: `export * from './${entry}'; export {RegistrationNotOpenedError} from './apps/web/src/app/registration-reader.ts';`,
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
const {
  RegistrationController,
  registrationStatus,
  RegistrationNotOpenedError,
} = await load("apps/web/src/app/registration.ts", "registration");
const { WalletContextStore } = await load(
  "apps/web/src/app/wallet-context.ts",
  "journal",
);
const config = {
  networkId: "testnet",
  contractId: fixture.contract_id,
  rpcUrl: "https://test.rpc.fastnear.com",
};
const account = "player-bazaar.testnet";
const time =
  Number(BigInt(fixture.seed.market.block_timestamp_ns) / 1000000n) + 1000;
const txHash = fixture.steps[0].transaction_hash;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
function observation(accountId = account, registered = false) {
  const market = structuredClone(fixture.seed.market);
  return {
    accountId,
    market,
    player: {
      ...market,
      data: registered
        ? {
            account_id: accountId,
            gold: "64",
            inventory: { crystal: "9", wood: "0", herb: "0", iron: "0" },
          }
        : null,
    },
    receivedAt: time,
  };
}
function harness() {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const journal = new WalletContextStore(
    config,
    storage,
    "http://127.0.0.1:4200/",
    () => crypto.randomUUID(),
    () => time,
  );
  const calls = { sends: 0, reads: 0 };
  const behavior = {
    read: async (id) => observation(id),
    receipt: async () => ({ kind: "pending" }),
    send: async () => ({ transaction: { hash: txHash } }),
  };
  const controller = new RegistrationController(
    {
      read: async (id) => {
        calls.reads++;
        return behavior.read(id);
      },
      receipt: (context) => behavior.receipt(context),
    },
    journal,
    async (context) => {
      calls.sends++;
      assert.equal(journal.read()?.id, context.id);
      return behavior.send(context);
    },
    () => {},
    () => {},
    () => time,
  );
  return { controller, journal, storage, calls, behavior };
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

test("registration eligibility derives from finalized player, pause, capacity and reserved roles", () => {
  const value = observation();
  assert.equal(registrationStatus(value), "eligible");
  value.market.data.registered_player_count =
    value.market.data.limits.max_players;
  assert.equal(registrationStatus(value), "full");
  value.market.data.paused = true;
  assert.equal(registrationStatus(value), "paused");
  value.accountId = fixture.contract_id;
  assert.equal(registrationStatus(value), "reserved");
  for (const merchant of value.market.data.merchants) {
    value.accountId = merchant.controller_account_id;
    assert.equal(registrationStatus(value), "reserved");
  }
  value.player.data = observation(account, true).player.data;
  assert.equal(registrationStatus(value), "registered");
});

test("already registered players show actual gold and cannot request another grant", async () => {
  const h = harness();
  h.behavior.read = async (id) => observation(id, true);
  h.controller.setAccount(account);
  await settle();
  assert.equal(h.controller.state.status, "registered");
  assert.equal(h.controller.state.observation.player.data.gold, "64");
  await h.controller.register();
  assert.equal(h.calls.sends, 0);
});

test("registration rechecks eligibility and persists intent before one wallet call", async () => {
  const h = harness();
  h.controller.setAccount(account);
  await settle();
  await Promise.all([h.controller.register(), h.controller.register()]);
  assert.equal(h.calls.sends, 1);
  assert.equal(h.journal.read().transactionHash, txHash);
  assert.equal(h.controller.state.attempt, "unknown");
  await h.controller.register();
  await h.controller.refresh();
  assert.equal(h.calls.sends, 1);
});

for (const [name, change] of [
  [
    "capacity filled",
    (value) => {
      value.market.data.registered_player_count =
        value.market.data.limits.max_players;
    },
  ],
  [
    "paused market",
    (value) => {
      value.market.data.paused = true;
    },
  ],
  [
    "another registration",
    (value) => {
      value.player.data = observation(account, true).player.data;
    },
  ],
])
  test(`pre-wallet recheck prevents submission after ${name}`, async () => {
    const h = harness();
    h.controller.setAccount(account);
    await settle();
    h.behavior.read = async (id) => {
      const value = observation(id);
      change(value);
      return advance(value);
    };
    await h.controller.register();
    assert.equal(h.calls.sends, 0);
    assert.equal(h.journal.read(), null);
  });

test("wallet timeout or unclassified rejection preserves unknown work across reload", async () => {
  const h = harness();
  h.behavior.send = async () => {
    throw new Error("<script>private wallet error</script>");
  };
  h.controller.setAccount(account);
  await settle();
  await h.controller.register();
  assert.equal(h.controller.state.attempt, "unknown");
  assert.equal(h.journal.read().call.method, "register_player");
  assert.equal(
    JSON.stringify(h.controller.state).includes("private wallet"),
    false,
  );
  await h.controller.refresh();
  await h.controller.register();
  assert.equal(h.calls.sends, 1);
});

test("finalized player presence resolves registration intent without inventing transaction success", async () => {
  const h = harness();
  h.journal.prepareTransaction(account, "register_player", {});
  h.behavior.read = async (id) => observation(id, true);
  h.controller.setAccount(account);
  await settle();
  assert.equal(h.controller.state.status, "registered");
  assert.equal(h.controller.state.observation.player.data.gold, "64");
  assert.equal(h.journal.read(), null);
  assert.equal(h.calls.sends, 0);
  assert.match(h.controller.state.message, /Already registered/);
});

for (const code of [
  "E_PLAYER_CAPACITY",
  "E_ALREADY_REGISTERED",
  "E_MARKET_PAUSED",
  "E_RESERVED_ACCOUNT",
  "EXECUTION_FAILED",
]) {
  test(`verified final ${code} releases only the registration intent`, async () => {
    const h = harness();
    const pending = h.journal.prepareTransaction(
      account,
      "register_player",
      {},
    );
    h.journal.recordRegistrationHash(pending.id, txHash);
    h.behavior.receipt = async () => ({ kind: "failed", code });
    h.controller.setAccount(account);
    await settle();
    assert.equal(h.journal.read(), null);
    assert.equal(h.controller.state.attempt, "failed");
    assert.equal(h.calls.sends, 0);
    assert.ok(h.controller.state.message.length > 20);
  });
}

test("a purchase intent or another account's registration cannot be cleared by player state", async () => {
  const h = harness();
  const pending = h.journal.prepareTransaction(
    "other.testnet",
    "register_player",
    {},
  );
  h.behavior.read = async (id) => observation(id, true);
  h.controller.setAccount(account);
  await settle();
  assert.deepEqual(plain(h.journal.read()), plain(pending));
  assert.equal(h.controller.state.attempt, "unknown");
});

test("RPC outage, stale data and wrong-player results never enable registration", async () => {
  for (const read of [
    async () => {
      throw new Error("offline");
    },
    async () => ({ ...observation(), receivedAt: time - 16000 }),
    async () => observation("wrong.testnet"),
  ]) {
    const h = harness();
    h.behavior.read = read;
    h.controller.setAccount(account);
    await settle();
    await h.controller.register();
    assert.equal(h.controller.state.status, "unavailable");
    assert.equal(h.calls.sends, 0);
  }
});

test("account switching invalidates a late read and clears the prior player's balances", async () => {
  const h = harness();
  let resolve;
  h.behavior.read = () =>
    new Promise((done) => {
      resolve = done;
    });
  h.controller.setAccount(account);
  h.controller.setAccount(null);
  resolve(observation(account, true));
  await settle();
  assert.equal(h.controller.state.status, "disconnected");
  assert.equal(h.controller.state.observation, null);
});

test("an account switch during preflight prevents opening the original wallet request", async () => {
  const h = harness();
  h.controller.setAccount(account);
  await settle();
  let resolve;
  h.behavior.read = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = h.controller.register();
  h.controller.setAccount(null);
  resolve(observation());
  await pending;
  assert.equal(h.calls.sends, 0);
  assert.equal(h.journal.read(), null);
});

test("once-registered state cannot regress to an available starter grant", async () => {
  const h = harness();
  h.behavior.read = async (id) => observation(id, true);
  h.controller.setAccount(account);
  await settle();
  h.behavior.read = async (id) => observation(id);
  await h.controller.refresh();
  assert.equal(h.controller.state.status, "unavailable");
  await h.controller.register();
  assert.equal(h.calls.sends, 0);
});

test("reader pins market and player views to one final block and validates player identity", async () => {
  const requests = [];
  let wrongPlayer = false;
  const { createRegistrationReads } = await load(
    "apps/web/src/app/registration-reader.ts",
    "reader",
    {
      TextEncoder,
      TextDecoder,
      AbortSignal,
      btoa,
      fetch: async (_url, options) => {
        const request = JSON.parse(options.body);
        requests.push(request);
        let result;
        const block = fixture.seed.finalized_block;
        if (request.method === "status")
          result = { chain_id: "testnet", sync_info: { syncing: false } };
        else if (request.method === "block")
          result = {
            header: {
              hash: block.hash,
              height: block.height,
              timestamp_nanosec: block.timestamp_ns,
            },
          };
        else {
          assert.equal(request.params.block_id, block.hash);
          const data =
            request.params.method_name === "get_market_state"
              ? fixture.seed.market
              : {
                  ...fixture.seed.player,
                  data: wrongPlayer
                    ? observation("wrong.testnet", true).player.data
                    : null,
                };
          result = {
            result: [...Buffer.from(JSON.stringify(data))],
            block_hash: block.hash,
            block_height: block.height,
          };
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        );
      },
    },
  );
  const reads = createRegistrationReads(config, undefined, () => time);
  const value = await reads.read(account);
  assert.equal(value.player.data, null);
  assert.equal(
    value.market.block_height,
    String(fixture.seed.finalized_block.height),
  );
  assert.equal(requests.filter((row) => row.method === "query").length, 2);
  wrongPlayer = true;
  await assert.rejects(reads.read(account), /player identity mismatch/);
});

test("a proven pre-wallet failure clears the registration intent for explicit retry", async () => {
  const h = harness();
  h.behavior.send = async () => {
    throw new RegistrationNotOpenedError();
  };
  h.controller.setAccount(account);
  await settle();
  await h.controller.register();
  assert.equal(h.journal.read(), null);
  assert.equal(h.controller.state.attempt, "failed");
  assert.match(h.controller.state.message, /not submitted/);
});

test("stored registration hashes survive reload and cannot overwrite another transaction identity", () => {
  const h = harness();
  const context = h.journal.prepareTransaction(account, "register_player", {});
  h.journal.recordRegistrationHash(context.id, txHash);
  assert.equal(h.journal.read().transactionHash, txHash);
  assert.throws(() =>
    h.journal.recordRegistrationHash(
      context.id,
      fixture.steps[1].transaction_hash,
    ),
  );
  const saved = h.journal.read();
  h.journal.finishRegistration(saved.id);
  assert.equal(h.journal.read(), null);
});

test("registered player data does not hide an unresolved known-hash transaction", async () => {
  const h = harness();
  const pending = h.journal.prepareTransaction(account, "register_player", {});
  h.journal.recordRegistrationHash(pending.id, txHash);
  h.behavior.read = async (id) => observation(id, true);
  h.controller.setAccount(account);
  await settle();
  assert.equal(h.controller.state.status, "registered");
  assert.equal(h.journal.read().id, pending.id);
  h.behavior.receipt = async () => ({ kind: "succeeded" });
  await h.controller.refresh();
  assert.equal(h.journal.read(), null);
  assert.equal(h.journal.lastTransaction().lifecycle.phase, "confirmed");
});

test("receipt reader verifies the captured registration and rejects wrong signer or receiver", async () => {
  let response = structuredClone(fixture.steps[0].receipt);
  const { createRegistrationReads } = await load(
    "apps/web/src/app/registration-reader.ts",
    "receipts",
    {
      TextEncoder,
      TextDecoder,
      AbortSignal,
      btoa,
      atob,
      fetch: async (_url, options) => {
        const request = JSON.parse(options.body);
        const block = fixture.final.finalized_block;
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
        if (request.method === "tx") {
          assert.equal(request.params.tx_hash, txHash);
          assert.equal(request.params.sender_account_id, account);
          assert.equal(request.params.wait_until, "FINAL");
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
        );
      },
    },
  );
  const h = harness();
  const pending = h.journal.prepareTransaction(account, "register_player", {});
  h.journal.recordRegistrationHash(pending.id, txHash);
  const reads = createRegistrationReads(config);
  assert.equal((await reads.receipt(h.journal.read())).kind, "succeeded");
  for (const field of ["signer_id", "receiver_id"]) {
    response = structuredClone(fixture.steps[0].receipt);
    response.transaction[field] = "other.testnet";
    await assert.rejects(
      reads.receipt(h.journal.read()),
      /provenance mismatch/,
    );
  }
  response = structuredClone(fixture.steps[0].receipt);
  response.transaction.actions[0].FunctionCall.deposit = "1";
  await assert.rejects(reads.receipt(h.journal.read()), /call mismatch/);
  response = structuredClone(fixture.steps[0].receipt);
  const failure = {
    ActionError: {
      index: 0,
      kind: {
        FunctionCallError: {
          ExecutionError: "Smart contract panicked: BB:E_PLAYER_CAPACITY",
        },
      },
    },
  };
  response.status = { Failure: failure };
  response.receipts_outcome.find(
    (row) => row.outcome.executor_id === fixture.contract_id,
  ).outcome.status = { Failure: failure };
  assert.deepEqual(plain(await reads.receipt(h.journal.read())), {
    kind: "failed",
    code: "E_PLAYER_CAPACITY",
  });
});
