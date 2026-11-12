import {
  mkdir,
  readdir,
  readFile,
  lstat,
  rename,
  open,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalLivingTownJson } from "@bot-bazaar/chain";
import type { LivingTownExecutionStore } from "./execution-store.js";
import type { LivingTownProjector } from "./projector.js";
import type { LivingTownIdentity } from "@bot-bazaar/chain";
import { readReceiptInbox } from "./config.js";
import { requireStorage } from "../storage/validation.js";

// Public proof files are the durable queue. Retry scheduling is disposable;
// restarting may check the same original hash again, but never replaces it.
const receiptRetries = new Map<string, { attempts: number; nextAt: number }>();

export async function atomicRuntimeJson(
  filename: string,
  value: unknown,
): Promise<void> {
  const temporary = filename + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
}
/** Public proofs only. Private signed transaction bytes never leave the execution journal. */
const publications = new WeakMap<LivingTownExecutionStore, Promise<void>>();
export function publishRuntimeOutbox(store: LivingTownExecutionStore, directory: string, activityFile: string): Promise<void> {
  const prior = publications.get(store) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => publishOnce(store, directory, activityFile));
  publications.set(store, next);
  return next;
}
async function publishOnce(store: LivingTownExecutionStore, directory: string, activityFile: string): Promise<void> {
  await mkdir(join(directory, "archive"), { recursive: true });
  await mkdir(join(directory, "rejected"), { recursive: true });
  for (const hash of store.rejectedAdmissions()) {
    try {
      await rename(
        join(directory, `${hash}.json`),
        join(directory, "rejected", `${hash}.json`),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const current = await readdir(directory);
  requireStorage(
    current.filter((f) => f.endsWith(".json")).length <= 1000,
    "receipt outbox backpressure; repair reader before new work",
  );
  for (const proof of store.receiptProofs()) {
    const filename = `${proof.transaction_hash}.json`;
    const body = { schema: "living-town-receipt-inbox-v1", requests: [proof] };
    let exists = false;
    for (const dir of [directory, join(directory, "archive")]) {
      try {
        const stat = await lstat(join(dir, filename));
        requireStorage(
          stat.isFile() && !stat.isSymbolicLink() && stat.size <= 262144,
          "invalid outbox proof file",
        );
        requireStorage(
          canonicalLivingTownJson(
            JSON.parse(await readFile(join(dir, filename), "utf8")),
          ) === canonicalLivingTownJson(body),
          "outbox proof changed",
        );
        exists = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (!exists) await atomicRuntimeJson(join(directory, filename), body);
  }
  // Bounded recent observations. Confirmed outcomes are authenticated separately by receipt ingestion.
  let cursor: string | null = null;
  const records: ReturnType<
    LivingTownExecutionStore["publicActivity"]
  >["records"] = [];
  let result: ReturnType<LivingTownExecutionStore["publicActivity"]>;
  do {
    result = store.publicActivity(cursor, 100);
    records.push(...result.records);
    if (records.length > 100) records.splice(0, records.length - 100);
    cursor = result.next_after;
  } while (cursor !== null);
  await atomicRuntimeJson(activityFile, {
    ...result,
    records,
    next_after: null,
  });
}

/** Reader-only acknowledgement after its archive/projection commit; retry is idempotent. */
export async function drainRuntimeOutbox(
  directory: string,
  identity: LivingTownIdentity,
  projector: LivingTownProjector,
): Promise<void> {
  const dir = await lstat(directory);
  requireStorage(
    dir.isDirectory() && !dir.isSymbolicLink(),
    "regular receipt outbox required",
  );
  await mkdir(join(directory, "archive"), { recursive: true });
  const files = (await readdir(directory)).filter(n => /^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(n));
  const paths = new Set(files.map(name => join(directory, name)));
  for (const path of receiptRetries.keys())
    if (path.startsWith(directory + "/") || path.startsWith(directory + "\\"))
      if (!paths.has(path)) receiptRetries.delete(path);
  const now = Date.now();
  const observations = await Promise.allSettled(files.map(async name => ({ name,
    modified: (await lstat(join(directory, name))).mtimeMs })));
  const modified = new Map<string, number>();
  for (const result of observations) {
    if (result.status === "fulfilled") modified.set(result.value.name, result.value.modified);
    else if ((result.reason as NodeJS.ErrnoException)?.code !== "ENOENT") throw result.reason;
  }
  const due = files.filter(name => modified.has(name) &&
      (receiptRetries.get(join(directory, name))?.nextAt ?? 0) <= now)
    .sort((a, b) => (receiptRetries.get(join(directory, a))?.nextAt ?? 0) -
      (receiptRetries.get(join(directory, b))?.nextAt ?? 0) || modified.get(b)! - modified.get(a)! || a.localeCompare(b));
  const fresh = due.filter(name => !receiptRetries.has(join(directory, name)));
  const retries = due.filter(name => receiptRetries.has(join(directory, name)));
  // Favor recent game activity while reserving a retry slot for original work.
  const selected = [...fresh.slice(0, 2), ...retries.slice(0, 1)];
  for (const name of due) if (selected.length < 3 && !selected.includes(name)) selected.push(name);
  for (const name of selected) {
    const filename = join(directory, name);
    const proofs = readReceiptInbox(filename, identity);
    requireStorage(
      proofs.length === 1 && name === `${proofs[0]!.transactionHash}.json`,
      "outbox filename/proof mismatch",
    );
    try {
      if ((await projector.ingest(proofs[0]!)) !== "unresolved") {
        await rename(filename, join(directory, "archive", name));
        receiptRetries.delete(filename);
        continue;
      }
    } catch (error) {
      // Leave unresolved/RPC-unavailable proofs for a later cycle; refresh current chain state.
      // Invalid evidence and storage failures still fail the reader cycle closed.
      if (!(error instanceof Error) || error.name !== "ChainRpcError")
        throw error;
    }
    const attempts = (receiptRetries.get(filename)?.attempts ?? 0) + 1;
    receiptRetries.set(filename, { attempts,
      nextAt: Date.now() + Math.min(300000, 2500 * 2 ** Math.min(attempts - 1, 7)) });
  }
}
