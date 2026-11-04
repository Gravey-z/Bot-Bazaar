import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, lstat } from "node:fs/promises";
import {
  createMarketCall,
  decodeCallResult,
  verifyFinalReceipt,
} from "../packages/chain/dist/index.js";
import {
  accountId,
  hash32,
  publicKey,
  parseU64,
  snapshot,
  market,
  player,
  object,
} from "../packages/chain/dist/wire.js";
import {
  decodeBase64Json,
  encodeArguments,
} from "../packages/chain/dist/rpc.js";

export const replayFileLimit = 5 * 1024 * 1024;
export const replayCollectionLimit = 20 * 1024 * 1024;
const merchants = ["rex", "luna", "bolt"];
const resources = ["crystal", "wood", "herb", "iron"];
const supply = { crystal: "29", wood: "25", herb: "26", iron: "24" };
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function exact(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  return value;
}
export function utc(value) {
  assert.equal(typeof value, "string");
  const date = Date.parse(value);
  assert.ok(Number.isFinite(date) && new Date(date).toISOString() === value);
  return date;
}
const id = (value) => {
  assert.equal(typeof value, "string");
  assert.match(value, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
  publicText(value, 96);
  return value;
};
export function publicText(value, maximum = 240) {
  assert.equal(typeof value, "string");
  assert.ok(value.trim() && [...value].length <= maximum);
  assert.ok(
    !/[<>\u202a-\u202e\u2066-\u2069]/u.test(value) &&
      ![...value].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }),
  );
  assert.ok(
    !/(?:\bsk-[a-z0-9_-]{8,}|(?:secret|api)[_ -]?key|bearer\s|authorization|ed25519:|BEGIN .*PRIVATE KEY|[a-z]:\\|\/(?:home|users|tmp)\/)/iu.test(
      value,
    ),
    "Public text contains a secret or private-path marker",
  );
  return value;
}
const testnetAccount = (value) => {
  accountId(value);
  assert.ok(value.endsWith(".testnet"));
  return value;
};
const list = (value, maximum) => {
  assert.ok(Array.isArray(value) && value.length <= maximum);
  return value;
};
const equal = (a, b) => assert.deepEqual(a, b);
const increment = (value) => String(BigInt(value) + 1n);

// Read no more than the configured limit, even if the file grows after stat.
export async function readReplayBytes(path) {
  assert.ok((await lstat(path)).isFile(), "Expected a regular JSON file");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(replayFileLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    assert.ok(length <= replayFileLimit, "Replay exceeds 5 MiB");
    const content = bytes.subarray(0, length);
    return content;
  } finally {
    await file.close();
  }
}
export async function readReplayJson(path) {
  const bytes = await readReplayBytes(path);
  return {
    bytes,
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  };
}

// Project RPC responses instead of publishing headers, signatures, raw logs,
// proof arrays or arbitrary provider fields. Only contract calls are supported.
export function sanitizeReplayReceipt(raw) {
  const tx = raw.transaction;
  assert.equal(raw.final_execution_status, "FINAL");
  assert.equal(tx.actions.length, 1);
  const call = tx.actions[0].FunctionCall;
  assert.equal(call.deposit, "0");
  const parsed = createMarketCall(
    call.method_name,
    decodeBase64Json(call.args),
  );
  const finalValue = raw.status.SuccessValue;
  const cleanReturn = encodeArguments(
    decodeCallResult(parsed.method, decodeBase64Json(finalValue)),
  );
  const status = (value) => {
    assert.equal(Object.keys(value).length, 1);
    if (Object.hasOwn(value, "SuccessReceiptId"))
      return { SuccessReceiptId: hash32(value.SuccessReceiptId) };
    assert.equal(typeof value.SuccessValue, "string");
    if (value.SuccessValue === "") return { SuccessValue: "" };
    assert.equal(value.SuccessValue, finalValue);
    return { SuccessValue: cleanReturn };
  };
  const outcome = (value) => ({
    id: hash32(value.id),
    block_hash: hash32(value.block_hash),
    outcome: {
      executor_id: testnetAccount(value.outcome.executor_id),
      receipt_ids: list(value.outcome.receipt_ids, 128).map(hash32),
      status: status(value.outcome.status),
    },
  });
  return {
    final_execution_status: "FINAL",
    transaction: {
      hash: hash32(tx.hash),
      signer_id: testnetAccount(tx.signer_id),
      receiver_id: testnetAccount(tx.receiver_id),
      public_key: publicKey(tx.public_key),
      nonce: parseU64(String(tx.nonce)),
      actions: [
        {
          FunctionCall: {
            method_name: parsed.method,
            args: encodeArguments(parsed.args),
            gas: parseU64(String(call.gas)),
            deposit: "0",
          },
        },
      ],
    },
    transaction_outcome: outcome(raw.transaction_outcome),
    receipts_outcome: list(raw.receipts_outcome, 128).map(outcome),
    status: status(raw.status),
  };
}

function checkpoint(value, identity, playerId) {
  exact(value, ["capturedAt", "block", "market", "player"]);
  utc(value.capturedAt);
  exact(value.block, ["hash", "height", "timestampNs"]);
  hash32(value.block.hash);
  parseU64(value.block.height);
  parseU64(value.block.timestampNs);
  const state = snapshot(market)(value.market);
  const wallet = snapshot(player)(value.player);
  for (const item of [state, wallet]) {
    equal(item.block_height, value.block.height);
    equal(item.block_timestamp_ns, value.block.timestampNs);
    equal(item.market_revision, state.market_revision);
  }
  assert.ok(
    BigInt(value.block.timestampNs) / 1000000n <= BigInt(utc(value.capturedAt)),
  );
  equal(wallet.data.account_id, playerId);
  equal(state.data.contract_account_id, identity.contractId);
  equal(state.data.owner_account_id, identity.contractId);
  equal(state.data.paused, false);
  equal(state.data.registered_player_count, "1");
  equal(state.data.total_issued_gold, "650");
  equal(state.data.resource_supply, supply);
  equal(
    state.data.merchants.map((m) => m.merchant_id),
    merchants,
  );
  for (const m of state.data.merchants) {
    equal(m.controller_account_id, identity.controllers[m.merchant_id]);
    for (const listing of m.listings) {
      assert.ok(
        BigInt(listing.quantity) <= BigInt(m.inventory[listing.resource]),
      );
      equal(listing.active, listing.quantity !== "0");
    }
  }
  const actors = [wallet.data, ...state.data.merchants];
  equal(
    actors.reduce((sum, a) => sum + BigInt(a.gold), 0n),
    650n,
  );
  for (const resource of resources)
    equal(
      actors.reduce((sum, a) => sum + BigInt(a.inventory[resource]), 0n),
      BigInt(supply[resource]),
    );
  return value;
}

function applyTrade(expected, wallet, trade, purchase) {
  const find = (actor) =>
    actor.kind === "player"
      ? wallet
      : expected.merchants.find((m) => m.merchant_id === actor.merchant_id);
  const buyer = find(trade.buyer),
    seller = find(trade.seller);
  assert.ok(buyer && seller && buyer !== seller);
  const resource = trade.resource,
    quantity = BigInt(trade.quantity),
    total = BigInt(trade.total_price);
  for (const [actor, sign] of [
    [buyer, 1n],
    [seller, -1n],
  ]) {
    actor.gold = String(BigInt(actor.gold) - sign * total);
    actor.inventory[resource] = String(
      BigInt(actor.inventory[resource]) + sign * quantity,
    );
    if (actor.listings) {
      const listing = actor.listings.find((row) => row.resource === resource);
      listing.quantity = purchase
        ? String(BigInt(listing.quantity) - quantity)
        : String(
            BigInt(listing.quantity) < BigInt(actor.inventory[resource])
              ? BigInt(listing.quantity)
              : BigInt(actor.inventory[resource]),
          );
      listing.active = listing.active && listing.quantity !== "0";
      listing.version = increment(listing.version);
    }
  }
  equal(buyer.gold, trade.buyer_gold_after);
  equal(seller.gold, trade.seller_gold_after);
  equal(buyer.inventory[resource], trade.buyer_resource_after);
  equal(seller.inventory[resource], trade.seller_resource_after);
  equal(trade.trade_id, expected.next_trade_id);
  expected.next_trade_id = increment(expected.next_trade_id);
}

// Deliberately narrow v1: one registered player, no interleaving, one shortage
// purchase and one real proposal/acceptance pair. Unsupported runs fail closed.
export async function validateReplay(value) {
  exact(value, [
    "schema",
    "mode",
    "runId",
    "recordedFrom",
    "recordedTo",
    "identity",
    "versions",
    "initialization",
    "playerId",
    "checkpoints",
    "actions",
    "decisions",
    "verification",
    "conservation",
  ]);
  equal(value.schema, "bot-bazaar-replay-v1");
  assert.ok(["historical_replay", "test_fixture"].includes(value.mode));
  id(value.runId);
  const start = utc(value.recordedFrom),
    end = utc(value.recordedTo);
  assert.ok(start <= end && end <= Date.now());
  const identity = exact(value.identity, [
    "networkId",
    "genesisHash",
    "contractId",
    "codeHash",
    "controllers",
  ]);
  equal(identity.networkId, "testnet");
  hash32(identity.genesisHash);
  hash32(identity.codeHash);
  testnetAccount(identity.contractId);
  testnetAccount(value.playerId);
  exact(identity.controllers, merchants);
  Object.values(identity.controllers).forEach(testnetAccount);
  equal(
    new Set([
      identity.contractId,
      value.playerId,
      ...Object.values(identity.controllers),
    ]).size,
    5,
  );
  exact(value.versions, [
    "application",
    "contract",
    "policy",
    "prompt",
    "decisionSchema",
  ]);
  Object.values(value.versions).forEach((text) => publicText(text, 96));
  equal(value.versions.decisionSchema, "merchant-decision-v1");
  exact(value.initialization, ["transactionHash", "blockHash"]);
  hash32(value.initialization.transactionHash);
  hash32(value.initialization.blockHash);
  exact(value.verification, [
    "verifiedAt",
    "scope",
    "missingEvidence",
    "interleaving",
    "modelProvenance",
  ]);
  assert.ok(
    utc(value.verification.verifiedAt) >= end &&
      utc(value.verification.verifiedAt) <= Date.now(),
  );
  equal(value.verification.scope, "clean_single_player");
  equal(value.verification.missingEvidence, []);
  equal(value.verification.interleaving, false);
  equal(
    value.verification.modelProvenance,
    "operator_recorded_not_cryptographic",
  );
  equal(value.conservation, {
    seedGold: "550",
    playerIssuance: "100",
    totalGold: "650",
    resources: supply,
  });
  const actions = list(value.actions, 32),
    points = list(value.checkpoints, 33),
    decisions = list(value.decisions, 32);
  assert.ok(actions.length >= 3 && points.length === actions.length + 1);
  equal(new Set(actions.map((a) => id(a.id))).size, actions.length);
  equal(new Set(decisions.map((d) => id(d.id))).size, decisions.length);
  equal(new Set(decisions.map((d) => id(d.requestId))).size, decisions.length);
  const intentIds = actions
    .filter((a) => a.intentId !== null)
    .map((a) => id(a.intentId));
  equal(new Set(intentIds).size, intentIds.length);
  points.forEach((point) => checkpoint(point, identity, value.playerId));
  assert.ok(
    start <= utc(points[0].capturedAt) && utc(points.at(-1).capturedAt) <= end,
  );
  equal(points[0].market.market_revision, "2");
  equal(points[0].market.data.next_trade_id, "1");
  equal(points[0].market.data.next_offer_id, "1");
  equal(points[0].player.data.gold, "100");
  equal(points[0].player.data.inventory, {
    crystal: "0",
    wood: "0",
    herb: "0",
    iron: "0",
  });
  const seedInventories = [
    [15, 4, 2, 10],
    [12, 3, 20, 2],
    [2, 18, 4, 12],
  ];
  for (const [index, m] of points[0].market.data.merchants.entries()) {
    equal(m.gold, ["180", "220", "150"][index]);
    equal(
      resources.map((r) => m.inventory[r]),
      seedInventories[index].map(String),
    );
    equal(m.last_action_id, "0");
    equal(m.last_action, null);
  }
  const seenHashes = new Set([value.initialization.transactionHash]);
  let purchase = 0,
    proposal = null,
    settled = false;
  for (const [index, action] of actions.entries()) {
    exact(action, [
      "id",
      "source",
      "merchantId",
      "decisionId",
      "intentId",
      "explorerUrl",
      "receipt",
    ]);
    assert.ok(["player", "policy", "model"].includes(action.source));
    const raw = action.receipt;
    const receipt = sanitizeReplayReceipt(raw);
    equal(raw, receipt); // Unknown fields are rejected on import, never silently trusted.
    const tx = receipt.transaction,
      call = tx.actions[0].FunctionCall;
    const method = call.method_name,
      args = decodeBase64Json(call.args);
    assert.ok(
      [
        "buy_from_merchant",
        "set_listing",
        "propose_trade",
        "accept_trade",
      ].includes(method),
    );
    equal(tx.receiver_id, identity.contractId);
    equal(action.explorerUrl, `https://testnet.nearblocks.io/txns/${tx.hash}`);
    assert.ok(!seenHashes.has(tx.hash));
    seenHashes.add(tx.hash);
    if (method === "buy_from_merchant") {
      equal(index, 0);
      equal(++purchase, 1);
      equal(action.source, "player");
      equal(action.merchantId, null);
      equal(action.decisionId, null);
      equal(action.intentId, null);
      equal(tx.signer_id, value.playerId);
      equal(args.merchant_id, "rex");
      equal(args.resource, "crystal");
      equal(args.quantity, "12");
    } else {
      assert.ok(merchants.includes(action.merchantId));
      equal(tx.signer_id, identity.controllers[action.merchantId]);
      id(action.intentId);
      if (method === "set_listing") equal(args.merchant_id, action.merchantId);
      if (method === "propose_trade") equal(args.proposer, action.merchantId);
      if (action.source === "policy") {
        equal(method, "set_listing");
        equal(action.decisionId, null);
      } else {
        equal(action.source, "model");
        id(action.decisionId);
        const decision = decisions.find((d) => d.id === action.decisionId);
        assert.ok(decision);
        equal(decision.transactionId, action.id);
        equal(decision.merchantId, action.merchantId);
        equal(
          createMarketCall(decision.action.method, decision.action.args),
          createMarketCall(method, args),
        );
      }
    }
    const proof = {
      transactionHash: tx.hash,
      signerId: tx.signer_id,
      publicKey: tx.public_key,
      contractId: identity.contractId,
      nonce: tx.nonce,
      gas: call.gas,
      method,
      args,
      ...(action.merchantId ? { merchantId: action.merchantId } : {}),
    };
    const confirmed = await verifyFinalReceipt(receipt, proof);
    equal(confirmed.kind, "succeeded");
    const result = confirmed.result,
      before = points[index],
      after = points[index + 1];
    equal(result.market_revision, increment(before.market.market_revision));
    equal(after.market.market_revision, result.market_revision);
    assert.ok(
      BigInt(before.block.height) <= BigInt(result.block_height) &&
        BigInt(result.block_height) <= BigInt(after.block.height),
    );
    assert.ok(
      BigInt(before.block.timestampNs) <= BigInt(result.block_timestamp_ns) &&
        BigInt(result.block_timestamp_ns) <= BigInt(after.block.timestampNs),
    );
    assert.ok(utc(before.capturedAt) <= utc(after.capturedAt));
    const contractReceipt = receipt.receipts_outcome.find(
      (r) =>
        r.id === receipt.transaction_outcome.outcome.status.SuccessReceiptId,
    );
    for (const row of receipt.receipts_outcome)
      if (
        row.id !== contractReceipt.id &&
        Object.hasOwn(row.outcome.status, "SuccessValue")
      )
        equal(row.outcome.status.SuccessValue, "");
    equal(contractReceipt.block_hash, after.block.hash);
    equal(result.block_height, after.block.height);
    equal(result.block_timestamp_ns, after.block.timestampNs);
    const expected = structuredClone(before.market.data),
      wallet = structuredClone(before.player.data);
    if (method !== "buy_from_merchant") {
      const actor = expected.merchants.find(
        (m) => m.merchant_id === action.merchantId,
      );
      equal(args.action_id, increment(actor.last_action_id));
      actor.last_action_id = args.action_id;
      actor.last_action = result.data.action;
    }
    if (method === "buy_from_merchant") {
      const listing = expected.merchants[0].listings[0];
      equal(listing.unit_price, "4");
      equal(listing.version, args.listing_version);
      assert.ok(listing.active && BigInt(listing.quantity) >= 12n);
      equal(result.data.total_price, "48");
      applyTrade(expected, wallet, result.data, true);
    }
    if (method === "set_listing") {
      const actor = expected.merchants.find(
        (m) => m.merchant_id === action.merchantId,
      );
      const position = resources.indexOf(args.resource);
      equal(actor.listings[position].version, args.expected_version);
      actor.listings[position] = result.data.listing;
    }
    if (method === "propose_trade") {
      assert.equal(proposal, null);
      equal(action.source, "model");
      equal(action.merchantId, "rex");
      equal(args.proposer, "rex");
      equal(args.buyer, "rex");
      equal(args.seller, "luna");
      equal(args.resource, "crystal");
      equal(result.data.offer.offer_id, expected.next_offer_id);
      expected.next_offer_id = increment(expected.next_offer_id);
      proposal = result.data.offer;
    }
    if (method === "accept_trade") {
      assert.ok(proposal && !settled);
      equal(action.source, "model");
      equal(action.merchantId, proposal.counterparty);
      for (const key of [
        "offer_id",
        "proposer",
        "buyer",
        "seller",
        "counterparty",
        "resource",
        "quantity",
        "unit_price",
        "total_price",
        "created_at_ns",
        "expires_at_ns",
        "proposal_action",
      ])
        equal(result.data.offer[key], proposal[key]);
      assert.ok(
        BigInt(result.block_timestamp_ns) < BigInt(proposal.expires_at_ns),
      );
      applyTrade(expected, wallet, result.data.trade, false);
      settled = true;
    }
    equal(after.market.data, expected);
    equal(after.player.data, wallet);
  }
  assert.ok(
    purchase === 1 && proposal && settled,
    "Missing successful shortage/restock sequence",
  );
  for (const decision of decisions) {
    exact(decision, [
      "id",
      "requestId",
      "merchantId",
      "provider",
      "requestedModel",
      "returnedModel",
      "startedAt",
      "returnedAt",
      "policyOutcome",
      "explanation",
      "action",
      "transactionId",
    ]);
    assert.ok(merchants.includes(decision.merchantId));
    equal(
      decision.provider,
      value.mode === "historical_replay" ? "near-ai" : "controlled-fixture",
    );
    publicText(decision.requestedModel, 120);
    publicText(decision.returnedModel, 120);
    equal(decision.requestedModel, decision.returnedModel);
    equal(decision.policyOutcome, "allowed");
    publicText(decision.explanation);
    exact(decision.action, ["method", "args"]);
    const index = actions.findIndex((a) => a.id === decision.transactionId);
    assert.ok(
      index >= 0 &&
        actions[index].source === "model" &&
        actions[index].decisionId === decision.id,
    );
    assert.ok(
      start <= utc(decision.startedAt) &&
        utc(decision.startedAt) <= utc(decision.returnedAt),
    );
    assert.ok(
      utc(decision.startedAt) >=
        Number(BigInt(points[index].block.timestampNs) / 1000000n),
      "Decision predates the state and offer it claims to evaluate",
    );
    assert.ok(
      utc(decision.returnedAt) <=
        Number(BigInt(points[index + 1].block.timestampNs) / 1000000n),
    );
  }
  return value;
}

// Initialization arguments are checked independently of loose operational logs.
export const replayInitializationArgs = object({
  owner_account_id: accountId,
  merchant_controllers: object({
    rex: accountId,
    luna: accountId,
    bolt: accountId,
  }),
});
