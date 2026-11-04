import { array, check, literal, object, accountId } from "./wire.js";
import {
  publicText,
  utc,
  replayCollectionLimit,
  replayFileLimit,
} from "./replay-validation.mjs";

function text(value: unknown): string {
  check(typeof value === "string", "expected replay text");
  publicText(value, 96);
  return value;
}
function filename(value: unknown): string {
  check(typeof value === "string", "expected replay filename");
  publicText(value, 101);
  return value;
}
function reviewer(value: unknown): string {
  check(typeof value === "string", "expected replay reviewer");
  publicText(value, 80);
  return value;
}
function runId(value: unknown): string {
  const result = text(value);
  check(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(result), "invalid replay ID");
  return result;
}
function digest(value: unknown): string {
  check(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "invalid replay digest",
  );
  return value;
}
function time(value: unknown): string {
  check(typeof value === "string", "expected replay timestamp");
  check(utc(value) <= Date.now(), "future replay timestamp");
  return value;
}
function size(value: unknown): number {
  check(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= replayFileLimit,
    "invalid replay size",
  );
  return value;
}
const entry = object({
  file: filename,
  runId,
  bytes: size,
  sha256: digest,
  recordedFrom: time,
  recordedTo: time,
  contractId: accountId,
  review: object({ reviewedAt: time, reviewer, contentSha256: digest }),
});
const collection = object({
  schema: literal("bot-bazaar-replay-collection-v1"),
  entries: array(entry, 32),
});
export type ReplayCollection = ReturnType<typeof collection>;
export type ReplayEntry = ReplayCollection["entries"][number];

export function parseReplayCollection(
  value: unknown,
  indexBytes: number,
): ReplayCollection {
  check(
    Number.isSafeInteger(indexBytes) &&
      indexBytes > 0 &&
      indexBytes <= replayFileLimit,
    "invalid replay index size",
  );
  const result = collection(value),
    files = new Set(["index.json"]),
    ids = new Set<string>();
  let total = indexBytes;
  for (const row of result.entries) {
    check(
      row.file === `${row.runId}.json` &&
        !files.has(row.file) &&
        !ids.has(row.runId),
      "duplicate or unsafe replay file",
    );
    files.add(row.file);
    ids.add(row.runId);
    check(row.contractId.endsWith(".testnet"), "wrong replay network");
    check(row.review.contentSha256 === row.sha256, "unreviewed replay hash");
    check(
      utc(row.recordedFrom) <= utc(row.recordedTo) &&
        utc(row.recordedTo) <= utc(row.review.reviewedAt),
      "invalid replay interval",
    );
    total += row.bytes;
  }
  check(total <= replayCollectionLimit, "Replay collection exceeds 20 MiB");
  return result;
}
