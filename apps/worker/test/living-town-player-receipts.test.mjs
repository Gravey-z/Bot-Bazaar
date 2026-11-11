import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import {
  LivingTownClient,
  createLivingTownCall,
  playerReceiptProof,
  livingTownCommandDigest,
  livingTownJsonDigest,
} from "../../../packages/chain/dist/index.js";
import { PlayerReceipts } from "../dist/private/living-town/player-receipts.js";
import { playerReceiptHandler } from "../dist/private/living-town/player-receipt-handler.js";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import { LivingTownProjector } from "../dist/private/living-town/projector.js";
import { createReadHandler } from "../dist/private/read-api/handler.js";
import { capturedPlayerProofs } from "../../../scripts/living-town-import-player-receipts.mjs";

const captured = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
const first = captured.steps[0];
const foundation = JSON.parse(Buffer.from(first.foundation.result).toString());
const identity = {
  deployment: foundation.deployment,
  codeHash: first.account.code_hash,
  ownerId: foundation.data.owner_account_id,
  operatorId: foundation.data.operator_account_id,
  controllers: foundation.data.merchant_controllers,
};
const proofs = captured.steps.map((s) =>
  playerReceiptProof({
    transactionHash: s.transaction_hash,
    signerId: captured.player_id,
    deployment: identity.deployment,
    call: createLivingTownCall(s.method, s.args),
    referenceBlockHeight: String(s.reference_block_height),
  }),
);
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
const boundary = {
  allowedOrigins: ["http://127.0.0.1:4200"],
  trustedProxyIps: [],
  clientPerMinute: 60,
  globalPerSecond: 10,
};
const bundled = await build({
  stdin: {
    contents: `export * from './apps/web/src/app/living-town-transactions.ts';
  export * from './apps/web/src/app/living-town-receipt-handoff.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { LivingTownTransactions, receiptHandoff } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-player-receipts-"));
  return dir;
}
function clean(dir) {
  assert(dir.startsWith(join(tmpdir(), "bazaar-player-receipts-")));
  rmSync(dir, { force: true, recursive: true });
}
function recordedClient() {
  return new LivingTownClient(identity, async (method, p) => {
    if (method === "status")
      return { chain_id: "testnet", sync_info: { syncing: false } };
    if (method === "EXPERIMENTAL_genesis_config")
      return { chain_id: "testnet", genesis_height: 0 };
    if (method === "block") {
      if (p.block_id === 0)
        return {
          header: { hash: identity.deployment.genesis_hash, height: 0 },
        };
      return p.block_id
        ? captured.steps.find((s) => s.block.header.hash === p.block_id).block
        : captured.final_block;
    }
    if (method === "tx")
      return captured.steps.find((s) => s.transaction_hash === p.tx_hash)
        .receipt;
    if (method === "query") {
      const step = captured.steps.find(
        (s) => s.block.header.hash === p.block_id,
      );
      if (p.request_type === "view_account") return step.account;
      if (p.method_name === "get_foundation") return step.foundation;
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
}
function request(
  handler,
  body,
  {
    origin = boundary.allowedOrigins[0],
    method = "POST",
    headers = {},
    path = "/api/player-receipts",
  } = {},
) {
  const req = Readable.from([
    Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  ]);
  req.method = method;
  req.url = path;
  req.headers = { origin, "content-type": "application/json", ...headers };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
  };
  res.end = (body) => {
    res.body = body;
    res.emit("finish");
  };
  return Promise.resolve(handler(req, res)).then(() => res);
}
test("ordinary browser confirmation survives offline reload, reaches verified archive/accounting, and is visible to another session", async (t) => {
  const dir = directory(t);
  let projection = new LivingTownProjectionStore(dir, identity, true);
  let queue = new PlayerReceipts(dir, identity);
  t.after(() => {
    queue.close();
    projection.close();
    clean(dir);
  });
  projection.baseline({
    town: captured.initial_town,
    block: block(captured.initial_block),
    shops: [],
    production: ["1", "2", "3"].map((shopId) => ({
      shopId,
      pages: [
        {
          ...captured.initial_town,
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
  });
  const client = recordedClient();
  const projector = new LivingTownProjector(client, projection);
  const storage = new Map(),
    wallet = () => {
      throw Error("Wallet must never open during relay");
    };
  const key = `bot-bazaar:living-town:journal:1:${identity.deployment.network_id}:${identity.deployment.genesis_hash}:${identity.deployment.contract_id}`;
  const attempt = async (i) => ({
    id: "11111111-1111-4111-8111-111111111111",
    accountId: captured.player_id,
    call: proofs[i].call,
    digest: await livingTownCommandDigest(
      identity.deployment,
      captured.player_id,
      proofs[i].call,
    ),
    referenceBlockHeight: proofs[i].referenceBlockHeight,
    phase: "submitted",
    transactionHash: proofs[i].transactionHash,
    hashSource: "wallet",
  });
  const walletStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  };
  let journal = new LivingTownTransactions(
    client,
    walletStorage,
    wallet,
    async (_name, work) => work(),
  );
  // Simulate three successive wallet-returned hashes. Refresh uses the actual
  // SDK receipt verifier over recorded RPC, then atomically retains each proof.
  for (const i of [0, 1, 2, 3]) {
    const old = storage.has(key)
      ? JSON.parse(storage.get(key))
      : {
          schema: "bot-bazaar:living-town:journal:1",
          identity,
          pending: null,
          last: null,
        };
    storage.set(key, JSON.stringify({ ...old, pending: await attempt(i) }));
    assert.equal((await journal.refresh()).kind, "succeeded");
  }
  assert.equal((await journal.receiptProofs()).length, 4);
  await receiptHandoff(journal, "http://reader.invalid", async () => {
    throw Error("offline");
  })();
  assert.equal((await journal.receiptProofs()).length, 4);
  journal = new LivingTownTransactions(
    client,
    walletStorage,
    wallet,
    async (_name, work) => work(),
  );
  let now = 100000;
  const flush = receiptHandoff(
    journal,
    "http://reader.invalid",
    async (url, init) => {
      assert.equal(url.pathname, "/api/player-receipts");
      const res = await request(
        playerReceiptHandler(queue, boundary),
        init.body,
      );
      return new Response(res.body, { status: res.statusCode });
    },
    () => now,
  );
  await flush();
  queue.close();
  queue = new PlayerReceipts(dir, identity); // durable handoff survives reader restart
  await queue.drain(projector);
  now += 10000;
  await flush(); // first three acknowledged, purchase now queued
  await queue.drain(projector);
  now += 10000;
  await flush();
  assert.equal((await journal.receiptProofs()).length, 0);
  const archive = JSON.parse(projection.archive(null, 25).body);
  assert.equal(archive.entries.length, 4);
  assert.equal(projection.cursor().through_event_sequence, "5");
  const history = projection.history("4");
  assert(
    history.snapshot.data.items.some(
      (row) => row.transaction_hash === proofs[3].transactionHash,
    ),
  );
  assert.equal(history.snapshot.data.costs.through_event_sequence, "5");
  const before = projection.counts();
  projection.close();
  projection = new LivingTownProjectionStore(dir, identity);
  assert.deepEqual(projection.counts(), before);
  assert.equal(
    projection.inventory("4").snapshot.data.inventory.held.crystal,
    "1",
  );
  assert.equal(projection.town().history_complete, false); // no manufactured completeness
  for (const proof of proofs.slice(0, 4))
    assert.equal(queue.receive(proof).status, "indexed");
  const forged = { ...proofs[3], signerId: "other-player.testnet" };
  queue.receive(forged);
  await queue.drain(new LivingTownProjector(client, projection));
  assert.equal(queue.receive(forged).status, "rejected");
  assert.deepEqual(projection.counts(), before);
});

test("deployment/method/signer and extra outcome fields are rejected before admission", (t) => {
  const dir = directory();
  const queue = new PlayerReceipts(dir, identity);
  t.after(() => {
    queue.close();
    clean(dir);
  });
  assert.throws(() => queue.receive({ ...proofs[0], gold: "999" }));
  assert.throws(
    () =>
      queue.receive({
        ...proofs[0],
        deployment: { ...identity.deployment, contract_id: "other.testnet" },
      }),
    /deployment_mismatch/,
  );
  assert.throws(
    () => queue.receive({ ...proofs[0], signerId: identity.controllers.rex }),
    /player_signer_required/,
  );
  assert.throws(
    () =>
      queue.receive({
        ...proofs[0],
        call: { ...proofs[0].call, method: "accept_trade" },
      }),
    /player method/,
  );
});
test("unresolved/RPC failures retry across restart; invalid hints cannot block other proofs", async (t) => {
  const dir = directory();
  let queue = new PlayerReceipts(dir, identity);
  t.after(() => {
    queue.close();
    clean(dir);
  });
  queue.receive(proofs[0], 1000);
  queue.receive(proofs[1], 1000);
  let calls = 0;
  await queue.drain(
    {
      ingest: async (p) => {
        calls++;
        if (p.transactionHash === proofs[0].transactionHash) {
          const e = new Error("wrong args");
          e.name = "ChainValidationError";
          throw e;
        }
        const e = new Error("offline");
        e.name = "ChainRpcError";
        throw e;
      },
    },
    1000,
  );
  assert.equal(calls, 2);
  assert.equal(queue.receive(proofs[0]).status, "rejected");
  queue.close();
  queue = new PlayerReceipts(dir, identity);
  await queue.drain(
    {
      ingest: async () => {
        calls++;
        return "indexed";
      },
    },
    1001,
  );
  assert.equal(calls, 2);
  await queue.drain({ ingest: async () => "indexed" }, 11000);
  assert.equal(queue.receive(proofs[1]).status, "indexed");
});
test("queue is bounded and repeated hints do not consume more capacity", (t) => {
  const dir = directory();
  const queue = new PlayerReceipts(dir, identity);
  t.after(() => {
    queue.close();
    clean(dir);
  });
  for (let i = 1; i <= 128; i++)
    queue.receive({ ...proofs[0], referenceBlockHeight: String(i) });
  assert.equal(queue.receive(proofs[0]).status, "queued");
  assert.throws(
    () => queue.receive({ ...proofs[0], referenceBlockHeight: "129" }),
    /proof_queue_full/,
  );
});
test("HTTP proof intake enforces exact origin, JSON body limits, and keeps read API read-only", async () => {
  let receives = 0;
  const handler = playerReceiptHandler(
    {
      receive: () => {
        receives++;
        return { id: "hint", status: "queued" };
      },
    },
    boundary,
  );
  assert.equal(
    (await request(handler, proofs[0], { origin: "https://evil.invalid" }))
      .statusCode,
    403,
  );
  assert.equal(
    (await request(handler, proofs[0], { method: "GET" })).statusCode,
    405,
  );
  assert.equal((await request(handler, "x".repeat(17000))).statusCode, 413);
  assert.equal((await request(handler, "{")).statusCode, 422);
  assert.equal(receives, 0);
  const accepted = await request(handler, proofs[0]);
  assert.equal(accepted.statusCode, 202);
  assert.equal(receives, 1);
  assert.equal(
    accepted.headers["Access-Control-Allow-Origin"],
    boundary.allowedOrigins[0],
  );
  const read = createReadHandler(
    { health: () => ({}), activity: () => ({}) },
    boundary,
  );
  assert.equal(
    (await request(read, proofs[0], { path: "/health" })).statusCode,
    405,
  );
});
test("offline import selects saved player proof metadata and leaves runtime/initialization records alone", () => {
  const row = {
    transaction_hash: proofs[0].transactionHash,
    signer_id: captured.player_id,
    receiver_id: identity.deployment.contract_id,
    method: first.method,
    args: first.args,
    before: { block: { height: proofs[0].referenceBlockHeight } },
  };
  assert.deepEqual(
    capturedPlayerProofs(
      [row, { method: "allocate_raw_supply" }, {}],
      identity,
    ),
    [proofs[0]],
  );
  assert.throws(
    () =>
      capturedPlayerProofs(
        [{ ...row, receiver_id: "other.testnet" }],
        identity,
      ),
    /deployment/,
  );
});
test("queued acknowledgement is not verification; mismatched acknowledgement never deletes a proof", async () => {
  let acks = 0;
  for (const response of [
    { id: await livingTownJsonDigest(proofs[0]), status: "queued" },
    { id: "forged", status: "indexed" },
  ]) {
    await receiptHandoff(
      {
        receiptProofs: async () => [proofs[0]],
        acknowledgeReceipt: async () => {
          acks++;
        },
      },
      "http://reader.invalid",
      async () => Response.json(response),
    )();
  }
  assert.equal(acks, 0);
});
test("unresolved hints stop verification after a bounded number of attempts", async (t) => {
  const dir = directory();
  const queue = new PlayerReceipts(dir, identity);
  t.after(() => {
    queue.close();
    clean(dir);
  });
  queue.receive(proofs[0], 1);
  let calls = 0;
  for (let i = 0; i < 15; i++)
    await queue.drain(
      {
        ingest: async () => {
          calls++;
          return "unresolved";
        },
      },
      1 + i * 400000,
    );
  assert.equal(calls, 12);
  assert.equal(queue.receive(proofs[0]).status, "expired");
  assert.equal(queue.requeueExpired(proofs[0], 10000000).status, "queued");
  await queue.drain({ ingest: async () => "indexed" }, 10000000);
  assert.equal(queue.receive(proofs[0]).status, "indexed");
});
