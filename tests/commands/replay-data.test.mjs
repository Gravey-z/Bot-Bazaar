import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlledReplay } from "../fixtures/replay-session.mjs";
import {
  validateReplay,
  sanitizeReplayReceipt,
  sha256,
  readReplayJson,
  replayFileLimit,
  publicText,
} from "../../scripts/replay-data.mjs";
import {
  validateReplayCollection,
  publishReplay,
} from "../../scripts/replay-publication.mjs";
import {
  verifyReplayOnChain,
  captureReplay,
  captureReplayCheckpoint,
} from "../../scripts/capture-replay.mjs";
import { encodeArguments } from "../../packages/chain/dist/rpc.js";

test("controlled replay verifies exact ledger deltas, listings, terms and receipt identities", async () => {
  const replay = await controlledReplay();
  assert.equal(await validateReplay(replay), replay);
  assert.equal(replay.mode, "test_fixture");
  assert.equal(replay.checkpoints.at(-1).market.data.merchants[0].gold, "204");
});

test("replay rejects missing evidence, wrong identity, failed or unrelated receipts", async () => {
  const original = await controlledReplay();
  const mutations = [
    (r) => (r.identity.networkId = "mainnet"),
    (r) => (r.identity.contractId = "different.testnet"),
    (r) => (r.identity.controllers.luna = r.identity.controllers.rex),
    (r) => (r.actions[0].receipt.final_execution_status = "EXECUTED"),
    (r) => (r.actions[0].receipt.status = { Failure: {} }),
    (r) => r.actions[1].receipt.receipts_outcome.pop(),
    (r) =>
      r.actions[1].receipt.receipts_outcome.push(
        r.actions[0].receipt.receipts_outcome[0],
      ),
    (r) => (r.actions[1].receipt.transaction.signer_id = "wrong.testnet"),
    (r) =>
      (r.actions[1].receipt.transaction.actions[0].FunctionCall.deposit = "1"),
    (r) => (r.initialization = null),
    (r) => (r.verification.missingEvidence = ["initialization"]),
    (r) => (r.verification.interleaving = true),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    await assert.rejects(validateReplay(changed));
  }
});

test("replay rejects amount changes even when totals still conserve, gaps and unrecorded issuance", async () => {
  const original = await controlledReplay();
  for (const mutate of [
    (r) => {
      r.checkpoints[3].market.data.merchants[0].gold = "205";
      r.checkpoints[3].market.data.merchants[1].gold = "243";
    },
    (r) => (r.checkpoints[2].market.market_revision = "6"),
    (r) => (r.checkpoints[2].market.data.registered_player_count = "2"),
    (r) =>
      (r.checkpoints[1].market.data.merchants[0].listings[0].version = "9"),
    (r) => (r.checkpoints[3].market.data.merchants[0].inventory.crystal = "8"),
    (r) => (r.actions[2].decisionId = null),
    (r) => (r.decisions[1].action.args.offer_id = "9"),
    (r) => (r.actions[1].source = "policy"),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    await assert.rejects(validateReplay(changed));
  }
});

test("model provenance must be independent, bounded, timed and tied to its exact transaction", async () => {
  const original = await controlledReplay();
  for (const mutate of [
    (r) => (r.decisions[1].merchantId = "rex"),
    (r) => (r.decisions[1].requestId = r.decisions[0].requestId),
    (r) => (r.decisions[1].returnedModel = "other-model"),
    (r) => (r.decisions[1].returnedAt = r.recordedTo),
    (r) => (r.decisions[1].policyOutcome = "rejected"),
    (r) => (r.mode = "historical_replay"),
    (r) => (r.decisions[0].transactionId = r.actions[2].id),
    (r) => (r.decisions[0].explanation = "x".repeat(241)),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    await assert.rejects(validateReplay(changed));
  }
});

test("exports reject secret fields, unsafe text and unapproved explorer URLs", async () => {
  const original = await controlledReplay();
  for (const mutate of [
    (r) => (r.apiKey = "test-private-field"),
    (r) => (r.decisions[0].prompt = "private prompt"),
    (r) =>
      (r.actions[0].receipt.transaction.signature =
        "private raw transaction field"),
    (r) => (r.decisions[0].explanation = "<img src=x>"),
    (r) => (r.decisions[0].explanation = "Bearer test-only-value"),
    (r) => (r.actions[0].explorerUrl = "https://evil.example/txns/hash"),
    (r) => (r.actions[0].explorerUrl += "?redirect=elsewhere"),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    await assert.rejects(validateReplay(changed));
  }
  assert.throws(() => publicText("sk-test-only-placeholder123"));
  assert.throws(() => publicText("C:\\Users\\someone\\private"));
  assert.throws(() => publicText("hidden\u202ereason"));
});

test("receipt projection removes arbitrary logs, signatures, metadata and private extras", async () => {
  const replay = await controlledReplay();
  const input = structuredClone(replay.actions[0].receipt);
  input.rawRequest = "test-private-canary";
  input.transaction.signature = "test-private-canary";
  input.receipts_outcome[0].outcome.logs = ["test-private-canary"];
  const encoded = input.status.SuccessValue;
  const json = Buffer.from(encoded, "base64").toString("utf8");
  const hidden = Buffer.from(
    json.replace("{", '{"market_revision":"test-private-canary",'),
  ).toString("base64");
  input.status.SuccessValue = hidden;
  for (const receipt of input.receipts_outcome)
    if (receipt.outcome.status.SuccessValue === encoded)
      receipt.outcome.status.SuccessValue = hidden;
  const clean = sanitizeReplayReceipt(input);
  assert.equal(JSON.stringify(clean).includes("test-private-canary"), false);
  assert.equal(
    Buffer.from(clean.status.SuccessValue, "base64")
      .toString("utf8")
      .includes("test-private-canary"),
    false,
  );
  assert.deepEqual(clean, replay.actions[0].receipt);
});

async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), "bazaar-replay-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const write = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n");
const index = (entries = []) => ({
  schema: "bot-bazaar-replay-collection-v1",
  entries,
});
async function indexed(directory, replay) {
  const bytes = Buffer.from(JSON.stringify(replay, null, 2) + "\n");
  const entry = {
    file: `${replay.runId}.json`,
    runId: replay.runId,
    bytes: bytes.length,
    sha256: sha256(bytes),
    recordedFrom: replay.recordedFrom,
    recordedTo: replay.recordedTo,
    contractId: replay.identity.contractId,
    review: {
      reviewedAt: "2026-11-01T00:00:00.000Z",
      reviewer: "controlled-test-review",
      contentSha256: sha256(bytes),
    },
  };
  await writeFile(join(directory, entry.file), bytes);
  await write(join(directory, "index.json"), index([entry]));
  return entry;
}

test("collection validates the hash before accepting replay JSON; refuses fixtures and unlisted files", async () =>
  temporary(async (directory) => {
    await write(join(directory, "index.json"), index());
    assert.equal(
      (await validateReplayCollection(directory)).index.entries.length,
      0,
    );
    await write(join(directory, "private.json"), {});
    await assert.rejects(validateReplayCollection(directory), /Unlisted/);
    await rm(join(directory, "private.json"));
    const replay = await controlledReplay(),
      entry = await indexed(directory, replay);
    await assert.rejects(validateReplayCollection(directory), /Test fixtures/);
    await writeFile(join(directory, entry.file), "{");
    await assert.rejects(validateReplayCollection(directory));
  }));

test("collection rejects traversal, duplicate runs, invalid hashes and declared collection overflow", async () =>
  temporary(async (directory) => {
    const replay = await controlledReplay(),
      entry = await indexed(directory, replay);
    for (const entries of [
      [{ ...entry, file: "../private.json" }],
      [entry, entry],
      [{ ...entry, sha256: "bad" }],
      Array.from({ length: 5 }, (_, n) => ({
        ...entry,
        runId: `large-${n}`,
        file: `large-${n}.json`,
        bytes: replayFileLimit,
      })),
    ]) {
      await write(join(directory, "index.json"), index(entries));
      await assert.rejects(validateReplayCollection(directory));
    }
    await write(
      join(directory, "index.json"),
      index(
        Array.from({ length: 4 }, (_, n) => ({
          ...entry,
          runId: `large-${n}`,
          file: `large-${n}.json`,
          bytes: replayFileLimit,
        })),
      ),
    );
    await assert.rejects(validateReplayCollection(directory), /20 MiB/);
  }));

test("bounded reader refuses oversized files, directories, symlinks and invalid UTF-8", async () =>
  temporary(async (directory) => {
    const path = join(directory, "large.json");
    await writeFile(path, Buffer.alloc(replayFileLimit + 1, 32));
    await assert.rejects(readReplayJson(path), /5 MiB/);
    await assert.rejects(readReplayJson(directory));
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(readReplayJson(path));
    // Directory junctions are available on Windows without enabling symlink privileges.
    const link = join(directory, "link");
    await symlink(directory, link, "junction");
    await assert.rejects(readReplayJson(link));
  }));

test("controlled fixtures cannot reach RPC capture or publication, even with a review file", async () =>
  temporary(async (directory) => {
    const replay = await controlledReplay();
    let requests = 0;
    const transport = () => {
      requests++;
      throw new Error("No network expected");
    };
    await assert.rejects(verifyReplayOnChain(replay, transport));
    const candidate = join(directory, "candidate.json");
    await write(candidate, replay);
    await assert.rejects(
      captureReplay(candidate, join(directory, "capture"), transport),
    );
    assert.equal(requests, 0);
    const capture = join(directory, "saved");
    await mkdir(capture);
    const entry = await indexed(capture, replay);
    await write(join(capture, "capture.json"), {
      schema: "bot-bazaar-replay-capture-v1",
      runId: replay.runId,
      file: entry.file,
      bytes: entry.bytes,
      sha256: entry.sha256,
      capturedAt: replay.verification.verifiedAt,
      verification: {
        chain: "verified_against_approved_rpc",
        model: "operator_recorded_not_cryptographic",
      },
    });
    const collection = join(directory, "public");
    await mkdir(collection);
    await write(join(collection, "index.json"), index());
    await assert.rejects(publishReplay(capture, candidate, collection));
    assert.deepEqual(
      JSON.parse(await readFile(join(collection, "index.json"), "utf8")),
      index(),
    );
  }));

// An entirely controlled transport exercises the real capture path. Changing
// this test object's mode only tests validation; it creates no public fixture
// and establishes no genuine provider provenance or network verification.
async function captureHarness() {
  const replay = await controlledReplay();
  replay.mode = "historical_replay";
  for (const decision of replay.decisions) decision.provider = "near-ai";
  const calls = [];
  const init = structuredClone(replay.actions[0].receipt);
  init.transaction.hash = replay.initialization.transactionHash;
  init.transaction.signer_id = replay.identity.contractId;
  init.transaction_outcome.id = init.transaction.hash;
  init.transaction_outcome.outcome.executor_id = replay.identity.contractId;
  init.transaction.actions[0].FunctionCall.method_name = "initialize_market";
  init.transaction.actions[0].FunctionCall.args = encodeArguments({
    owner_account_id: replay.identity.contractId,
    merchant_controllers: replay.identity.controllers,
  });
  const root = init.receipts_outcome.find(
    (row) =>
      row.id === init.transaction_outcome.outcome.status.SuccessReceiptId,
  );
  root.block_hash = replay.initialization.blockHash;
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === "status") return { chain_id: "testnet" };
    if (method === "EXPERIMENTAL_genesis_config")
      return { chain_id: "testnet", genesis_height: 0 };
    if (method === "block") {
      const point = replay.checkpoints.find(
        (p) => p.block.hash === params.block_id,
      );
      return {
        header: {
          hash:
            params.block_id === 0
              ? replay.identity.genesisHash
              : params.block_id,
          height: Number(point?.block.height ?? "1"),
          timestamp_nanosec: point?.block.timestampNs ?? "1",
        },
      };
    }
    if (method === "query") {
      const point = replay.checkpoints.find(
        (p) => p.block.hash === params.block_id,
      );
      if (params.request_type === "view_account")
        return {
          block_hash: params.block_id,
          code_hash: replay.identity.codeHash,
        };
      assert.ok(point);
      const result =
        params.method_name === "get_market_state" ? point.market : point.player;
      return {
        block_hash: point.block.hash,
        block_height: Number(point.block.height),
        result: [...Buffer.from(JSON.stringify(result))],
      };
    }
    if (method === "tx")
      return params.tx_hash === replay.initialization.transactionHash
        ? init
        : replay.actions.find(
            (a) => a.receipt.transaction.hash === params.tx_hash,
          ).receipt;
    throw new Error("Unexpected RPC method");
  };
  return { replay, transport, calls, init };
}

test("capture checks original RPC identities and snapshots, then publication binds explicit review to exact bytes", async () =>
  temporary(async (directory) => {
    const { replay, transport, calls } = await captureHarness();
    const candidate = join(directory, "candidate.json"),
      capture = join(directory, "capture");
    await write(candidate, replay);
    const manifest = await captureReplay(candidate, capture, transport);
    assert.ok(calls.length > 10);
    assert.equal(
      calls.some((c) => c.method.includes("broadcast")),
      false,
    );
    const collection = join(directory, "collection");
    await mkdir(collection);
    await write(join(collection, "index.json"), index());
    const reviewPath = join(directory, "review.json");
    const review = {
      schema: "bot-bazaar-replay-review-v1",
      runId: replay.runId,
      contentSha256: "0".repeat(64),
      reviewedAt: new Date().toISOString(),
      reviewer: "Controlled test reviewer",
      approvedForPublication: true,
    };
    await write(reviewPath, review);
    await assert.rejects(publishReplay(capture, reviewPath, collection));
    review.contentSha256 = manifest.sha256;
    await write(reviewPath, review);
    await publishReplay(capture, reviewPath, collection);
    assert.equal(
      (await validateReplayCollection(collection)).index.entries.length,
      1,
    );
    await assert.rejects(publishReplay(capture, reviewPath, collection));
    await assert.rejects(captureReplay(candidate, capture, transport));
  }));

test("read-only capture refuses wrong genesis, substituted receipts, code changes and state changes", async () => {
  for (const mutation of [
    (h) => (h.replay.identity.genesisHash = h.replay.identity.codeHash),
    (h) => (h.init.transaction.signer_id = "wrong.testnet"),
    (h) => (h.init.receipts_outcome[0].outcome.status = { Failure: {} }),
    (h) => (h.init.receipts_outcome = []),
  ]) {
    const harness = await captureHarness();
    mutation(harness);
    // Freeze the transport's expected genesis independently of the candidate.
    const originalTransport = harness.transport;
    const transport = async (method, params) => {
      const response = await originalTransport(method, params);
      if (method === "block" && params.block_id === 0)
        response.header.hash = harness.replay.initialization.blockHash;
      return response;
    };
    await assert.rejects(verifyReplayOnChain(harness.replay, transport));
  }
  for (const changed of ["code", "state", "transaction"]) {
    const harness = await captureHarness();
    const transport = async (method, params) => {
      const response = structuredClone(await harness.transport(method, params));
      if (
        changed === "code" &&
        method === "query" &&
        params.request_type === "view_account"
      )
        response.code_hash = harness.replay.identity.genesisHash;
      if (
        changed === "state" &&
        method === "query" &&
        params.method_name === "get_player"
      )
        response.result = [...Buffer.from("null")];
      if (
        changed === "transaction" &&
        method === "tx" &&
        params.tx_hash !== harness.replay.initialization.transactionHash
      )
        response.transaction.signer_id = "wrong.testnet";
      return response;
    };
    await assert.rejects(verifyReplayOnChain(harness.replay, transport));
  }
});

test("checkpoint capture pins one block, checks code and player, and never overwrites evidence", async () =>
  temporary(async (directory) => {
    const harness = await captureHarness();
    const point = harness.replay.checkpoints[0],
      output = join(directory, "before.json");
    const transport = async (method, params) =>
      method === "status"
        ? { chain_id: "testnet", sync_info: { syncing: false } }
        : harness.transport(method, params);
    const result = await captureReplayCheckpoint(
      harness.replay.identity.contractId,
      harness.replay.playerId,
      harness.replay.identity.codeHash,
      point.block.hash,
      output,
      transport,
    );
    assert.deepEqual(result.market, point.market);
    assert.deepEqual(result.player, point.player);
    await assert.rejects(
      captureReplayCheckpoint(
        harness.replay.identity.contractId,
        harness.replay.playerId,
        harness.replay.identity.codeHash,
        point.block.hash,
        output,
        transport,
      ),
    );
    const saved = await readFile(output, "utf8");
    assert.equal(saved.includes("signature"), false);
  }));
