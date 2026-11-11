import assert from "node:assert/strict";
import test from "node:test";
import {
  createMarketCall,
  createRpcTransport,
  decodeCallResult,
  parseU64,
  verifyFinalReceipt,
} from "@bot-bazaar/chain";
import { captured, changeView, fixture, proofFor } from "./chain-fixture.mjs";

test("canonical contract decimals preserve the full u64 range", () => {
  for (const value of ["0", "9007199254740993", "18446744073709551615"])
    assert.equal(parseU64(value), value);
  for (const value of [
    0,
    1.5,
    -1,
    "",
    "00",
    "01",
    "+1",
    "-1",
    "1e3",
    " 1",
    "1.0",
    "18446744073709551616",
    "9".repeat(10000),
    null,
  ])
    assert.throws(() => parseU64(value));
});

test("typed call wrappers validate every public economic/admin method", () => {
  const calls = [
    ["register_player", {}],
    [
      "buy_from_merchant",
      {
        merchant_id: "rex",
        resource: "crystal",
        quantity: "12",
        max_total_price: "48",
        listing_version: "1",
      },
    ],
    [
      "set_listing",
      {
        merchant_id: "rex",
        resource: "crystal",
        unit_price: "4",
        quantity: "1",
        active: true,
        expected_version: "1",
        action_id: "1",
      },
    ],
    ["propose_trade", captured.steps[2].args],
    ["accept_trade", { offer_id: "1", action_id: "1" }],
    ["cancel_trade", { offer_id: "1", action_id: "1" }],
    ["expire_offers", { offer_ids: ["1", "18446744073709551615"] }],
    ["pause_market", {}],
    ["resume_market", {}],
  ];
  for (const [method, args] of calls) {
    assert.deepEqual(createMarketCall(method, args), {
      method,
      args,
      deposit: "0",
    });
    assert.throws(() =>
      createMarketCall(method, { ...args, extra: "unexpected" }),
    );
  }
  assert.throws(() => createMarketCall("initialize_market", {}));
  for (const ids of [
    [],
    ["1", "1"],
    ["0"],
    Array.from({ length: 25 }, (_, i) => String(i + 1)),
  ])
    assert.throws(() => createMarketCall("expire_offers", { offer_ids: ids }));
  assert.throws(() =>
    createMarketCall("propose_trade", {
      ...captured.steps[2].args,
      seller: "rex",
    }),
  );
  assert.throws(() =>
    createMarketCall("propose_trade", {
      ...captured.steps[2].args,
      total_price: "25",
    }),
  );
});

test("all six typed views read one finalized block and retain bounded cursors", async () => {
  const f = fixture({ state: "final" });
  const reader = await f.client.finalized();
  const market = await reader.getMarketState();
  assert.equal(market.data.total_issued_gold, "650");
  assert.equal(
    (await reader.getPlayer("player-bazaar.testnet")).data.gold,
    "52",
  );
  assert.equal((await reader.getMerchant("rex")).data.gold, "204");
  assert.equal((await reader.getOffer("1")).data.offer.status, "accepted");
  const args = { after_id: null, limit: "1", expected_revision: "5" };
  const first = await reader.getRecentTrades(args);
  assert.equal(first.data.items[0].trade_id, "1");
  assert.equal(first.data.has_more, true);
  const next = await reader.getRecentTrades({
    ...args,
    after_id: first.data.next_after_id,
  });
  assert.equal(next.data.items[0].trade_id, "2");
  assert.equal(next.data.has_more, false);
  assert.equal(
    (await reader.getOffersForMerchant("luna", "terminal", args)).data.items[0]
      .offer_id,
    "1",
  );
  await assert.rejects(reader.getRecentTrades({ ...args, limit: "51" }));
  await assert.rejects(
    reader.getRecentTrades({ ...args, expected_revision: "4" }),
  );
  for (const call of f.calls.filter((row) => row.method === "query"))
    assert.equal(call.params.block_id, reader.block.hash);
});

for (const [name, patch] of [
  [
    "wrong query block",
    (m, p, r) =>
      m === "query"
        ? { ...r, block_hash: captured.seed.finalized_block.hash }
        : r,
  ],
  [
    "numeric contract gold",
    (m, p, r) =>
      p?.method_name === "get_market_state"
        ? changeView(r, (v) => (v.data.merchants[0].gold = 204))
        : r,
  ],
  [
    "unknown contract field",
    (m, p, r) =>
      p?.method_name === "get_market_state"
        ? changeView(r, (v) => (v.data.extra = true))
        : r,
  ],
  [
    "wrong player identity",
    (m, p, r) =>
      p?.method_name === "get_player"
        ? changeView(r, (v) => (v.data.account_id = "attacker.testnet"))
        : r,
  ],
  [
    "unsafe RPC height",
    (m, p, r) =>
      m === "block"
        ? { header: { ...r.header, height: Number.MAX_SAFE_INTEGER + 1 } }
        : r,
  ],
])
  test(`reader rejects ${name}`, async () => {
    const f = fixture({ state: "final", patch });
    await assert.rejects(async () => {
      const reader = await f.client.finalized();
      await reader.getMarketState();
      await reader.getPlayer("player-bazaar.testnet");
    });
  });

test("captured Testnet receipts decode with exact provenance and stored terms", async () => {
  for (const step of captured.steps) {
    const status = await verifyFinalReceipt(step.receipt, proofFor(step));
    assert.equal(status.kind, "succeeded");
    assert.deepEqual(status.result, step.result);
    assert.deepEqual(decodeCallResult(step.method, step.result), step.result);
  }
});

for (const [name, change] of [
  ["hash", (r) => (r.transaction.hash = captured.seed.finalized_block.hash)],
  ["signer", (r) => (r.transaction.signer_id = "attacker.testnet")],
  ["receiver", (r) => (r.transaction.receiver_id = "attacker.testnet")],
  ["public key", (r) => (r.transaction.public_key = "ed25519:wrong")],
  ["nonce", (r) => r.transaction.nonce++],
  [
    "method",
    (r) => (r.transaction.actions[0].FunctionCall.method_name = "cancel_trade"),
  ],
  ["deposit", (r) => (r.transaction.actions[0].FunctionCall.deposit = "1")],
  ["missing receipt", (r) => r.receipts_outcome.pop()],
  ["duplicate receipt", (r) => r.receipts_outcome.push(r.receipts_outcome[0])],
  [
    "wrong executor",
    (r) => (r.receipts_outcome[0].outcome.executor_id = "attacker.testnet"),
  ],
  [
    "inconsistent failure",
    (r) =>
      (r.receipts_outcome[0].outcome.status = {
        Failure: { error: "BB:E_ACTION_USED" },
      }),
  ],
  [
    "malformed return",
    (r) =>
      (r.status.SuccessValue = Buffer.from('{"market_revision":4}').toString(
        "base64",
      )),
  ],
])
  test(`final receipt rejects ${name}`, async () => {
    const step = captured.steps[2],
      value = structuredClone(step.receipt);
    change(value);
    await assert.rejects(verifyFinalReceipt(value, proofFor(step)));
  });

test("pending, unknown, and failed execution never confirm success logs", async () => {
  const step = captured.steps[3],
    proof = proofFor(step);
  assert.equal(
    (await verifyFinalReceipt({ final_execution_status: "NONE" }, proof)).kind,
    "unknown",
  );
  const pending = {
    ...step.receipt,
    final_execution_status: "EXECUTED_OPTIMISTIC",
  };
  assert.equal((await verifyFinalReceipt(pending, proof)).kind, "pending");
  const failed = structuredClone(step.receipt);
  failed.status = { Failure: { error: "BB:E_OFFER_EXPIRED" } };
  failed.receipts_outcome[0].outcome.status = failed.status;
  assert.equal((await verifyFinalReceipt(failed, proof)).kind, "failed");
  const noLogs = structuredClone(step.receipt);
  noLogs.receipts_outcome.forEach((row) => (row.outcome.logs = []));
  assert.equal((await verifyFinalReceipt(noLogs, proof)).kind, "succeeded");
});

test("transport bounds responses, validates RPC identity and sanitizes errors", async () => {
  assert.throws(() => createRpcTransport("https://rpc.mainnet.near.org"));
  const ok = createRpcTransport(
    "https://test.rpc.fastnear.com",
    async (_url, options) => {
      const req = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: { answer: "42" },
        }),
      );
    },
  );
  assert.deepEqual(await ok("status", {}), { answer: "42" });
  for (const fetcher of [
    async () => {
      throw new Error("secret canary");
    },
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: {} })),
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    async (_url, options) =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(options.body).id,
          error: {
            message: "secret canary",
            cause: { name: "UNKNOWN_TRANSACTION" },
          },
        }),
      ),
  ]) {
    await assert.rejects(
      createRpcTransport("https://test.rpc.fastnear.com", fetcher)("tx", {}),
      (error) => !error.message.includes("canary"),
    );
  }
});

test("RPC diagnostics retain protocol causes without provider messages or payloads", async () => {
  for (const name of ["INVALID_TRANSACTION", "secret canary"]) {
    const rpc = createRpcTransport("https://test.rpc.fastnear.com", async (_url, options) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(options.body).id,
        error: { message: "secret canary", cause: { name, info: { signed_tx_base64: "secret canary" } } } })));
    await assert.rejects(rpc("send_tx", {}), error => {
      assert.equal(error.code, "REJECTED");
      assert.equal(error.rpcCause, name === "INVALID_TRANSACTION" ? name : undefined);
      assert.equal(JSON.stringify(error).includes("canary"), false);
      return true;
    });
  }
});
