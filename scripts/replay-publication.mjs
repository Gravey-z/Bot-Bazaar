import assert from "node:assert/strict";
import { readdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  exact,
  utc,
  publicText,
  sha256,
  validateReplay,
  readReplayBytes,
  readReplayJson,
  replayFileLimit,
  replayCollectionLimit,
} from "./replay-data.mjs";

export async function validateReplayCollection(directory, publishing = false) {
  const { value: index, bytes: indexBytes } = await readReplayJson(
    join(directory, "index.json"),
  );
  exact(index, ["schema", "entries"]);
  assert.equal(index.schema, "bot-bazaar-replay-collection-v1");
  assert.ok(Array.isArray(index.entries) && index.entries.length <= 32);
  let declaredBytes = indexBytes.length;
  for (const entry of index.entries) {
    assert.ok(
      Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0 &&
        entry.bytes <= replayFileLimit,
    );
    declaredBytes += entry.bytes;
  }
  assert.ok(
    declaredBytes <= replayCollectionLimit,
    "Replay collection exceeds 20 MiB",
  );
  const files = new Set(["index.json"]),
    runs = new Set();
  let totalBytes = indexBytes.length;
  for (const entry of index.entries) {
    exact(entry, [
      "file",
      "runId",
      "bytes",
      "sha256",
      "recordedFrom",
      "recordedTo",
      "contractId",
      "review",
    ]);
    assert.match(entry.runId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
    assert.equal(entry.file, `${entry.runId}.json`);
    assert.ok(!files.has(entry.file) && !runs.has(entry.runId));
    files.add(entry.file);
    runs.add(entry.runId);
    assert.ok(
      Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0 &&
        entry.bytes <= replayFileLimit,
    );
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    totalBytes += entry.bytes;
    assert.ok(
      totalBytes <= replayCollectionLimit,
      "Replay collection exceeds 20 MiB",
    );
    exact(entry.review, ["reviewedAt", "reviewer", "contentSha256"]);
    publicText(entry.review.reviewer, 80);
    assert.equal(entry.review.contentSha256, entry.sha256);
    assert.ok(
      utc(entry.review.reviewedAt) >= utc(entry.recordedTo) &&
        utc(entry.review.reviewedAt) <= Date.now(),
    );
    const bytes = await readReplayBytes(join(directory, entry.file));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(sha256(bytes), entry.sha256, "Replay content hash mismatch");
    const replay = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    await validateReplay(replay);
    assert.equal(
      replay.mode,
      "historical_replay",
      "Test fixtures cannot be published as historical replay",
    );
    assert.equal(replay.runId, entry.runId);
    assert.equal(replay.identity.contractId, entry.contractId);
    assert.equal(replay.recordedFrom, entry.recordedFrom);
    assert.equal(replay.recordedTo, entry.recordedTo);
    assert.ok(
      utc(entry.review.reviewedAt) >= utc(replay.verification.verifiedAt),
    );
  }
  if (publishing) files.add(".publication.lock");
  const names = await readdir(directory);
  assert.deepEqual(
    names.sort(),
    [...files].sort(),
    "Unlisted or private files in replay collection",
  );
  return { index, totalBytes };
}

export async function publishReplay(
  captureDirectory,
  reviewPath,
  collectionDirectory,
) {
  const lock = join(collectionDirectory, ".publication.lock");
  await writeFile(lock, "Replay publication in progress\n", { flag: "wx" });
  let stage = null;
  try {
    const { index, totalBytes } = await validateReplayCollection(
      collectionDirectory,
      true,
    );
    const { value: capture } = await readReplayJson(
      join(captureDirectory, "capture.json"),
    );
    exact(capture, [
      "schema",
      "runId",
      "file",
      "bytes",
      "sha256",
      "capturedAt",
      "verification",
    ]);
    assert.equal(capture.schema, "bot-bazaar-replay-capture-v1");
    assert.match(capture.runId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
    assert.equal(capture.file, `${capture.runId}.json`);
    assert.deepEqual(capture.verification, {
      chain: "verified_against_approved_rpc",
      model: "operator_recorded_not_cryptographic",
    });
    const bytes = await readReplayBytes(join(captureDirectory, capture.file));
    assert.equal(bytes.length, capture.bytes);
    assert.equal(sha256(bytes), capture.sha256);
    const replay = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    await validateReplay(replay);
    assert.equal(replay.mode, "historical_replay");
    assert.equal(replay.runId, capture.runId);
    assert.equal(replay.verification.verifiedAt, capture.capturedAt);
    const { value: review } = await readReplayJson(reviewPath);
    exact(review, [
      "schema",
      "runId",
      "contentSha256",
      "reviewedAt",
      "reviewer",
      "approvedForPublication",
    ]);
    assert.equal(review.schema, "bot-bazaar-replay-review-v1");
    assert.equal(review.runId, replay.runId);
    assert.equal(review.contentSha256, capture.sha256);
    assert.equal(review.approvedForPublication, true);
    publicText(review.reviewer, 80);
    assert.ok(
      utc(review.reviewedAt) >= utc(capture.capturedAt) &&
        utc(review.reviewedAt) <= Date.now(),
    );
    assert.ok(!index.entries.some((e) => e.runId === replay.runId));
    const entry = {
      file: capture.file,
      runId: replay.runId,
      bytes: bytes.length,
      sha256: capture.sha256,
      recordedFrom: replay.recordedFrom,
      recordedTo: replay.recordedTo,
      contractId: replay.identity.contractId,
      review: {
        reviewedAt: review.reviewedAt,
        reviewer: review.reviewer,
        contentSha256: review.contentSha256,
      },
    };
    const next = Buffer.from(
      JSON.stringify(
        { ...index, entries: [...index.entries, entry] },
        null,
        2,
      ) + "\n",
    );
    const oldIndexSize = (
      await readFile(join(collectionDirectory, "index.json"))
    ).length;
    assert.ok(
      next.length <= replayFileLimit &&
        totalBytes - oldIndexSize + bytes.length + next.length <=
          replayCollectionLimit,
    );
    assert.ok(index.entries.length < 32);
    const pendingIndex = join(collectionDirectory, ".index.pending");
    await writeFile(pendingIndex, next, { flag: "wx" });
    stage = pendingIndex;
    await writeFile(join(collectionDirectory, capture.file), bytes, {
      flag: "wx",
    });
    await rename(stage, join(collectionDirectory, "index.json"));
    stage = null;
    return entry;
  } finally {
    if (stage) await unlink(stage).catch(() => {});
    await unlink(lock);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "check" && args.length === 1) {
      const result = await validateReplayCollection(args[0]);
      console.info(
        `Replay collection valid: ${result.index.entries.length} reviewed runs, ${result.totalBytes} bytes`,
      );
    } else if (command === "publish" && args.length === 3) {
      const entry = await publishReplay(...args);
      console.info(
        `Reviewed replay exported: ${entry.file}. Review the Git diff before committing.`,
      );
    } else
      throw new Error(
        "Expected check <collection> or publish <capture> <review> <collection>",
      );
  } catch {
    console.error(
      "Replay publication check failed. Nothing is approved by this error; preserve capture evidence and inspect the collection before retrying.",
    );
    process.exitCode = 1;
  }
}
