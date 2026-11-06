import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import vm from "node:vm";
import {
  LivingTownClient,
  createLivingTownCall,
  livingTownGas,
  livingTownCommandDigest,
  livingTownWalletRequest,
  verifyLivingTownReceipt,
  verifyLivingTownEffect,
} from "../../packages/chain/dist/index.js";

const fixture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
const data = (step) =>
  JSON.parse(
    Buffer.from(step.receipt.status.SuccessValue, "base64").toString(),
  );
const foundation = (step) =>
  JSON.parse(Buffer.from(step.foundation.result).toString());
const deployment = foundation(fixture.steps[0]).deployment;
const identity = {
  deployment,
  codeHash: fixture.steps[0].account.code_hash,
  ownerId: fixture.contract_id,
  operatorId: "operator.testnet",
  controllers: {
    rex: "rex.testnet",
    luna: "luna.testnet",
    bolt: "bolt.testnet",
  },
};
const proof = (step) => ({
  transactionHash: step.transaction_hash,
  signerId: fixture.player_id,
  deployment,
  call: createLivingTownCall(step.method, step.args),
  referenceBlockHeight: String(step.reference_block_height),
});
const block = (step) => ({
  hash: step.block.header.hash,
  height: String(step.block.header.height),
  timestampNs: step.block.header.timestamp_nanosec,
});

test("V2 action codecs preserve canonical request identity and isolate V1 arguments", async () => {
  for (const step of fixture.steps) {
    const c = createLivingTownCall(step.method, step.args),
      r = livingTownWalletRequest(fixture.contract_id, fixture.player_id, c);
    assert.equal(c.gas, livingTownGas);
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].params.deposit, "0");
    assert.equal(r.actions[0].params.methodName, step.method);
    assert(Object.isFrozen(c.args.command));
  }
  const step = fixture.steps[1],
    args = structuredClone(step.args);
  args.name = "A\n";
  assert.throws(() => createLivingTownCall("create_shop", args));
  args.name = "A\u2028";
  assert.throws(() => createLivingTownCall("create_shop", args));
  assert.throws(() => createLivingTownCall("register_player", {}));
  assert.throws(() => createLivingTownCall("set_listing", {}));
  for (const [key, value] of [
    ["quantity", 1],
    ["quantity", "01"],
    ["quantity", "101"],
    ["quantity", "18446744073709551616"],
    ["item_id", "gold"],
    ["item_id", "health_potion"],
    ["resource", "crystal"],
  ]) {
    const args = structuredClone(fixture.steps[3].args);
    args[key] = value;
    assert.throws(() => createLivingTownCall("buy_from_merchant", args));
  }
  const c = createLivingTownCall("create_shop", step.args),
    hash = await livingTownCommandDigest(deployment, fixture.player_id, c);
  assert.equal(hash, data(step).data.payload_sha256);
  assert.notEqual(
    hash,
    await livingTownCommandDigest(
      { ...deployment, contract_id: "other.testnet" },
      fixture.player_id,
      c,
    ),
  );
});

test("all four actions, cached retry and failure verify against actual local WASM receipts", async () => {
  for (const [i, step] of fixture.steps.entries()) {
    const verified = await verifyLivingTownReceipt(
      step.receipt,
      proof(step),
      async (hash) => {
        assert.equal(hash, step.block.header.hash);
        return block(step);
      },
    );
    assert.equal(verified.kind, i === 5 ? "failed" : "succeeded");
    if (verified.kind === "succeeded")
      assert.deepEqual(verified.result, data(step));
    assert(BigInt(step.gas_burnt) < BigInt(livingTownGas));
  }
});

test("receipt verifier rejects forged actions, receipt graphs, blocks, payloads and original effects", async () => {
  const step = fixture.steps[3];
  const changes = [
    (r) => {
      r.transaction.signer_id = "attacker.testnet";
    },
    (r) => {
      r.transaction.receiver_id = "other.testnet";
    },
    (r) => {
      r.transaction.nonce = 9007199254740992;
    },
    (r) => {
      r.transaction.actions[0].FunctionCall.deposit = "1";
    },
    (r) => {
      r.transaction.actions[0].FunctionCall.gas = "30000000000000";
    },
    (r) => {
      r.transaction.actions.push(r.transaction.actions[0]);
    },
    (r) => {
      r.transaction.actions[0].FunctionCall.args = Buffer.from(
        '{"quantity":"1","quantity":"2"}',
      ).toString("base64");
    },
    (r) => {
      r.receipts_outcome.push(r.receipts_outcome[0]);
    },
    (r) => {
      r.receipts_outcome[0].outcome.executor_id = "other.testnet";
    },
    (r) => {
      r.transaction_outcome.outcome.receipt_ids = [];
    },
    (r) => {
      r.receipts_outcome[0].outcome.receipt_ids.push(r.receipts_outcome[0].id);
    },
    (r) => {
      r.receipts_outcome[0].outcome.status = { Unknown: null };
    },
    (r) => {
      r.status = { Failure: { error: "forged" } };
    },
  ];
  for (const change of changes) {
    const r = structuredClone(step.receipt);
    change(r);
    await assert.rejects(() =>
      verifyLivingTownReceipt(r, proof(step), async () => block(step)),
    );
  }
  await assert.rejects(() =>
    verifyLivingTownReceipt(
      step.receipt,
      {
        ...proof(step),
        referenceBlockHeight: String(step.block.header.height),
      },
      async () => block(step),
    ),
  );
  await assert.rejects(() =>
    verifyLivingTownReceipt(step.receipt, proof(step), async () => ({
      ...block(step),
      timestampNs: "1",
    })),
  );
  await assert.rejects(() =>
    verifyLivingTownEffect(
      data(step),
      { ...deployment, config_sha256: "b".repeat(64) },
      fixture.player_id,
      proof(step).call,
    ),
  );
  const result = data(step);
  result.data.payload_sha256 = "b".repeat(64);
  await assert.rejects(() =>
    verifyLivingTownEffect(
      result,
      deployment,
      fixture.player_id,
      proof(step).call,
    ),
  );
  assert.equal(
    (
      await verifyLivingTownReceipt(
        { final_execution_status: "NONE" },
        proof(step),
        async () => {
          throw Error("must not verify pending block");
        },
      )
    ).kind,
    "unknown",
  );
  const pending = structuredClone(step.receipt);
  pending.final_execution_status = "INCLUDED_FINAL";
  assert.equal(
    (
      await verifyLivingTownReceipt(pending, proof(step), async () =>
        block(step),
      )
    ).kind,
    "pending",
  );
});

function rpcDouble(change = () => {}) {
  const last = fixture.steps.at(-1),
    height = String(last.block.header.height),
    timestamp = last.block.header.timestamp_nanosec;
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    let r;
    if (method === "status")
      r = { chain_id: "testnet", sync_info: { syncing: false } };
    else if (method === "EXPERIMENTAL_genesis_config")
      r = { chain_id: "testnet", genesis_height: 7 };
    else if (method === "block")
      r =
        params.block_id === 7
          ? { header: { height: 7, hash: deployment.genesis_hash } }
          : structuredClone(
              fixture.steps.find((s) => s.block.header.hash === params.block_id)
                ?.block ?? last.block,
            );
    else if (method === "tx")
      r = structuredClone(
        fixture.steps.find((s) => s.transaction_hash === params.tx_hash)
          .receipt,
      );
    else if (method === "query") {
      const step =
        fixture.steps.find((s) => s.block.header.hash === params.block_id) ??
        last;
      if (params.request_type === "view_account")
        r = structuredClone(step.account);
      else if (params.method_name === "get_foundation")
        r = structuredClone(step.foundation);
      else {
        const args = JSON.parse(
          Buffer.from(params.args_base64, "base64").toString(),
        );
        let body;
        if (params.method_name === "get_shop")
          body = {
            ...data(fixture.steps[2]).data.outcome.shop,
            shop_id: args.shop_id,
          };
        else if (params.method_name === "get_shop_inventory")
          body = data(fixture.steps[3]).data.outcome.buyer;
        else if (params.method_name === "get_player")
          body = {
            ...data(fixture.steps[0]).data.outcome.player,
            account_id: args.account_id,
          };
        else if (params.method_name === "get_player_shops")
          body = {
            items: [data(fixture.steps[2]).data.outcome.shop],
            next_after_id: "4",
            has_more: false,
            history_gap: false,
            pruned_through: "0",
          };
        else if (params.method_name === "get_listings")
          body = {
            items: [data(fixture.steps[3]).data.outcome.listing],
            next_after_id: "1",
            has_more: false,
            history_gap: false,
            pruned_through: "0",
          };
        else if (params.method_name === "get_trade")
          body = {
            kind: "found",
            value: data(fixture.steps[3]).data.outcome.trade,
          };
        else if (params.method_name === "get_command")
          body = {
            kind: "found",
            high_water: "4",
            method: "buy_from_merchant",
            payload_sha256: data(fixture.steps[3]).data.payload_sha256,
            effect: data(fixture.steps[3]).data,
          };
        else throw Error("unhandled RPC " + params.method_name);
        r = {
          block_hash: last.block.header.hash,
          block_height: height,
          result: Array.from(
            Buffer.from(
              JSON.stringify({
                deployment,
                market_revision: "5",
                event_sequence: "5",
                block_height: height,
                block_timestamp_ns: timestamp,
                data: body,
              }),
            ),
          ),
        };
      }
    } else throw Error("unexpected RPC " + method);
    change(method, params, r);
    return r;
  };
  return { rpc, calls };
}

test("finalized V2 reader verifies genesis, code and authority before pinned typed views", async () => {
  const { rpc, calls } = rpcDouble(),
    reader = await new LivingTownClient(identity, rpc).finalized();
  assert.equal((await reader.getShop("4")).data.name, "Verified Shop");
  assert.equal(
    (await reader.getShopInventory("4")).data.actor.account_id,
    fixture.player_id,
  );
  assert.equal(
    (await reader.getPlayer(fixture.player_id)).data.account_id,
    fixture.player_id,
  );
  const page = { after_id: null, limit: "50", expected_market_revision: "5" };
  assert.equal(
    (await reader.getPlayerShops(fixture.player_id, page)).data.items.length,
    1,
  );
  assert.equal(
    (
      await reader.getListings({
        ...page,
        shop_id: null,
        item_id: "crystal",
        active_only: true,
      })
    ).data.items.length,
    1,
  );
  assert.equal((await reader.getTrade("1")).data.kind, "found");
  assert.equal(
    (await reader.getCommand(fixture.player_id, "4")).data.kind,
    "found",
  );
  assert(
    calls
      .filter((c) => c.method === "query")
      .every((c) => c.params.block_id === reader.block.hash),
  );
  const receipt = await new LivingTownClient(identity, rpc).receipt(
    proof(fixture.steps[3]),
  );
  assert.equal(receipt.kind, "succeeded");
});

test("V2 admission and reads fail closed on deployment, code, block, filter and unsafe-value mismatch", async () => {
  for (const bad of [
    (m, p, r) => {
      if (m === "status") r.chain_id = "mainnet";
    },
    (m, p, r) => {
      if (m === "block" && p.block_id === 7)
        r.header.hash = fixture.steps[0].transaction_hash;
    },
    (m, p, r) => {
      if (m === "query" && p.request_type === "view_account")
        r.code_hash = deployment.genesis_hash;
    },
    (m, p, r) => {
      if (m === "query") r.block_height = 9007199254740992;
    },
    (m, p, r) => {
      if (m === "query" && p.method_name === "get_foundation") {
        const v = JSON.parse(Buffer.from(r.result));
        v.deployment.config_sha256 = "b".repeat(64);
        r.result = Array.from(Buffer.from(JSON.stringify(v)));
      }
    },
  ]) {
    const { rpc } = rpcDouble(bad);
    await assert.rejects(() => new LivingTownClient(identity, rpc).finalized());
  }
  for (const [method, args, change] of [
    [
      "getShop",
      ["4"],
      (v) => {
        v.data.shop_id = "5";
      },
    ],
    [
      "getShop",
      ["4"],
      (v) => {
        v.block_timestamp_ns = "1";
      },
    ],
    [
      "getListings",
      [
        {
          shop_id: null,
          item_id: "crystal",
          active_only: true,
          after_id: null,
          limit: "1",
          expected_market_revision: "5",
        },
      ],
      (v) => {
        v.data.items[0].item_id = "wood";
      },
    ],
    [
      "getPlayerShops",
      [
        fixture.player_id,
        { after_id: null, limit: "1", expected_market_revision: "5" },
      ],
      (v) => {
        v.data.next_after_id = "5";
      },
    ],
    [
      "getCommand",
      [fixture.player_id, "4"],
      (v) => {
        v.data.high_water = "3";
      },
    ],
  ]) {
    const { rpc } = rpcDouble((m, p, r) => {
      if (m === "query" && p.method_name !== "get_foundation" && r.result) {
        const v = JSON.parse(Buffer.from(r.result));
        change(v);
        r.result = Array.from(Buffer.from(JSON.stringify(v)));
      }
    });
    const reader = await new LivingTownClient(identity, rpc).finalized();
    await assert.rejects(() => reader[method](...args));
  }
});

const output = await build({
  stdin: {
    contents: "export * from './apps/web/src/app/living-town-transactions.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { LivingTownTransactions, LivingTownNotOpenedError } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString("base64")}`
);
const serial = () => {
  let previous = Promise.resolve();
  return async (_name, fn) => {
    const r = previous.then(fn);
    previous = r.catch(() => {});
    return r;
  };
};
const storage = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
};
const id = "00000000-0000-4000-8000-000000000001";
function journalFixture(
  send = async () => ({
    transaction: { hash: fixture.steps[0].transaction_hash },
  }),
) {
  const s = storage(),
    lock = serial();
  let status = {
      kind: "unknown",
      transactionHash: fixture.steps[0].transaction_hash,
    },
    signatures = 0;
  const client = {
    identity,
    finalized: async () => ({
      block: {
        height: String(fixture.steps[0].reference_block_height),
        timestampNs: String(
          BigInt(fixture.steps[0].args.command.valid_until_ns) -
            500_000_000_000n,
        ),
      },
      getCommand: async (_account, seq) => ({
        data: { kind: "not_applied", next_sequence: seq },
      }),
    }),
    receipt: async () => status,
  };
  const create = () =>
    new LivingTownTransactions(
      client,
      s,
      async (...args) => {
        signatures++;
        return send(...args);
      },
      lock,
      () => id,
    );
  return {
    s,
    create,
    setStatus: (v) => {
      status = v;
    },
    signatures: () => signatures,
  };
}

test("player wallet journals reject operator market-event scheduling before saving or signing", async () => {
  const f = journalFixture(),
    journal = f.create();
  await assert.rejects(() =>
    journal.prepare(fixture.player_id, "schedule_market_event", {
      event_id: "1",
      definition_id: "herb_shortage_v1",
      start_epoch: "1",
      command: fixture.steps[0].args.command,
    }),
  );
  assert.equal(await journal.read(), null);
  assert.equal(f.signatures(), 0);
  assert.equal(f.s.map.size, 0);
});

test("V2 journal reload, cancellation, unknown receipt and manual recovery never resend", async () => {
  const f = journalFixture(async () => {
      throw Error("wallet closed or outcome unknown");
    }),
    j = f.create();
  const a = await j.prepare(
    fixture.player_id,
    "register_player",
    fixture.steps[0].args,
  );
  await j.submit(a.id);
  assert.equal(f.signatures(), 1);
  assert.equal((await j.read()).phase, "unknown");
  const reloaded = f.create();
  await reloaded.restore();
  await reloaded.refresh();
  await assert.rejects(() => reloaded.submit(a.id));
  await assert.rejects(() =>
    reloaded.prepare(
      fixture.player_id,
      "register_player",
      fixture.steps[0].args,
    ),
  );
  await reloaded.recoverHash(a.id, fixture.steps[0].transaction_hash);
  f.setStatus({
    kind: "failed",
    code: "EXECUTION_FAILED",
    transactionHash: fixture.steps[0].transaction_hash,
  });
  await reloaded.refresh();
  assert.equal((await reloaded.read()).phase, "unknown");
  f.setStatus({
    kind: "succeeded",
    transactionHash: fixture.steps[0].transaction_hash,
  });
  await reloaded.refresh();
  assert.equal(await reloaded.read(), null);
  assert.equal((await reloaded.last()).phase, "confirmed");
  assert.equal(f.signatures(), 1);
});

test("V2 journal retains every action identity, serializes two tabs and never sends on refresh", async () => {
  for (const step of fixture.steps.slice(0, 4)) {
    const f = journalFixture(),
      j = f.create();
    const a = await j.prepare(fixture.player_id, step.method, step.args);
    assert.equal(
      a.digest,
      await livingTownCommandDigest(
        deployment,
        fixture.player_id,
        createLivingTownCall(step.method, step.args),
      ),
    );
    await j.submit(a.id);
    await j.refresh();
    assert.equal(f.signatures(), 1);
    assert.equal((await j.read()).phase, "unknown");
  }
  const f = journalFixture(),
    a = f.create(),
    b = f.create();
  const raced = await Promise.allSettled([
    a.prepare(fixture.player_id, "register_player", fixture.steps[0].args),
    b.prepare(fixture.player_id, "register_player", fixture.steps[0].args),
  ]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  await b.restore();
  await a.refresh();
  assert.equal(f.signatures(), 0);
  assert.equal((await a.read()).phase, "prepared");
  await a.discardPrepared(id);
  assert.equal(f.signatures(), 0);
});

test("V2 journal fails closed on corrupt storage, changed identity and failed persistence", async () => {
  const f = journalFixture(),
    j = f.create();
  await j.prepare(fixture.player_id, "register_player", fixture.steps[0].args);
  const [key, raw] = [...f.s.map][0];
  for (const mutate of [
    (v) => {
      v.pending.digest = "b".repeat(64);
    },
    (v) => {
      v.identity.codeHash = deployment.genesis_hash;
    },
    (v) => {
      v.pending.call.args.command.sequence = "2";
    },
    (v) => {
      v.pending.extra = "unknown";
    },
    (v) => {
      v.pending.transactionHash = fixture.steps[0].transaction_hash;
      v.pending.hashSource = "wallet";
    },
  ]) {
    const v = JSON.parse(raw);
    mutate(v);
    f.s.map.set(key, JSON.stringify(v));
    await assert.rejects(() => f.create().read());
  }
  f.s.map.set(key, raw);
  f.s.setItem = () => {
    throw Error("disk full");
  };
  await assert.rejects(() => j.submit(id));
  assert.equal(f.signatures(), 0);
  const safe = journalFixture(async () => {
      throw new LivingTownNotOpenedError();
    }),
    s = safe.create();
  await s.prepare(fixture.player_id, "register_player", fixture.steps[0].args);
  await s.submit(id);
  assert.equal(await s.read(), null);
  assert.equal((await s.last()).phase, "not_submitted");
  const explicit = journalFixture(),
    e = explicit.create();
  await e.prepare(fixture.player_id, "register_player", fixture.steps[0].args);
  await e.discardPrepared(id);
  assert.equal(explicit.signatures(), 0);
  assert.equal(await e.read(), null);
});

test("two tabs submitting one prepared command open only one wallet request", async () => {
  const f = journalFixture(),
    first = f.create(),
    second = f.create();
  const attempt = await first.prepare(
    fixture.player_id,
    "register_player",
    fixture.steps[0].args,
  );
  const results = await Promise.allSettled([
    first.submit(attempt.id),
    second.submit(attempt.id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.signatures(), 1);
  await second.restore();
  await first.refresh();
  await second.refresh();
  assert.equal(f.signatures(), 1);
  assert.equal(
    (await second.read()).transactionHash,
    fixture.steps[0].transaction_hash,
  );
});

test("losing storage after wallet handoff retains a durable unknown attempt after restart", async () => {
  let failWrites = false;
  const f = journalFixture(async () => {
    failWrites = true;
    return { transaction: { hash: fixture.steps[0].transaction_hash } };
  });
  const set = f.s.setItem;
  f.s.setItem = (k, v) => {
    if (failWrites) throw Error("injected disk full after wallet");
    set(k, v);
  };
  const journal = f.create(),
    attempt = await journal.prepare(
      fixture.player_id,
      "register_player",
      fixture.steps[0].args,
    );
  await assert.rejects(journal.submit(attempt.id), /disk full/);
  assert.equal((await journal.read()).phase, "awaiting_wallet");
  failWrites = false;
  const restored = f.create();
  await restored.restore();
  assert.equal((await restored.read()).phase, "unknown");
  await restored.refresh();
  await assert.rejects(restored.submit(attempt.id));
  await restored.recoverHash(attempt.id, fixture.steps[0].transaction_hash);
  const step = fixture.steps[0];
  f.setStatus(
    await verifyLivingTownReceipt(step.receipt, proof(step), async () =>
      block(step),
    ),
  );
  await restored.refresh();
  assert.equal(await restored.read(), null);
  assert.equal((await restored.last()).phase, "confirmed");
  assert.equal(f.signatures(), 1);
});

test("reviewed wallet port verifies the V2 deployment and active account before one encoded request", async () => {
  const calls = [];
  const output = await build({
    entryPoints: ["apps/web/src/app/wallet-adapter.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "adapter",
    write: false,
    plugins: [
      {
        name: "reviewed-wallet-double",
        setup(b) {
          b.onResolve({ filter: /^@hot-labs\/near-connect$/ }, () => ({
            path: "mock",
            namespace: "wallet",
          }));
          b.onLoad({ filter: /.*/, namespace: "wallet" }, () => ({
            contents: `export class NearConnector {constructor(o){this.network=o.network;}on(){}off(){}} export class SandboxWallet {async getAccounts(){return [{accountId:'player.testnet'}];}async signAndSendTransaction(request){calls.push(request);return {transaction:{hash:''}};}}`,
          }));
        },
      },
    ],
  });
  const { rpc } = rpcDouble();
  const context = vm.createContext({
    URL,
    crypto,
    structuredClone,
    TextEncoder,
    TextDecoder,
    AbortSignal,
    btoa,
    atob,
    calls,
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: await rpc(request.method, request.params),
        }),
      );
    },
  });
  vm.runInContext(output.outputFiles[0].text, context);
  const saved = storage();
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
  const port = await context.adapter.createWalletPort(
    {
      networkId: "testnet",
      contractId: fixture.contract_id,
      rpcUrl: "https://test.rpc.fastnear.com",
    },
    saved,
  );
  const call = createLivingTownCall("register_player", fixture.steps[0].args);
  await port.livingTown("player.testnet", call, identity);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiverId, fixture.contract_id);
  assert.equal(calls[0].actions[0].params.gas, livingTownGas);
  assert.equal(calls[0].actions[0].params.args.command.sequence, "1");
  await assert.rejects(() =>
    port.livingTown("player.testnet", call, {
      ...identity,
      deployment: { ...deployment, contract_id: "other.testnet" },
    }),
  );
  await assert.rejects(() => port.livingTown("other.testnet", call, identity));
  await assert.rejects(() =>
    port.livingTown("player.testnet", call, {
      ...identity,
      codeHash: deployment.genesis_hash,
    }),
  );
  assert.equal(calls.length, 1);
});
