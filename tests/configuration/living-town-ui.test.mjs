import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { build } from "esbuild";
import {
  createLivingTownCall,
  livingTownCommandDigest,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  createLivingTownCompletionCall,
  livingTownCompletionWalletRequest,
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
      "export * from './apps/web/src/app/living-town-controller.ts'; export * from './apps/web/src/app/living-town-port.ts'; export * from './apps/web/src/app/living-town-profile.ts'; export * from './apps/web/src/app/living-town-transactions.ts'; export {LivingTownIdentityError} from './packages/chain/dist/index.js';",
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
  LivingTownIdentityError,
  LivingTownTransactions,
} = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
);
const copy = (v) => structuredClone(v);
const completionCapture = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-completion-sandbox.json",
    "utf8",
  ),
);
function claimHarness({
  send = async () => ({
    transaction: { hash: completionCapture.steps[1].transaction_hash },
  }),
  storage = memoryStorage(),
  lock = async (_name, work) => work(),
} = {}) {
  const step = completionCapture.steps[1],
    foundation = step.foundation;
  const identity = {
    deployment: foundation.deployment,
    codeHash: step.account.code_hash,
    ownerId: foundation.data.owner_account_id,
    operatorId: foundation.data.operator_account_id,
    controllers: foundation.data.merchant_controllers,
  };
  const job = copy(completionCapture.before.shops[0].jobs.data.items[0]);
  let timestamp = step.block.header.timestamp_nanosec,
    receiptAvailable = true;
  const client = {
    identity,
    finalized: async () => ({
      block: { height: step.reference_block_height, timestampNs: timestamp },
      getPlayer: async () => ({
        market_revision: completionCapture.before.town.market_revision,
        data: { shop_id: "4" },
      }),
      getProductionJobs: async () => ({ data: { items: [job] } }),
    }),
    completionReceipt: async (proof) => {
      if (!receiptAvailable) throw Error("receipt unavailable");
      // Controlled receipt-client result for an owner journal. The captured
      // permissionless settlement was signed by a keeper, verified separately
      // using its original signer; this is not an actual owner wallet capture.
      assert.equal(proof.signerId, job.owner.account_id);
      return verifyLivingTownCompletionReceipt(
        step.receipt,
        { ...proof, signerId: step.signer_id },
        async () => block(step),
      );
    },
  };
  return {
    job,
    client,
    storage,
    step,
    account: job.owner.account_id,
    setTime(v) {
      timestamp = v;
    },
    offline() {
      receiptAvailable = false;
    },
    online() {
      receiptAvailable = true;
    },
    journal: () =>
      new LivingTownTransactions(client, storage, send, lock, () => id),
  };
}

test("wallet Claim preserves one durable non-command attempt across unknown handoff, reload and receipt outage", async () => {
  let signatures = 0;
  const h = claimHarness({
    send: async (_account, call) => {
      signatures++;
      assert.equal(call.method, "complete_production");
      assert.deepEqual(Object.keys(call.args), ["job_id"]);
      throw Error("lost wallet result");
    },
  });
  let journal = h.journal();
  const attempt = await journal.prepare(h.account, "complete_production", {
    job_id: "1",
  });
  assert.match(describeTownAttempt(attempt), /Claim.*#1/);
  await journal.submit(attempt.id);
  assert.equal((await journal.read()).phase, "unknown");
  journal = h.journal();
  assert.equal((await journal.restore()).digest, attempt.digest);
  assert.equal(await journal.refresh(), null);
  await assert.rejects(
    journal.prepare(h.account, "complete_production", { job_id: "1" }),
  );
  await assert.rejects(journal.submit(attempt.id));
  await journal.recoverHash(attempt.id, h.step.transaction_hash);
  h.offline();
  await assert.rejects(journal.refresh(), /unavailable/);
  assert.equal((await journal.read()).transactionHash, h.step.transaction_hash);
  h.online();
  const status = await journal.refresh();
  assert.equal(status.kind, "succeeded");
  assert.equal(status.result.data.outcome.job.status, "completed");
  assert.equal(await journal.read(), null);
  assert.equal((await journal.last()).phase, "confirmed");
  assert.equal(signatures, 1);
});

test("Claim admission rejects early, foreign and settled jobs; two tabs share the command journal lock", async () => {
  let queue = Promise.resolve(),
    signatures = 0;
  const lock = (_name, work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const h = claimHarness({
    lock,
    send: async () => {
      signatures++;
      return {
        transaction: { hash: completionCapture.steps[1].transaction_hash },
      };
    },
  });
  const a = h.journal(),
    b = h.journal();
  h.setTime((BigInt(h.job.ready_at_ns) - 1n).toString());
  await assert.rejects(
    a.prepare(h.account, "complete_production", { job_id: "1" }),
  );
  assert.equal(await a.read(), null);
  h.setTime(h.job.ready_at_ns);
  await assert.rejects(
    a.prepare("other.testnet", "complete_production", { job_id: "1" }),
  );
  await assert.rejects(
    a.prepare(h.account, "complete_production", { job_id: "999" }),
  );
  const prepared = await a.prepare(h.account, "complete_production", {
    job_id: "1",
  });
  await assert.rejects(b.prepare(h.account, "register_player", {}));
  const results = await Promise.allSettled([
    a.submit(prepared.id),
    b.submit(prepared.id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(signatures, 1);
  await b.refresh();
  assert.equal(await a.read(), null);
  h.job.status = "completed";
  // The real reader filters completed rows; simulate the running filter here.
  h.client.finalized = async () => ({
    block: { height: "100", timestampNs: h.job.ready_at_ns },
    getPlayer: async () => ({ market_revision: "1", data: { shop_id: "4" } }),
    getProductionJobs: async () => ({ data: { items: [] } }),
  });
  await assert.rejects(
    a.prepare(h.account, "complete_production", { job_id: "1" }),
  );
  const request = livingTownCompletionWalletRequest(
    h.client.identity.deployment.contract_id,
    h.account,
    createLivingTownCompletionCall({ job_id: "1" }),
  );
  assert.deepEqual(request.actions[0].params.args, { job_id: "1" });
  assert.equal(request.actions[0].params.deposit, "0");
  assert.equal(request.actions[0].params.methodName, "complete_production");
});

test("owner Claim is available during pause but needs fresh finalized readiness and never credits output optimistically", async () => {
  const h = harness();
  h.setStage(2);
  h.setAccounts([f.player_id]);
  const job = {
    ...copy(completionCapture.before.shops[0].jobs.data.items[0]),
    owner: { kind: "player", account_id: f.player_id },
  };
  const originalRead = h.port.read;
  let timestamp = (BigInt(job.ready_at_ns) - 1n).toString(),
    paused = true,
    signatures = 0;
  h.port.read = async (account) => {
    const o = await originalRead(account);
    return {
      ...o,
      town: { ...o.town, paused },
      production: { items: [job], historyGap: false },
      chainTimestampNs: timestamp,
    };
  };
  h.port.prepare = async (account, method, args) => ({
    id,
    accountId: account,
    call: createLivingTownCompletionCall(args),
    digest: "a".repeat(64),
    referenceBlockHeight: "1",
    phase: "prepared",
    transactionHash: null,
    hashSource: null,
  });
  h.port.submit = async () => {
    signatures++;
  };
  await h.c.start();
  assert.equal(h.c.canTransact, false);
  assert.equal(h.c.canClaim, true);
  await h.c.act("complete_production", { job_id: "1" });
  assert.equal(signatures, 0);
  timestamp = job.ready_at_ns;
  await h.c.refresh();
  const gold = h.c.state.observation.ledger.gold.held;
  await h.c.act("complete_production", { job_id: "1" });
  assert.equal(signatures, 1);
  assert.equal(h.c.state.observation.ledger.gold.held, gold);
  assert.equal(h.c.state.observation.production.items[0].status, "running");
  // A stale local clock disables signing and never declares completion.
  paused = false;
  h.advanceClock(30001);
  assert.equal(h.c.canClaim, false);
  h.c.stop();
});
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

function receiptRpc(transform = ({ data }) => data) {
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
        else if (p.method_name === "get_shop") {
          snapshot = copy(f.final_views.get_shop);
          const args = JSON.parse(
            Buffer.from(p.args_base64, "base64").toString(),
          );
          if (args.shop_id !== "4")
            snapshot.data = copy(
              f.initial_town.data.npc_shops.find(
                (s) => s.shop_id === args.shop_id,
              ) ?? null,
            );
        } else if (p.method_name === "get_shop_inventory")
          snapshot = copy(f.final_views.get_shop_inventory);
        else if (p.method_name === "get_production_jobs")
          snapshot = {
            ...copy(f.final_views.get_town),
            data: {
              items: [],
              next_after_id: null,
              has_more: false,
              history_gap: false,
              pruned_through: "0",
            },
          };
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
    data = transform({ method, params: p, data });
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

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
};
const sandboxProfile = () => ({
  ...copy(named),
  public: { ...named.public, contractId: f.contract_id },
  identity: copy(identity),
});
const noWallet = async () => {
  throw Error("Unexpected wallet request");
};

test("reconnect and fresh controller restore the same finalized shop without signing or granting again", async () => {
  const h = harness();
  h.setStage(4);
  h.setAccounts([f.player_id]);
  await h.c.start();
  const original = copy(h.c.state.observation);
  await h.c.disconnect();
  assert.equal(h.c.state.observation.ledger, null);
  await h.c.connect();
  assert.deepEqual(h.c.state.observation, original);
  h.c.stop();
  const restored = new LivingTownController(h.port, () => {});
  await restored.start();
  assert.equal(restored.state.observation.shop.shop_id, "4");
  assert.equal(restored.state.observation.ledger.gold.held, "96");
  assert.deepEqual(h.calls.sent, []);
  restored.stop();
});

test("wallet events clear the old manager immediately and the newest account check wins", async () => {
  const h = harness();
  h.setStage(4);
  h.setAccounts([f.player_id]);
  await h.c.start();
  const old = deferred(),
    latest = deferred();
  let checks = 0;
  h.port.accounts = () => (++checks === 1 ? old.promise : latest.promise);
  const first = h.c.syncAccounts();
  assert.equal(h.c.state.observation, null);
  assert.equal(h.c.state.ownershipUrl, null);
  assert.equal(h.c.canTransact, false);
  const second = h.c.syncAccounts();
  latest.resolve([{ accountId: "other.testnet" }]);
  await second;
  assert.equal(h.c.state.accountId, "other.testnet");
  assert.equal(h.c.state.observation.ledger, null);
  old.resolve([{ accountId: f.player_id }]);
  await first;
  assert.equal(h.c.state.accountId, "other.testnet");
  assert.equal(h.c.state.observation.shop, null);
  h.c.stop();
});

test("late account checks cannot undo disconnect or restore a destroyed document", async () => {
  const h = harness();
  h.setStage(4);
  h.setAccounts([f.player_id]);
  await h.c.start();
  const wait = deferred();
  h.port.accounts = () => wait.promise;
  const checking = h.c.syncAccounts();
  await h.c.disconnect();
  wait.resolve([{ accountId: f.player_id }]);
  await checking;
  assert.equal(h.c.state.accountId, null);
  assert.equal(h.c.state.observation.ledger, null);
  const next = deferred();
  h.port.accounts = () => next.promise;
  const pending = h.c.syncAccounts();
  h.c.stop();
  const stopped = copy(h.c.state);
  next.resolve([{ accountId: f.player_id }]);
  await pending;
  assert.deepEqual(h.c.state, stopped);
});

test("account switch aborts old reads and late inventory cannot enter another player's manager", async () => {
  const h = harness();
  h.setStage(4);
  h.setAccounts([f.player_id, "other.testnet"]);
  await h.c.start();
  const read = h.port.read,
    old = await read(f.player_id),
    wait = deferred();
  let oldSignal;
  h.port.read = async (_account, signal) => {
    oldSignal = signal;
    return wait.promise;
  };
  const refreshing = h.c.refresh();
  await h.c.chooseAccount("other.testnet");
  assert(oldSignal.aborted);
  assert.equal(h.c.state.observation, null);
  const restored = deferred();
  h.onState((s) => {
    if (s.accountId === "other.testnet" && s.observation) restored.resolve();
  });
  h.port.read = read;
  wait.resolve(old);
  await refreshing;
  await restored.promise;
  assert.equal(h.c.state.observation.accountId, "other.testnet");
  assert.equal(h.c.state.observation.ledger, null);
  await h.c.chooseAccount(f.player_id);
  assert.equal(h.c.state.observation.ledger.gold.held, "96");
  assert.deepEqual(h.calls.sent, []);
  h.c.stop();
});

test("network and deployment mismatch remove owned projections while retaining the original pending command", async () => {
  for (const reason of ["network", "genesis", "code hash", "config"]) {
    const h = harness();
    h.setStage(1);
    h.setAccounts([f.player_id]);
    await h.port.prepare(f.player_id, "create_shop", { name: "Original Shop" });
    await h.c.start();
    const pending = copy(h.c.state.pending);
    h.port.read = async () => {
      throw new LivingTownIdentityError(reason);
    };
    await h.c.refresh();
    assert.equal(h.c.state.accountId, null);
    assert.equal(h.c.state.observation, null);
    assert.equal(h.c.state.ownershipUrl, null);
    assert.deepEqual(h.c.state.pending, pending);
    await h.c.resumePrepared();
    assert.deepEqual(h.calls.sent, []);
    h.c.stop();
  }
});

test("another account cannot resume the original request and confirmation cannot give it the original owner's shop", async () => {
  const h = harness();
  h.setStage(1);
  h.setAccounts([f.player_id]);
  await h.port.prepare(f.player_id, "create_shop", { name: "Original Shop" });
  await h.c.start();
  h.setAccounts(["other.testnet"]);
  await h.c.syncAccounts();
  await h.c.resumePrepared();
  assert.deepEqual(h.calls.sent, []);
  await h.c.checkTransaction();
  assert.match(
    h.c.state.message,
    new RegExp(f.player_id.replaceAll(".", "\\.")),
  );
  assert.equal(h.c.state.observation.shop, null);
  assert.equal(h.c.state.observation.ledger, null);
  h.setAccounts([f.player_id]);
  await h.c.syncAccounts();
  assert.equal(h.c.state.observation.shop.shop_id, "4");
  assert.deepEqual(h.calls.sent, []);
  h.c.stop();
});

test("prepared recovery requires a fresh observation and wallet events reread another tab's journal", async () => {
  const h = harness();
  h.setStage(1);
  h.setAccounts([f.player_id]);
  await h.c.start();
  await h.port.prepare(f.player_id, "create_shop", { name: "Original Shop" });
  await h.c.syncAccounts();
  assert(h.c.state.pending);
  h.advanceClock(30001);
  await h.c.resumePrepared();
  assert.deepEqual(h.calls.sent, []);
  await h.c.refresh();
  await h.c.resumePrepared();
  assert.equal(h.calls.sent.length, 1);
  h.c.stop();
});

test("pending journals isolate fresh deployments and fail closed on same-address identity replacement", async () => {
  const storage = memoryStorage();
  const make = (i) =>
    new LivingTownTransactions(
      {
        identity: i,
        finalized: async () => ({
          block: {
            height: "1",
            timestampNs: (
              BigInt(f.steps[1].args.command.valid_until_ns) - 1n
            ).toString(),
          },
          getCommand: async (_account, seq) => ({
            data: { kind: "not_applied", next_sequence: seq },
          }),
        }),
      },
      storage,
      noWallet,
      async (_key, work) => work(),
      () => id,
    );
  const first = make(identity);
  await first.prepare(f.player_id, "create_shop", f.steps[1].args);
  const otherIdentity = copy(identity);
  otherIdentity.deployment.contract_id = "another-town.testnet";
  const other = make(otherIdentity);
  assert.equal(await other.restore(), null);
  await other.prepare("other.testnet", "create_shop", f.steps[1].args);
  assert.equal((await first.restore()).accountId, f.player_id);
  assert.equal((await other.restore()).accountId, "other.testnet");
  const before = [...storage.map];
  for (const change of [
    (i) => (i.codeHash = "11111111111111111111111111111111"),
    (i) => (i.deployment.config_version = "2"),
  ]) {
    const replacement = copy(identity);
    change(replacement);
    await assert.rejects(async () => make(replacement).restore());
  }
  assert.deepEqual([...storage.map], before);
});

test("a port freezes its deployment and propagates read cancellation into RPC fetch", async () => {
  const profile = sandboxProfile();
  const port = createLivingTownPort(
    profile,
    memoryStorage(),
    receiptRpc(),
    noWallet,
  );
  profile.public.rpcUrl = "https://unreviewed.example";
  profile.identity.codeHash = "11111111111111111111111111111111";
  const value = await port.read(f.player_id);
  assert.equal(value.ledger.gold.held, "96");
  let signalSeen;
  const abort = new AbortController();
  const cancellable = createLivingTownPort(
    sandboxProfile(),
    memoryStorage(),
    async (_url, options) => {
      signalSeen = options.signal;
      return new Promise((_resolve, reject) =>
        signalSeen.addEventListener("abort", () => reject(Error("cancelled")), {
          once: true,
        }),
      );
    },
    noWallet,
  );
  const pending = cancellable.read(f.player_id, abort.signal);
  abort.abort();
  await assert.rejects(pending);
  assert(signalSeen.aborted);
});

test("actual RPC admission rejects a changed network, genesis, code hash and snapshot deployment", async () => {
  for (const mutate of [
    ({ method, data }) =>
      method === "status" ? { ...data, chain_id: "mainnet" } : data,
    ({ method, params, data }) =>
      method === "block" && params.block_id === 7
        ? {
            header: {
              ...data.header,
              hash: f.steps[0].block.header.hash,
            },
          }
        : data,
    ({ method, params, data }) =>
      method === "query" && params.request_type === "view_account"
        ? { ...data, code_hash: "11111111111111111111111111111111" }
        : data,
    ({ method, params, data }) => {
      if (method === "query" && params.method_name === "get_town") {
        const snapshot = JSON.parse(Buffer.from(data.result).toString());
        snapshot.deployment.config_version = "2";
        return { ...data, result: [...Buffer.from(JSON.stringify(snapshot))] };
      }
      return data;
    },
  ]) {
    const port = createLivingTownPort(
      sandboxProfile(),
      memoryStorage(),
      receiptRpc(mutate),
      noWallet,
    );
    await assert.rejects(port.read(f.player_id), LivingTownIdentityError);
  }
});

function directoryRpc() {
  const calls = [];
  const rpc = receiptRpc(({ method, params, data }) => {
    if (method !== "query" || params.request_type !== "call_function")
      return data;
    const args = JSON.parse(
      Buffer.from(params.args_base64, "base64").toString(),
    );
    calls.push({ method: params.method_name, block: params.block_id, args });
    const snapshot = JSON.parse(Buffer.from(data.result).toString());
    if (params.method_name === "get_town") snapshot.data.next_shop_id = "1004";
    if (params.method_name === "get_player") snapshot.data.shop_id = "1003";
    if (params.method_name === "get_shop" && BigInt(args.shop_id) >= 4n) {
      snapshot.data = {
        ...copy(f.final_views.get_shop.data),
        shop_id: args.shop_id,
      };
    }
    return { ...data, result: [...Buffer.from(JSON.stringify(snapshot))] };
  });
  return { rpc, calls };
}

test("bounded read-only directory pins pages and ownership restoration is independent of facade or page slots", async () => {
  const { rpc, calls } = directoryRpc();
  const port = createLivingTownPort(
    sandboxProfile(),
    memoryStorage(),
    rpc,
    noWallet,
  );
  const first = await port.browse(null);
  assert.deepEqual(
    first.shops.map((s) => s.shop_id),
    ["4", "5", "6", "7", "8", "9", "10", "11", "12"],
  );
  assert(first.nextCursor);
  assert.equal(calls.filter((c) => c.method === "get_shop").length, 12);
  const second = await port.browse(first.nextCursor);
  assert.deepEqual(
    second.shops.map((s) => s.shop_id),
    Array.from({ length: 12 }, (_, i) => String(i + 13)),
  );
  assert.equal(new Set(calls.map((c) => c.block)).size, 1);
  assert.equal(
    calls.filter((c) => c.method === "get_shop_inventory").length,
    0,
  );
  await assert.rejects(port.browse(first.nextCursor), /cursor mismatch/);
  const owner = await port.read(f.player_id);
  assert.equal(owner.shop.shop_id, "1003");
  assert.equal(owner.ledger.gold.held, "96");
  assert.equal(owner.ledger.actor.account_id, f.player_id);
  const newPort = createLivingTownPort(
    sandboxProfile(),
    memoryStorage(),
    rpc,
    noWallet,
  );
  await assert.rejects(newPort.browse(second.nextCursor), /cursor mismatch/);
  await newPort.browse(null);
  await assert.rejects(newPort.browse(first.nextCursor), /cursor mismatch/);
  const now = Date.now;
  try {
    Date.now = () => now() + 31000;
    await assert.rejects(port.browse(second.nextCursor), /expired/);
  } finally {
    Date.now = now;
  }
});

test("directory completion, cancellation and expiry never replace the owner's inventory", async () => {
  const h = harness();
  h.setStage(4);
  h.setAccounts([f.player_id]);
  await h.c.start();
  const owner = copy(h.c.state.observation),
    wait = deferred();
  let signal;
  h.port.browse = (_cursor, s) => {
    signal = s;
    return wait.promise;
  };
  const browsing = h.c.browseShops();
  h.setAccounts(["other.testnet"]);
  await h.c.syncAccounts();
  assert(signal.aborted);
  wait.resolve({
    shops: [owner.shop],
    nextCursor: null,
    receivedAt: Date.now(),
  });
  await browsing;
  assert.equal(h.c.state.directory, null);
  assert.equal(h.c.state.observation.ledger, null);
  h.port.browse = async () => {
    throw Error("expired");
  };
  await h.c.browseShops(true);
  assert.match(h.c.state.directoryMessage, /expired/);
  assert.equal(h.c.state.observation.ledger, null);
  h.c.stop();
  const port = createLivingTownPort(
    sandboxProfile(),
    memoryStorage(),
    receiptRpc(),
    noWallet,
  );
  const only = await port.browse(null);
  assert.equal(only.nextCursor, null);
  assert.equal(only.shops.length, 1);
});

test("explicit account selection wins an overlapping journal check without leaving reads blocked", async () => {
  const h = harness();
  h.setStage(4);
  h.setAccounts([f.player_id, "other.testnet"]);
  await h.c.start();
  const wait = deferred(),
    entered = deferred();
  h.port.pending = async () => {
    entered.resolve();
    return wait.promise;
  };
  const checking = h.c.syncAccounts();
  await entered.promise;
  await h.c.chooseAccount("other.testnet");
  assert.equal(h.c.state.observation.accountId, "other.testnet");
  wait.resolve(null);
  await checking;
  assert.equal(h.c.state.accountId, "other.testnet");
  assert.equal(h.c.state.phase, "ready");
  h.c.stop();
});

test("focus and wallet/journal storage events request revalidation and unsubscribe removes listeners", async () => {
  const previous = globalThis.window,
    target = new EventTarget();
  globalThis.window = target;
  let changed = 0,
    unsubscribed = 0,
    walletChanged;
  try {
    const port = createLivingTownPort(
      sandboxProfile(),
      memoryStorage(),
      receiptRpc(),
      async () => ({
        accounts: async () => [],
        subscribe: (cb) => {
          walletChanged = cb;
          return () => {
            unsubscribed++;
          };
        },
      }),
    );
    const stop = port.subscribe(() => {
      changed++;
    });
    await port.accounts();
    target.dispatchEvent(new Event("focus"));
    walletChanged();
    const storage = (key) =>
      target.dispatchEvent(Object.assign(new Event("storage"), { key }));
    storage("meteor-wallet:meteor-account-data");
    storage("bot-bazaar:living-town:journal:1:testnet:example");
    storage("unrelated-preference");
    assert.equal(changed, 4);
    stop();
    target.dispatchEvent(new Event("focus"));
    storage(null);
    assert.equal(changed, 4);
    assert.equal(unsubscribed, 1);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("real journal plus controller survives an unknown wallet handoff, account switch and reload without another signature", async () => {
  const h = harness(),
    storage = memoryStorage(),
    opened = deferred(),
    released = deferred();
  h.setStage(1);
  h.setAccounts([f.player_id]);
  let signatures = 0,
    rpcAvailable = false;
  const step = f.steps[1];
  const client = {
    identity,
    finalized: async () => ({
      block: {
        height: String(step.reference_block_height),
        timestampNs: (
          BigInt(step.args.command.valid_until_ns) - 500_000_000_000n
        ).toString(),
      },
      getCommand: async (_account, seq) => ({
        data: { kind: "not_applied", next_sequence: seq },
      }),
    }),
    receipt: async (proof) => {
      if (!rpcAvailable) throw Error("receipt RPC unavailable");
      return verifyLivingTownReceipt(step.receipt, proof, async () =>
        block(step),
      );
    },
  };
  const makeJournal = () =>
    new LivingTownTransactions(
      client,
      storage,
      async () => {
        signatures++;
        opened.resolve();
        await released.promise;
        throw Error("wallet outcome lost");
      },
      async (_name, work) => work(),
      () => id,
    );
  let journal = makeJournal();
  Object.assign(h.port, {
    prepare: (account, method, args) =>
      journal.prepare(account, method, { ...args, command: step.args.command }),
    submit: (id) => journal.submit(id),
    pending: () => journal.read(),
    restore: () => journal.restore(),
    discardPrepared: (id) => journal.discardPrepared(id),
    recoverHash: (id, hash) => journal.recoverHash(id, hash),
    reconcile: async () => {
      const status = await journal.refresh();
      if (status?.kind === "succeeded") h.setStage(2);
      return status;
    },
  });
  await h.c.start();
  const action = h.c.act("create_shop", { name: step.args.name });
  await opened.promise;
  await h.c.act("create_shop", { name: step.args.name });
  h.setAccounts(["other.testnet"]);
  await h.c.syncAccounts();
  assert.equal(h.c.state.observation, null);
  released.resolve();
  await action;
  assert.equal(h.c.state.pending.phase, "unknown");
  assert.equal(h.c.state.observation.shop, null);
  assert.equal(signatures, 1);
  const digest = h.c.state.pending.digest;
  h.c.stop();
  journal = makeJournal();
  const restored = new LivingTownController(h.port, () => {});
  await restored.start();
  await restored.resumePrepared();
  await restored.recover(step.transaction_hash);
  await restored.checkTransaction();
  assert.equal(restored.state.pending.accountId, f.player_id);
  assert.equal(restored.state.pending.digest, digest);
  assert.equal(restored.state.observation.ledger, null);
  rpcAvailable = true;
  await restored.checkTransaction();
  assert.equal(restored.state.pending, null);
  assert.equal(restored.state.observation.shop, null);
  assert.equal((await journal.last()).phase, "confirmed");
  h.setAccounts([f.player_id]);
  await restored.syncAccounts();
  assert.equal(restored.state.observation.shop.shop_id, "4");
  assert.equal(restored.state.observation.ledger.gold.held, "100");
  assert.equal(signatures, 1);
  restored.stop();
});
