import assert from "node:assert/strict";
import test from "node:test";
import { SignedTransaction } from "near-api-js";
import { merchantActionDigest } from "@bot-bazaar/chain";
import { captured, changeView, fixture } from "./chain-fixture.mjs";

const listing = (id = "rex") => ({
  merchant_id: id,
  resource: "crystal",
  unit_price: "4",
  quantity: "1",
  active: true,
  expected_version: "1",
  action_id: "1",
});
const proposal = () => structuredClone(captured.steps[2].args);

test("each merchant signs only with its selected restricted key; preparation never broadcasts", async () => {
  for (const id of ["rex", "luna", "bolt"]) {
    const f = fixture();
    const prepared = await f.adapter.prepareSetListing(id, listing(id));
    const tx = SignedTransaction.decode(
      Buffer.from(prepared.signedTransactionBase64, "base64"),
    ).transaction;
    assert.equal(tx.signerId, f.identity.controllers[id]);
    assert.equal(tx.publicKey.toString(), f.credentials[id].publicKey);
    assert.equal(tx.receiverId, f.identity.contractId);
    assert.equal(tx.actions[0].functionCall.deposit, 0n);
    assert.equal(tx.actions[0].functionCall.methodName, "set_listing");
    assert.deepEqual(f.loads, [id]);
    assert.equal(
      f.calls.some((row) => ["send_tx", "tx"].includes(row.method)),
      false,
    );
    assert.equal(Object.isFrozen(prepared.args), true);
  }
});

for (const [name, patch] of [
  [
    "wrong network",
    (method, _params, result) =>
      method === "status" ? { ...result, chain_id: "mainnet" } : result,
  ],
  [
    "syncing RPC",
    (method, _params, result) =>
      method === "status"
        ? { ...result, sync_info: { syncing: true } }
        : result,
  ],
  [
    "unavailable verification",
    () => {
      throw new Error("unavailable");
    },
  ],
  [
    "wrong code",
    (_method, params, result) =>
      params.request_type === "view_account"
        ? { ...result, code_hash: "11111111111111111111111111111111" }
        : result,
  ],
  [
    "unavailable pinned block",
    (method, params, result) => {
      if (method === "query" && params.request_type === "view_account")
        throw new Error("UNKNOWN_BLOCK");
      return result;
    },
  ],
  [
    "wrong query block",
    (method, _params, result) =>
      method === "query"
        ? { ...result, block_hash: "11111111111111111111111111111111" }
        : result,
  ],
  [
    "wrong owner",
    (_method, params, result) =>
      params.method_name === "get_market_state"
        ? changeView(result, (v) => {
            v.data.owner_account_id = "other.testnet";
          })
        : result,
  ],
  [
    "wrong controller",
    (_method, params, result) =>
      params.method_name === "get_market_state"
        ? changeView(result, (v) => {
            v.data.merchants[0].controller_account_id = "other.testnet";
          })
        : result,
  ],
  [
    "full access key",
    (_method, params, result) =>
      params.request_type === "view_access_key"
        ? { ...result, permission: "FullAccess" }
        : result,
  ],
  [
    "unlimited allowance",
    (_method, params, result) =>
      params.request_type === "view_access_key"
        ? {
            ...result,
            permission: {
              FunctionCall: {
                ...result.permission.FunctionCall,
                allowance: null,
              },
            },
          }
        : result,
  ],
  [
    "wrong receiver",
    (_method, params, result) =>
      params.request_type === "view_access_key"
        ? {
            ...result,
            permission: {
              FunctionCall: {
                ...result.permission.FunctionCall,
                receiver_id: "other.testnet",
              },
            },
          }
        : result,
  ],
  [
    "extra allowed method",
    (_method, params, result) =>
      params.request_type === "view_access_key"
        ? {
            ...result,
            permission: {
              FunctionCall: {
                ...result.permission.FunctionCall,
                method_names: [
                  ...result.permission.FunctionCall.method_names,
                  "pause_market",
                ],
              },
            },
          }
        : result,
  ],
])
  test(`pre-sign ${name} stops before credential access`, async () => {
    const f = fixture({ patch });
    await assert.rejects(f.adapter.prepareSetListing("rex", listing()));
    assert.deepEqual(f.loads, []);
    assert.equal(
      f.calls.some((row) => row.method === "send_tx"),
      false,
    );
  });

test("every new signature rechecks the deployment", async () => {
  let codeChanged = false;
  const f = fixture({
    patch: (_method, params, result) =>
      codeChanged && params.request_type === "view_account"
        ? { ...result, code_hash: "11111111111111111111111111111111" }
        : result,
  });
  await f.adapter.prepareSetListing("rex", listing());
  codeChanged = true;
  await assert.rejects(f.adapter.prepareSetListing("rex", listing()));
  assert.deepEqual(f.loads, ["rex"]);
  assert.equal(f.calls.filter((row) => row.method === "status").length, 2);
});

test("pause blocks economic actions while allowing cancellation and cleanup", async () => {
  const patch = (_method, params, result) =>
    params.method_name === "get_market_state"
      ? changeView(result, (v) => {
          v.data.paused = true;
        })
      : result;
  const f = fixture({ state: "pending", patch });
  await assert.rejects(
    f.adapter.prepareSetListing("rex", { ...listing(), action_id: "2" }),
  );
  await assert.rejects(
    f.adapter.prepareProposal("rex", { ...proposal(), action_id: "2" }),
  );
  await assert.rejects(
    f.adapter.prepareAcceptance("luna", { offer_id: "1", action_id: "1" }),
  );
  assert.deepEqual(f.loads, []);
  assert.equal(
    (
      await f.adapter.prepareCancellation("rex", {
        offer_id: "1",
        action_id: "2",
      })
    ).method,
    "cancel_trade",
  );
  assert.equal(
    (await f.adapter.prepareExpiry("bolt", { offer_ids: ["1"] })).method,
    "expire_offers",
  );
  assert.deepEqual(f.loads, ["rex", "bolt"]);
});

test("stored offer roles and expiry authorize acceptance, never caller-supplied terms", async () => {
  const f = fixture({ state: "pending" });
  await assert.rejects(
    f.adapter.prepareAcceptance("rex", { offer_id: "1", action_id: "2" }),
  );
  await assert.rejects(
    f.adapter.prepareCancellation("luna", { offer_id: "1", action_id: "1" }),
  );
  await assert.rejects(
    f.adapter.prepareAcceptance("luna", {
      offer_id: "1",
      action_id: "1",
      quantity: "1",
    }),
  );
  await assert.rejects(
    f.adapter.prepareAcceptance("luna", { offer_id: "2", action_id: "1" }),
  );
  assert.deepEqual(f.loads, []);
  assert.equal(
    (
      await f.adapter.prepareAcceptance("luna", {
        offer_id: "1",
        action_id: "1",
      })
    ).signerId,
    f.identity.controllers.luna,
  );
  const expired = fixture({
    state: "pending",
    patch: (_method, params, result) =>
      params.method_name === "get_offer"
        ? changeView(result, (v) => {
            v.data.offer.expires_at_ns = "1";
          })
        : result,
  });
  await assert.rejects(
    expired.adapter.prepareAcceptance("luna", {
      offer_id: "1",
      action_id: "1",
    }),
  );
  const terminal = fixture({ state: "final" });
  await assert.rejects(
    terminal.adapter.prepareAcceptance("luna", {
      offer_id: "1",
      action_id: "2",
    }),
  );
  assert.deepEqual(expired.loads, []);
  assert.deepEqual(terminal.loads, []);
});

test("signer identity, action sequence and method scope are checked before secrets", async () => {
  const f = fixture();
  await assert.rejects(f.adapter.prepareSetListing("luna", listing()));
  await assert.rejects(f.adapter.prepareProposal("luna", proposal()));
  await assert.rejects(
    f.adapter.prepareSetListing("rex", { ...listing(), action_id: "0" }),
  );
  await assert.rejects(
    f.adapter.prepareSetListing("rex", { ...listing(), action_id: "2" }),
  );
  await assert.rejects(f.adapter.prepare("rex", "pause_market", {}));
  assert.deepEqual(f.loads, []);
});

test("caller mutation during verification cannot replace the signed intent", async () => {
  const args = listing();
  const f = fixture({
    patch: (method, _params, result) => {
      if (method === "status") args.unit_price = "100";
      return result;
    },
  });
  const prepared = await f.adapter.prepareSetListing("rex", args);
  assert.equal(args.unit_price, "100");
  assert.equal(prepared.args.unit_price, "4");
});

test("submission timeout keeps the original identity without re-signing or retry", async () => {
  const f = fixture({
    patch: (method, _params, result) => {
      if (method === "send_tx") throw new Error("timeout");
      return result;
    },
  });
  const prepared = await f.adapter.prepareProposal("rex", proposal());
  assert.deepEqual(await f.adapter.submit(prepared), {
    kind: "unknown",
    transactionHash: prepared.transactionHash,
  });
  assert.deepEqual(await f.adapter.status(prepared), {
    kind: "unknown",
    transactionHash: prepared.transactionHash,
  });
  assert.equal(f.calls.filter((row) => row.method === "send_tx").length, 1);
  assert.deepEqual(f.loads, ["rex"]);
  for (const replacement of [
    { nonce: "1" },
    { merchantId: "luna" },
    { args: { ...prepared.args, total_price: "30" } },
    { transactionHash: "11111111111111111111111111111111" },
  ])
    await assert.rejects(f.adapter.submit({ ...prepared, ...replacement }));
  assert.equal(f.calls.filter((row) => row.method === "send_tx").length, 1);
});

test("worker distinguishes submitted, pending, finalized success, failed and unknown", async () => {
  let response;
  const f = fixture({
    patch: (method, _params, result) => (method === "tx" ? response : result),
  });
  const prepared = await f.adapter.prepareProposal("rex", proposal());
  assert.equal((await f.adapter.submit(prepared)).kind, "submitted");
  response = structuredClone(captured.steps[2].receipt);
  Object.assign(response.transaction, {
    hash: prepared.transactionHash,
    public_key: prepared.publicKey,
    nonce: Number(prepared.nonce),
  });
  response.transaction_outcome.id = prepared.transactionHash;
  const result = structuredClone(captured.steps[2].result);
  result.data.action.args_sha256 = await merchantActionDigest({
    method: "propose_trade",
    args: prepared.args,
  });
  const encoded = Buffer.from(JSON.stringify(result)).toString("base64");
  response.status = { SuccessValue: encoded };
  const contractReceipt = response.receipts_outcome.find(
    (row) =>
      row.id === response.transaction_outcome.outcome.status.SuccessReceiptId,
  );
  contractReceipt.outcome.status = { SuccessValue: encoded };
  response.final_execution_status = "EXECUTED";
  assert.equal((await f.adapter.status(prepared)).kind, "pending");
  response.final_execution_status = "FINAL";
  assert.equal((await f.adapter.status(prepared)).kind, "succeeded");
  contractReceipt.outcome.status = { Failure: { ActionError: {} } };
  response.status = { Failure: { ActionError: {} } };
  assert.equal((await f.adapter.status(prepared)).kind, "failed");
  response.transaction.receiver_id = "other.testnet";
  assert.equal((await f.adapter.status(prepared)).kind, "unknown");
  assert.deepEqual(f.loads, ["rex"]);
});
