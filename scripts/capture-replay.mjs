import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRpcTransport,
  FinalizedMarketReader,
} from "../packages/chain/dist/index.js";
import { decodeBase64Json } from "../packages/chain/dist/rpc.js";
import {
  accountId,
  hash32,
  snapshot,
  market,
  player,
} from "../packages/chain/dist/wire.js";
import {
  utc,
  readReplayJson,
  sanitizeReplayReceipt,
  validateReplay,
  sha256,
  replayFileLimit,
  replayInitializationArgs,
} from "./replay-data.mjs";

const same = (a, b) => assert.deepEqual(a, b);
async function block(rpc, hash) {
  const value = await rpc("block", { block_id: hash });
  same(value.header.hash, hash);
  return {
    hash,
    height: String(value.header.height),
    timestampNs: String(value.header.timestamp_nanosec),
  };
}
async function code(rpc, identity, hash) {
  const value = await rpc("query", {
    request_type: "view_account",
    account_id: identity.contractId,
    block_id: hash,
  });
  same(value.block_hash, hash);
  same(value.code_hash, identity.codeHash);
}

export async function captureReplayCheckpoint(
  contractId,
  playerId,
  codeHash,
  blockId,
  output,
  transport = createRpcTransport("https://archival-rpc.testnet.near.org/"),
) {
  accountId(contractId);
  accountId(playerId);
  hash32(codeHash);
  assert.ok(contractId.endsWith(".testnet") && playerId.endsWith(".testnet"));
  if (blockId !== "final") hash32(blockId);
  const status = await transport("status", []);
  same(status.chain_id, "testnet");
  same(status.sync_info.syncing, false);
  const raw = await transport(
    "block",
    blockId === "final" ? { finality: "final" } : { block_id: blockId },
  );
  const pinned = {
    hash: hash32(raw.header.hash),
    height: String(raw.header.height),
    timestampNs: String(raw.header.timestamp_nanosec),
  };
  if (blockId !== "final") same(pinned.hash, blockId);
  await code(transport, { contractId, codeHash }, pinned.hash);
  const reader = new FinalizedMarketReader(transport, contractId, pinned);
  const state = snapshot(market)(await reader.getMarketState());
  const wallet = snapshot(player)(await reader.getPlayer(playerId));
  same(wallet.market_revision, state.market_revision);
  const point = {
    capturedAt: new Date().toISOString(),
    block: pinned,
    market: state,
    player: wallet,
  };
  const bytes = JSON.stringify(point, null, 2) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= replayFileLimit);
  await writeFile(output, bytes, { flag: "wx" });
  return point;
}

// This checker intentionally accepts only read RPC methods. It cannot load a
// keychain, enable the worker/provider or submit a transaction.
export async function verifyReplayOnChain(replay, transport) {
  await validateReplay(replay);
  same(replay.mode, "historical_replay");
  const allowed = new Set([
    "status",
    "EXPERIMENTAL_genesis_config",
    "block",
    "query",
    "tx",
  ]);
  const rpc = (method, params) => {
    assert.ok(allowed.has(method));
    return transport(method, params);
  };
  const status = await rpc("status", []);
  same(status.chain_id, "testnet");
  const genesis = await rpc("EXPERIMENTAL_genesis_config", []);
  same(genesis.chain_id, "testnet");
  const genesisBlock = await rpc("block", { block_id: genesis.genesis_height });
  same(genesisBlock.header.hash, replay.identity.genesisHash);
  const init = await rpc("tx", {
    tx_hash: replay.initialization.transactionHash,
    sender_account_id: replay.identity.contractId,
    wait_until: "FINAL",
  });
  same(init.final_execution_status, "FINAL");
  const tx = init.transaction;
  same(tx.hash, replay.initialization.transactionHash);
  same(tx.signer_id, replay.identity.contractId);
  same(tx.receiver_id, replay.identity.contractId);
  assert.ok(tx.actions.length === 1 || tx.actions.length === 2);
  const calls = tx.actions.filter((a) => a.FunctionCall);
  same(calls.length, 1);
  same(calls[0].FunctionCall.method_name, "initialize_market");
  same(calls[0].FunctionCall.deposit, "0");
  same(replayInitializationArgs(decodeBase64Json(calls[0].FunctionCall.args)), {
    owner_account_id: replay.identity.contractId,
    merchant_controllers: replay.identity.controllers,
  });
  if (tx.actions.length === 2)
    same(Object.keys(tx.actions[0]), ["DeployContract"]);
  const root = init.transaction_outcome;
  same(root.id, tx.hash);
  same(root.outcome.executor_id, tx.signer_id);
  const receipts = new Map(init.receipts_outcome.map((r) => [r.id, r]));
  same(receipts.size, init.receipts_outcome.length);
  const queue = [...root.outcome.receipt_ids],
    reached = new Set();
  while (queue.length) {
    const id = queue.shift();
    assert.ok(!reached.has(id));
    reached.add(id);
    const row = receipts.get(id);
    assert.ok(row);
    queue.push(...row.outcome.receipt_ids);
  }
  same(reached.size, receipts.size);
  for (const row of [root, ...receipts.values()]) {
    const keys = Object.keys(row.outcome.status);
    assert.ok(
      keys.length === 1 &&
        ["SuccessValue", "SuccessReceiptId"].includes(keys[0]),
    );
  }
  const contractReceipt = receipts.get(root.outcome.status.SuccessReceiptId);
  assert.ok(root.outcome.receipt_ids.includes(contractReceipt?.id));
  same(contractReceipt.outcome.executor_id, replay.identity.contractId);
  same(Object.keys(init.status), ["SuccessValue"]);
  same(contractReceipt.outcome.status, init.status);
  same(contractReceipt.block_hash, replay.initialization.blockHash);
  await code(rpc, replay.identity, replay.initialization.blockHash);
  const initBlock = await block(rpc, replay.initialization.blockHash);
  assert.ok(
    BigInt(initBlock.height) < BigInt(replay.checkpoints[0].block.height),
  );
  for (const point of replay.checkpoints) {
    same(await block(rpc, point.block.hash), point.block);
    await code(rpc, replay.identity, point.block.hash);
    const reader = new FinalizedMarketReader(
      rpc,
      replay.identity.contractId,
      point.block,
    );
    same(await reader.getMarketState(), point.market);
    same(await reader.getPlayer(replay.playerId), point.player);
  }
  for (const action of replay.actions) {
    const tx = action.receipt.transaction;
    const raw = await rpc("tx", {
      tx_hash: tx.hash,
      sender_account_id: tx.signer_id,
      wait_until: "FINAL",
    });
    same(sanitizeReplayReceipt(raw), action.receipt);
    // Receipt IDs and block references are preserved in the sanitized archive.
    for (const row of raw.receipts_outcome) await block(rpc, row.block_hash);
  }
  return {
    chain: "verified_against_approved_rpc",
    model: "operator_recorded_not_cryptographic",
  };
}

export async function captureReplay(
  candidatePath,
  output,
  transport = createRpcTransport("https://archival-rpc.testnet.near.org/"),
) {
  const { value } = await readReplayJson(candidatePath);
  await validateReplay(value);
  const verification = await verifyReplayOnChain(value, transport);
  // Verification metadata is captured now; candidate metadata is never used to
  // claim that this invocation checked the chain at an earlier time.
  value.verification.verifiedAt = new Date().toISOString();
  assert.ok(utc(value.verification.verifiedAt) >= utc(value.recordedTo));
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  assert.ok(bytes.length <= replayFileLimit);
  const manifest = {
    schema: "bot-bazaar-replay-capture-v1",
    runId: value.runId,
    file: `${value.runId}.json`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    capturedAt: value.verification.verifiedAt,
    verification,
  };
  await mkdir(output, { recursive: false }); // Never replace a previous capture.
  await writeFile(join(output, manifest.file), bytes, { flag: "wx" });
  await writeFile(
    join(output, "capture.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return manifest;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (process.argv[2] === "checkpoint" && process.argv.length === 8) {
      const point = await captureReplayCheckpoint(...process.argv.slice(3));
      console.info(`Read-only checkpoint captured at ${point.block.hash}`);
    } else {
      if (process.argv.length !== 4)
        throw new Error("Expected candidate and a new output directory");
      const manifest = await captureReplay(process.argv[2], process.argv[3]);
      console.info(JSON.stringify(manifest, null, 2));
    }
  } catch {
    console.error(
      "Replay capture stopped. Required real-session evidence is missing or did not verify; no replay was published. Preserve the original receipts and journals.",
    );
    process.exitCode = 1;
  }
}
