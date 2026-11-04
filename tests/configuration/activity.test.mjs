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
    contents: `export * from './apps/web/src/app/activity-feed.ts'; export * from './apps/web/src/app/activity-reader.ts'; export * from './apps/web/src/app/activity-wire.ts'; export * from './apps/web/src/app/activity-proof.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "activity",
  write: false,
});
const sandbox = vm.createContext({
  URL,
  TextEncoder,
  TextDecoder,
  AbortSignal,
  btoa,
  setTimeout,
  clearTimeout,
  fetch,
});
vm.runInContext(output.outputFiles[0].text, sandbox, {
  filename: "activity.js",
});
const {
  decodeActivityPage,
  createActivityReads,
  ActivityReadError,
  ActivityFeed,
  mergeActivityRows,
  transactionExplorer,
  workerProof,
  tradeDeltas,
} = sandbox.activity;
const config = {
  networkId: "testnet",
  contractId: fixture.contract_id,
  rpcUrl: "https://test.rpc.fastnear.com",
  workerUrl: "https://worker.example/",
  explorerUrl: "https://testnet.nearblocks.io/",
};
const time =
  Number(BigInt(fixture.final.market.block_timestamp_ns) / 1000000n) + 1000;
const generation = "11111111-2222-4333-8444-555555555555";
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
function trade(raw) {
  return {
    trade_id: raw.trade_id,
    kind: raw.kind,
    buyer: raw.buyer.kind === "merchant" ? raw.buyer.merchant_id : null,
    seller: raw.seller.merchant_id,
    resource: raw.resource,
    quantity: raw.quantity,
    unit_price: raw.unit_price,
    total_price: raw.total_price,
    settled_at_ns: raw.settled_at_ns,
  };
}
function entry(sequence = "1", overrides = {}) {
  return {
    sequence,
    id: BigInt(sequence).toString(16).padStart(64, "0"),
    domain_key: `decision:${"a".repeat(64)}`,
    source: "model",
    status: "proposed",
    phase: "selection",
    observed_at: time,
    merchant_id: "rex",
    root_id: "root-1",
    decision_id: "decision-1",
    intent_id: null,
    action_id: null,
    offer_id: null,
    trade_id: null,
    reason: "Restock crystals while protecting reserves.",
    reason_kind: "model",
    code: "model_selection",
    method: "propose_trade",
    selection: null,
    trade: null,
    listing: null,
    transaction: null,
    block: null,
    late_ignored: false,
    live_ai_evidence: false,
    ...overrides,
  };
}
function page(entries = [entry()], overrides = {}) {
  return {
    api_version: "1",
    deployment: {
      id: "b".repeat(64),
      network_id: "testnet",
      contract_id: fixture.contract_id,
      expected_code_hash: fixture.code_hash,
      identity_kind: "configured",
    },
    feed_generation: generation,
    captured_at: time,
    heartbeat_at: time,
    chain: {
      block_height: fixture.final.market.block_height,
      block_hash: fixture.final.finalized_block.hash,
      market_revision: fixture.final.market.market_revision,
      observed_at: time,
      age_ms: 0,
      stale: false,
      paused: false,
    },
    entries,
    next_after: `cursor_${entries.at(-1)?.sequence ?? "empty"}`,
    has_more: false,
    history_gap: false,
    high_water_sequence: entries.at(-1)?.sequence ?? "1",
    pruned_through: "0",
    ...overrides,
  };
}
function chain(overrides = {}) {
  return {
    block: {
      hash: fixture.final.finalized_block.hash,
      height: fixture.final.market.block_height,
      timestampNs: fixture.final.market.block_timestamp_ns,
    },
    codeHash: fixture.code_hash,
    marketRevision: fixture.final.market.market_revision,
    capturedAt: time,
    trades: fixture.final.trades.data.items.map(trade),
    nextAfter: "2",
    hasMore: false,
    historyGap: false,
    prunedThrough: "0",
    highWater: "2",
    reset: false,
    ...overrides,
  };
}
function confirmedEntry(
  sequence = "1",
  value = trade(fixture.final.trades.data.items[0]),
) {
  return entry(sequence, {
    source: "chain",
    status: "confirmed",
    phase: "trade",
    code: "finalized_trade_view",
    reason: null,
    reason_kind: null,
    method: null,
    trade_id: value.trade_id,
    trade: value,
    block: {
      height: fixture.final.market.block_height,
      hash: fixture.final.finalized_block.hash,
      timestamp_ns: fixture.final.market.block_timestamp_ns,
      market_revision: fixture.final.market.market_revision,
    },
  });
}
function harness() {
  let clock = time,
    id = 0;
  const timers = new Map(),
    calls = { worker: [], chain: [], gaps: 0 };
  const behavior = {
    worker: async (after) =>
      after === null ? page() : page([], { next_after: after }),
    chain: async (after) =>
      chain({ trades: after === null ? chain().trades : [] }),
  };
  const feed = new ActivityFeed(
    {
      worker: (after) => {
        calls.worker.push(after);
        return behavior.worker(after);
      },
      chain: (after) => {
        calls.chain.push(after);
        return behavior.chain(after);
      },
    },
    () => {},
    () => {
      calls.gaps++;
    },
    () => clock,
    {
      set(callback, delay) {
        const next = ++id;
        timers.set(next, { callback, at: clock + delay });
        return next;
      },
      clear(key) {
        timers.delete(key);
      },
    },
  );
  return {
    feed,
    behavior,
    calls,
    timers,
    async start() {
      feed.start();
      await settle();
    },
    async advance(ms) {
      clock += ms;
      for (const [key, timer] of [...timers])
        if (timer.at <= clock && timers.delete(key)) timer.callback();
      await settle();
    },
  };
}

test("proof links use only validated Testnet explorer configuration and base58 hashes", () => {
  const hash = fixture.final.finalized_block.hash;
  assert.equal(
    transactionExplorer(config, hash),
    `https://testnet.nearblocks.io/txns/${hash}`,
  );
  for (const malicious of [
    "javascript:alert(1)",
    "//evil.example/tx",
    "<img src=x>",
    hash + "?token=x",
    "%2f",
    "0".repeat(44),
    hash + "\n",
    "A".repeat(45),
  ])
    assert.equal(transactionExplorer(config, malicious), null);
  for (const override of [
    { networkId: "mainnet" },
    { explorerUrl: "https://nearblocks.io" },
    { explorerUrl: "https://testnet.nearblocks.io.evil.example" },
    { explorerUrl: "https://evil.example/" },
    { explorerUrl: "https://testnet.nearblocks.io/?x=y" },
  ])
    assert.equal(transactionExplorer({ ...config, ...override }, hash), null);
});

test("only actual receipt evidence receives the verified worker link label", () => {
  const hash = fixture.final.finalized_block.hash;
  const tx = {
    signed_hash: hash,
    receipt_hash: hash,
    evidence: "receipt",
    evidence_incomplete: false,
    explorer_url: "javascript:alert(1)",
  };
  const confirmed = confirmedEntry("1");
  confirmed.transaction = tx;
  const proof = workerProof(confirmed, config)[0];
  assert.match(proof.label, /successful receipt/);
  assert.equal(proof.url, `https://testnet.nearblocks.io/txns/${hash}`);
  for (const fields of [
    { status: "submitted" },
    { source: "system" },
    { transaction: { ...tx, receipt_hash: "B".repeat(44) } },
    { transaction: { ...tx, evidence_incomplete: true } },
  ])
    assert.match(
      workerProof({ ...confirmed, ...fields }, config)[0].label,
      /finality unverified/,
    );
  for (const evidence of ["action_checkpoint", "unavailable"])
    assert.equal(
      workerProof({ ...confirmed, transaction: { ...tx, evidence } }, config)
        .length,
      0,
    );
});

test("purchase, proposal and acceptance links never use offered terms as actual deltas", () => {
  const hash = fixture.final.finalized_block.hash;
  for (const method of ["propose_trade", "accept_trade"]) {
    const event = entry("1", {
      source: "system",
      status: "submitted",
      phase: "transaction",
      method,
      transaction: {
        signed_hash: hash,
        receipt_hash: null,
        explorer_url: "https://evil.example",
        evidence: "signed",
        evidence_incomplete: false,
      },
    });
    const row = mergeActivityRows([], [event], config).rows[0];
    assert.equal(row.deltas.length, 0);
    assert.equal(
      row.proofs[0].url,
      `https://testnet.nearblocks.io/txns/${hash}`,
    );
    assert.match(row.proofs[0].label, /unverified/);
  }
  const purchase = mergeActivityRows(
    [trade(fixture.final.trades.data.items[0])],
    [],
    config,
  ).rows[0];
  assert.deepEqual(plain(purchase.deltas), [
    "Player: +12 crystal, −48 virtual gold",
    "rex: −12 crystal, +48 virtual gold",
  ]);
  assert.equal(purchase.proofs.length, 0);
  const merchant = trade(fixture.final.trades.data.items[1]);
  assert.deepEqual(plain(tradeDeltas(merchant)), [
    "rex: +4 crystal, −24 virtual gold",
    "luna: −4 crystal, +24 virtual gold",
  ]);
  assert.throws(() => tradeDeltas({ ...merchant, total_price: "25" }));
});

test("deduplicated confirmation preserves one transfer and its receipt hash", () => {
  const event = confirmedEntry();
  const hash = fixture.final.finalized_block.hash;
  event.transaction = {
    signed_hash: hash,
    receipt_hash: hash,
    explorer_url: null,
    evidence: "receipt",
    evidence_incomplete: false,
  };
  const rows = mergeActivityRows(
    [event.trade],
    [event, { ...event, id: "c".repeat(64) }],
    config,
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deltas.length, 2);
  assert.equal(rows[0].proofs.length, 1);
});

test("worker decoder preserves large string sequences and plain hostile reasons", () => {
  const sequence = "9007199254740993";
  const value = decodeActivityPage(
    page([entry(sequence, { reason: "<img src=x onerror=alert(1)>" })]),
  );
  assert.equal(value.entries[0].sequence, sequence);
  const rows = mergeActivityRows([], value.entries).rows;
  assert.equal(rows[0].reason, "<img src=x onerror=alert(1)>");
  assert.equal(rows[0].title, "Model proposal");
});

test("browser decoder accepts real persisted worker projections without using a live provider", async (t) => {
  const { setupInferenceFixture } =
    await import("../../apps/worker/test/inference-fixture.mjs");
  const f = await setupInferenceFixture(t);
  const before = f.store.activity.page(
    undefined,
    50,
    config.explorerUrl,
    f.now,
  );
  await f.runner.run(f.request, async () => ({
    action: { method: "hold" },
    reason: "Retain reserves and wait.",
  }));
  f.store.policy.authorize(f.request.id);
  const persisted = f.store.activity.page(
    before.next_after,
    50,
    config.explorerUrl,
    Date.now(),
  );
  const decoded = decodeActivityPage(plain(persisted));
  assert.ok(
    decoded.entries.some(
      (row) => row.source === "model" && row.status === "held",
    ),
  );
  assert.ok(decoded.entries.every((row) => row.live_ai_evidence === false));
  const resumed = decodeActivityPage(
    plain(
      f.store.activity.page(
        persisted.next_after,
        50,
        config.explorerUrl,
        Date.now(),
      ),
    ),
  );
  assert.equal(resumed.entries.length, 0);
  assert.ok(resumed.next_after);
});

test("duplicate event IDs and conflicting finalized blocks cannot replace loaded history", async () => {
  assert.throws(() =>
    decodeActivityPage(page([entry(), entry("2", { id: entry().id })])),
  );
  const h = harness();
  await h.start();
  const before = JSON.stringify(h.feed.state.rows);
  h.behavior.chain = async () =>
    chain({ block: { ...chain().block, hash: "A".repeat(44) } });
  await h.feed.refresh();
  assert.equal(h.feed.state.chainStatus, "stale");
  assert.equal(JSON.stringify(h.feed.state.rows), before);
  h.feed.stop();
});

test("thinking and status notes keep their actual meaning and merchant identity", () => {
  const row = mergeActivityRows(
    [],
    [
      entry("1", {
        status: "thinking",
        phase: "inference",
        reason_kind: "status",
        reason: "Waiting",
      }),
    ],
  ).rows[0];
  assert.equal(row.title, "Model request in progress");
  assert.equal(row.reasonKind, "status");
  assert.match(row.detail, /Merchant: rex/);
});

for (const [name, change] of [
  [
    "numeric sequence",
    (value) => {
      value.entries[0].sequence = 1;
    },
  ],
  [
    "unknown fields",
    (value) => {
      value.private_prompt = "secret";
    },
  ],
  [
    "wrong network",
    (value) => {
      value.deployment.network_id = "mainnet";
    },
  ],
  [
    "model confirmation",
    (value) => {
      value.entries[0].status = "confirmed";
    },
  ],
  [
    "model trade amounts",
    (value) => {
      value.entries[0].trade = trade(fixture.final.trades.data.items[0]);
    },
  ],
  [
    "unbounded entries",
    (value) => {
      value.entries = Array.from({ length: 51 }, (_, index) =>
        entry(String(index + 1)),
      );
      value.high_water_sequence = "51";
    },
  ],
  [
    "nonprogressing page",
    (value) => {
      value.entries = [];
      value.has_more = true;
    },
  ],
  [
    "bad watermarks",
    (value) => {
      value.pruned_through = "2";
    },
  ],
  [
    "false live acceptance",
    (value) => {
      value.entries[0].live_ai_evidence = true;
    },
  ],
])
  test(`worker decoder rejects ${name}`, () => {
    const value = page();
    change(value);
    assert.throws(() => decodeActivityPage(value));
  });

test("trade observations deduplicate across direct RPC and repeated worker evidence", () => {
  const trades = chain().trades;
  const first = confirmedEntry("1"),
    second = confirmedEntry("2");
  const result = mergeActivityRows(trades, [first, second]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.filter((row) => row.id === "trade:1").length, 1);
  assert.match(result.rows[0].source, /Finalized contract/);
  const workerOnly = mergeActivityRows([], [first, second]);
  assert.equal(workerOnly.rows.length, 1);
  assert.doesNotMatch(workerOnly.rows[0].source, /Finalized contract/);
});

test("conflicting worker trade terms never replace finalized contract terms", () => {
  const wrong = { ...chain().trades[0], quantity: "1", total_price: "4" };
  const result = mergeActivityRows(chain().trades, [
    confirmedEntry("1", wrong),
  ]);
  assert.equal(result.conflict, true);
  assert.match(result.rows[0].detail, /12 crystal/);
  assert.doesNotMatch(result.rows[0].detail, /1 crystal /);
});

test("submitted transactions, proposals and incomplete action checkpoints are separate from transfers", () => {
  const rows = mergeActivityRows(
    [],
    [
      entry(),
      entry("2", {
        source: "system",
        status: "submitted",
        phase: "transaction",
        reason: null,
        reason_kind: null,
      }),
      entry("3", {
        source: "chain",
        status: "confirmed",
        phase: "transaction",
        reason: null,
        reason_kind: null,
        transaction: {
          signed_hash: null,
          receipt_hash: null,
          explorer_url: null,
          evidence: "action_checkpoint",
          evidence_incomplete: true,
        },
      }),
    ],
  ).rows;
  assert.equal(
    rows.filter((row) => /trade confirmed|purchase confirmed/.test(row.title))
      .length,
    0,
  );
  assert.equal(rows[2].incomplete, true);
  assert.match(rows[1].detail, /confirmation is outstanding/);
});

test("worker outages preserve independently read finalized contract trades", async () => {
  const h = harness();
  h.behavior.worker = async () => {
    throw new Error("private origin details");
  };
  await h.start();
  assert.equal(h.feed.state.chainStatus, "ready");
  assert.equal(h.feed.state.workerStatus, "unavailable");
  assert.equal(h.feed.state.rows.length, 2);
  assert.ok(h.feed.state.rows.every((row) => row.reason === null));
  assert.equal(JSON.stringify(h.feed.state).includes("private"), false);
  h.feed.stop();
});

test("worker history waits for an actual chain code identity before advancing its cursor", async () => {
  const h = harness();
  h.behavior.chain = async () => {
    throw new Error("offline");
  };
  await h.start();
  assert.equal(h.feed.state.workerStatus, "waiting");
  assert.equal(h.feed.state.rows.length, 0);
  h.behavior.chain = async () => chain();
  await h.feed.refresh();
  assert.deepEqual(h.calls.worker, [null, null]);
  assert.equal(h.feed.state.workerStatus, "ready");
  h.feed.stop();
});

test("opaque worker pagination and chain IDs remain separate and save empty-page cursors", async () => {
  const h = harness();
  h.behavior.worker = async (after) =>
    after === null
      ? page([entry()], { has_more: true })
      : after === "cursor_1"
        ? page([entry("2")])
        : page([], { next_after: "cursor_empty", high_water_sequence: "2" });
  await h.start();
  await h.feed.refresh();
  await h.feed.refresh();
  await h.feed.refresh();
  assert.deepEqual(h.calls.worker, [
    null,
    "cursor_1",
    "cursor_2",
    "cursor_empty",
  ]);
  assert.deepEqual(h.calls.chain, [null, "2", "2", "2"]);
  assert.equal(
    h.feed.state.rows.filter((row) => row.source === "Worker model record")
      .length,
    2,
  );
  h.feed.stop();
});

test("a generation mismatch resets only worker history and reloads from the beginning", async () => {
  const h = harness();
  await h.start();
  h.behavior.worker = async () => {
    throw new ActivityReadError("generation");
  };
  await h.feed.refresh();
  assert.equal(h.feed.state.rows.length, 2);
  assert.equal(h.feed.state.historyGap, true);
  h.behavior.worker = async () =>
    page([entry()], {
      feed_generation: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
  await h.feed.refresh();
  assert.equal(h.calls.worker.at(-1), null);
  assert.equal(h.feed.state.rows.length, 3);
  h.feed.stop();
});

test("a changed generation in a successful cursor response is discarded before restarting", async () => {
  const h = harness();
  await h.start();
  const next = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  h.behavior.worker = async (after) =>
    after
      ? page([entry("100")], { feed_generation: next })
      : page([entry()], { feed_generation: next });
  await h.feed.refresh();
  assert.equal(h.feed.state.rows.length, 2);
  await h.feed.refresh();
  assert.equal(h.calls.worker.at(-1), null);
  assert.equal(
    h.feed.state.rows.some((row) => row.id === `worker:${entry("100").id}`),
    false,
  );
  h.feed.stop();
});

test("empty retention-gap pages still refresh authoritative state and retain their next cursor", async () => {
  const h = harness();
  h.behavior.worker = async () =>
    page([], {
      history_gap: true,
      high_water_sequence: "50",
      pruned_through: "50",
      next_after: "cursor_50",
    });
  await h.start();
  const gaps = h.calls.gaps;
  assert.ok(gaps > 0);
  assert.equal(h.feed.state.historyGap, true);
  await h.feed.refresh();
  assert.equal(h.calls.worker.at(-1), "cursor_50");
  assert.equal(h.calls.gaps, gaps);
  h.feed.stop();
});

test("a wrong worker code hash hides its entries while contract trades remain", async () => {
  const h = harness();
  h.behavior.worker = async () =>
    page([entry()], {
      deployment: {
        ...page().deployment,
        expected_code_hash: fixture.final.finalized_block.hash,
      },
    });
  await h.start();
  assert.equal(h.feed.state.workerStatus, "mismatch");
  assert.equal(h.feed.state.rows.length, 2);
  h.feed.stop();
});

test("a changed contract code clears old history and restarts both source cursors", async () => {
  const h = harness();
  await h.start();
  const code = fixture.final.finalized_block.hash;
  h.behavior.chain = async (after) =>
    chain({ codeHash: code, trades: after === null ? chain().trades : [] });
  h.behavior.worker = async () =>
    page([entry()], {
      deployment: { ...page().deployment, expected_code_hash: code },
    });
  await h.feed.refresh();
  assert.equal(h.feed.state.rows.length, 0);
  await h.feed.refresh();
  assert.equal(h.calls.chain.at(-1), null);
  assert.equal(h.calls.worker.at(-1), null);
  assert.equal(h.feed.state.rows.length, 3);
  h.feed.stop();
});

test("polls never overlap and late hidden-generation results cannot replace resumed state", async () => {
  const h = harness();
  let resolveChain, resolveWorker;
  h.behavior.chain = () =>
    new Promise((done) => {
      resolveChain = done;
    });
  h.behavior.worker = () =>
    new Promise((done) => {
      resolveWorker = done;
    });
  h.feed.start();
  await h.feed.refresh();
  assert.equal(h.calls.chain.length, 1);
  assert.equal(h.calls.worker.length, 1);
  h.feed.stop();
  h.feed.start();
  resolveChain(chain());
  resolveWorker(page());
  await settle();
  assert.equal(h.feed.state.rows.length, 0);
  h.behavior.chain = async () => chain();
  h.behavior.worker = async () => page();
  await h.advance(0);
  assert.equal(h.feed.state.rows.length, 3);
  h.feed.stop();
  assert.equal(h.timers.size, 0);
});

test("loaded memory is bounded and trimming is disclosed", async () => {
  const h = harness();
  let sequence = 0;
  h.behavior.worker = async () =>
    page(
      Array.from({ length: 50 }, () => entry(String(++sequence))),
      { has_more: true },
    );
  await h.start();
  for (let index = 0; index < 4; index++) await h.feed.refresh();
  assert.equal(h.feed.state.trimmed, true);
  assert.equal(
    h.feed.state.rows.filter((row) => row.source === "Worker model record")
      .length,
    200,
  );
  h.feed.stop();
});

test("worker reader uses a bounded credential-free GET and preserves the opaque cursor", async () => {
  let request;
  const reads = createActivityReads(config, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify(page()), {
      headers: { "content-type": "application/json" },
    });
  });
  await reads.worker("opaque_cursor");
  assert.equal(new URL(request.url).pathname, "/activity");
  assert.equal(new URL(request.url).searchParams.get("after"), "opaque_cursor");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.headers.Authorization, undefined);
  assert.ok(request.options.signal instanceof AbortSignal);
});

test("oversized and private/malformed worker responses are rejected with fixed errors", async () => {
  for (const body of [
    "x".repeat(262145),
    JSON.stringify({ private_prompt: "do not expose" }),
  ]) {
    const reads = createActivityReads(
      config,
      async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    );
    await assert.rejects(reads.worker(null), /Activity read: invalid/);
  }
});

test("worker HTTP generation/deployment errors are handled without exposing response details", async () => {
  const reads = createActivityReads(
    config,
    async () =>
      new Response(
        JSON.stringify({
          error: "feed_generation_mismatch",
          reset_required: true,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(reads.worker("cursor"), /Activity read: generation/);
});

test("direct trade reader pins market, code and trades to one finalized block and omits player IDs", async () => {
  const requests = [],
    block = fixture.final.finalized_block;
  const reads = createActivityReads(
    config,
    async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      let result;
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
        result =
          request.params.request_type === "view_account"
            ? {
                code_hash: fixture.code_hash,
                block_hash: block.hash,
                block_height: block.height,
              }
            : {
                result: [
                  ...Buffer.from(
                    JSON.stringify(
                      request.params.method_name === "get_market_state"
                        ? fixture.final.market
                        : fixture.final.trades,
                    ),
                  ),
                ],
                block_hash: block.hash,
                block_height: block.height,
              };
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      );
    },
    () => time,
  );
  const value = await reads.chain(null);
  assert.equal(value.trades.length, 2);
  assert.equal(value.trades[0].buyer, null);
  assert.equal(JSON.stringify(value).includes("player-bazaar.testnet"), false);
  assert.equal(value.codeHash, fixture.code_hash);
  const tradeRequest = requests.find(
    (row) => row.params?.method_name === "get_recent_trades",
  );
  assert.equal(
    JSON.parse(Buffer.from(tradeRequest.params.args_base64, "base64"))
      .expected_revision,
    fixture.final.market.market_revision,
  );
  assert.deepEqual(plain(requests.map((row) => row.method)), [
    "status",
    "block",
    "query",
    "query",
    "query",
  ]);
});
