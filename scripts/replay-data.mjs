import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { open, lstat } from "node:fs/promises";
import { object, accountId } from "../packages/chain/dist/wire.js";
import { replayFileLimit } from "../packages/chain/dist/index.js";
export {
  replayFileLimit,
  replayCollectionLimit,
  exact,
  utc,
  publicText,
  sanitizeReplayReceipt,
  validateReplay,
} from "../packages/chain/dist/index.js";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
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

// Initialization arguments are checked independently of loose operational logs.
export const replayInitializationArgs = object({
  owner_account_id: accountId,
  merchant_controllers: object({
    rex: accountId,
    luna: accountId,
    bolt: accountId,
  }),
});
