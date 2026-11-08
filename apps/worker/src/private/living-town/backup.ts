import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  readdir,
  copyFile,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  canonicalLivingTownJson as wireJson,
  parseLivingTownIdentity,
} from "@bot-bazaar/chain";
import type { LivingTownIdentity } from "@bot-bazaar/chain";
import type { LivingTownProjectionStore } from "./store.js";
import { requireStorage, sha256 } from "../storage/validation.js";

// Bundle metadata contains local numeric byte/count/time fields. The chain's
// canonical encoder intentionally accepts string integers only.
function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

interface FileEntry {
  file: string;
  bytes: number;
  sha256: string;
}
interface Report {
  checkpoint: unknown;
  feed: unknown;
  receipts: number;
  missingProofs: number;
  accountingThrough: string;
  historyComplete: boolean;
  stateSha256: string;
}
export interface TownBackupManifest {
  schema: "living-town-projection-backup-v1";
  mode: "non_signing_projection_only";
  identity: LivingTownIdentity;
  capturedAt: number;
  report: Report;
  database: FileEntry;
  config: FileEntry;
  archives: FileEntry[];
}
async function directory(path: string): Promise<void> {
  requireStorage(isAbsolute(path), "absolute bundle directory required");
  const stat = await lstat(path);
  requireStorage(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "regular bundle directory required",
  );
}
async function hashFile(root: string, name: string): Promise<FileEntry> {
  requireStorage(
    /^(living-town\.sqlite|economy\.json|receipts-[0-9]{4}\.json)$/.test(name),
    "invalid bundle filename",
  );
  const path = join(root, name),
    stat = await lstat(path);
  requireStorage(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= (name.endsWith(".sqlite") ? 1024 ** 3 : 16 * 1024 ** 2),
    "invalid bundle file",
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return { file: name, bytes: stat.size, sha256: hash.digest("hex") };
}
function open(path: string, readOnly = true): DatabaseSync {
  const db = new DatabaseSync(path, {
    readOnly,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
    requireStorage(
      db.prepare("PRAGMA user_version").get()!["user_version"] === 5 &&
        db.prepare("PRAGMA integrity_check").get()!["integrity_check"] ===
          "ok" &&
        db.prepare("PRAGMA foreign_key_check").all().length === 0,
      "invalid V2 backup database",
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function report(db: DatabaseSync): Report {
  const state = JSON.parse(
    String(
      db.prepare("SELECT body FROM projection_state WHERE singleton=1").get()?.[
        "body"
      ] ?? "null",
    ),
  );
  requireStorage(state?.checkpoint, "projection baseline required for backup");
  // Include all persisted tables, including cost lots, reservations, policy
  // revisions, pending feed entries and cursor identity, not just balances.
  const hash = createHash("sha256");
  for (const row of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()) {
    const name = String(row["name"]);
    requireStorage(/^[a-z_]+$/.test(name), "invalid backup table");
    hash.update(name + "\n");
    for (const item of db
      .prepare(`SELECT * FROM ${name} ORDER BY rowid`)
      .iterate()) {
      const normalized = Object.fromEntries(
        Object.entries(item).map(([key, value]) => [
          key,
          value instanceof Uint8Array
            ? { base64: Buffer.from(value).toString("base64") }
            : value,
        ]),
      );
      hash.update(json(normalized) + "\n");
    }
  }
  const missingProofs = Number(
    db
      .prepare(
        "SELECT count(*) n FROM projection_receipts r WHERE NOT EXISTS(SELECT 1 FROM projection_proofs p WHERE p.tx_hash=r.tx_hash)",
      )
      .get()!["n"],
  );
  const accountingThrough = String(
    db
      .prepare("SELECT through_sequence FROM cost_cursor WHERE singleton=1")
      .get()!["through_sequence"],
  );
  return {
    checkpoint: state.checkpoint,
    feed: db
      .prepare(
        "SELECT generation,sequence FROM town_feed_meta WHERE singleton=1",
      )
      .get(),
    receipts: Number(
      db.prepare("SELECT count(*) n FROM projection_receipts").get()!["n"],
    ),
    missingProofs,
    historyComplete:
      missingProofs === 0 &&
      BigInt(accountingThrough) >= BigInt(state.town.event_sequence),
    accountingThrough,
    stateSha256: hash.digest("hex"),
  };
}
function archives(
  db: DatabaseSync,
  identity: LivingTownIdentity,
  cut: Report,
): { file: string; body: string }[] {
  const result: { file: string; body: string }[] = [];
  let after = "";
  for (let page = 0; page < 400; page++) {
    const rows = db
      .prepare(
        "SELECT r.tx_hash,r.request,p.body FROM projection_receipts r JOIN projection_proofs p ON p.tx_hash=r.tx_hash WHERE r.tx_hash>? ORDER BY r.tx_hash LIMIT 25",
      )
      .all(after);
    if (!rows.length) return result;
    result.push({
      file: `receipts-${String(page).padStart(4, "0")}.json`,
      body: json({
        schema: "living-town-receipt-archive-v1",
        identity,
        checkpoint: cut.checkpoint,
        missing_proof_count: String(cut.missingProofs),
        entries: rows.map((r) => ({
          proof: JSON.parse(String(r["request"])),
          response_gzip_base64: Buffer.from(r["body"] as Uint8Array).toString(
            "base64",
          ),
        })),
      }),
    });
    after = String(rows.at(-1)!["tx_hash"]);
  }
  requireStorage(
    !db.prepare("SELECT 1 FROM projection_receipts WHERE tx_hash>?").get(after),
    "backup receipt capacity exceeded",
  );
  return result;
}
async function config(
  root: string,
  identity: LivingTownIdentity,
): Promise<void> {
  const body = await readFile(join(root, "economy.json"), "utf8");
  requireStorage(
    Buffer.byteLength(body) <= 65536 &&
      sha256(wireJson(JSON.parse(body))) === identity.deployment.config_sha256,
    "backup economy config mismatch",
  );
}
export async function createTownBackup(
  store: LivingTownProjectionStore,
  output: string,
  economy: unknown,
): Promise<TownBackupManifest> {
  const body = wireJson(economy);
  requireStorage(
    isAbsolute(output) &&
      Buffer.byteLength(body) <= 65536 &&
      sha256(body) === store.identity.deployment.config_sha256,
    "approved economy config and new absolute output required",
  );
  await mkdir(output, { mode: 0o700 }); // Exclusive: never overwrite an earlier bundle.
  await writeFile(join(output, "INCOMPLETE"), "Backup has not completed.\n", {
    flag: "wx",
    mode: 0o600,
  });
  await store.snapshotTo(join(output, "living-town.sqlite"));
  const db = open(join(output, "living-town.sqlite"), false);
  let cut: Report, chunks: { file: string; body: string }[];
  try {
    db.exec("PRAGMA journal_mode=DELETE;");
    cut = report(db);
    chunks = archives(db, store.identity, cut);
  } finally {
    db.close();
  }
  await writeFile(join(output, "economy.json"), body, {
    flag: "wx",
    mode: 0o600,
  });
  for (const chunk of chunks)
    await writeFile(join(output, chunk.file), chunk.body, {
      flag: "wx",
      mode: 0o600,
    });
  const manifest: TownBackupManifest = {
    schema: "living-town-projection-backup-v1",
    mode: "non_signing_projection_only",
    identity: store.identity,
    capturedAt: Date.now(),
    report: cut,
    database: await hashFile(output, "living-town.sqlite"),
    config: await hashFile(output, "economy.json"),
    archives: await Promise.all(
      chunks.map((chunk) => hashFile(output, chunk.file)),
    ),
  };
  await writeFile(join(output, "manifest.json"), json(manifest), {
    flag: "wx",
    mode: 0o600,
  });
  await unlink(join(output, "INCOMPLETE"));
  return verifyTownBackup(output, store.identity);
}
export async function verifyTownBackup(
  root: string,
  expected: unknown,
): Promise<TownBackupManifest> {
  await directory(root);
  const identity = parseLivingTownIdentity(expected),
    meta = await lstat(join(root, "manifest.json"));
  requireStorage(
    meta.isFile() && !meta.isSymbolicLink() && meta.size <= 262144,
    "invalid V2 backup manifest",
  );
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  ) as TownBackupManifest;
  requireStorage(
    manifest.schema === "living-town-projection-backup-v1" &&
      manifest.mode === "non_signing_projection_only" &&
      json(parseLivingTownIdentity(manifest.identity)) === json(identity) &&
      Number.isSafeInteger(manifest.capturedAt) &&
      manifest.capturedAt >= 0 &&
      Array.isArray(manifest.archives) &&
      manifest.archives.length <= 400 &&
      manifest.database.file === "living-town.sqlite" &&
      manifest.config.file === "economy.json",
    "backup identity/manifest mismatch",
  );
  const files = [manifest.database, manifest.config, ...manifest.archives];
  const names = files.map((f) => f.file);
  requireStorage(
    new Set(names).size === names.length &&
      json((await readdir(root)).sort()) ===
        json([...names, "manifest.json"].sort()),
    "incomplete or unexpected backup artifacts",
  );
  for (const file of files)
    requireStorage(
      json(await hashFile(root, file.file)) === json(file),
      "backup file checksum/size mismatch",
    );
  await config(root, identity);
  const db = open(join(root, "living-town.sqlite"));
  try {
    requireStorage(
      db
        .prepare("SELECT identity FROM projection_identity WHERE singleton=1")
        .get()?.["identity"] === json(identity),
      "backup database identity mismatch",
    );
    const cut = report(db);
    requireStorage(
      json(cut) === json(manifest.report),
      "backup checkpoint/state mismatch",
    );
    const chunks = archives(db, identity, cut);
    requireStorage(
      chunks.length === manifest.archives.length,
      "backup archive coverage mismatch",
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!,
        artifact = manifest.archives[i]!;
      requireStorage(
        chunk.file === artifact.file && sha256(chunk.body) === artifact.sha256,
        "backup archive/snapshot mismatch",
      );
    }
  } finally {
    db.close();
  }
  return manifest;
}
export async function restoreTownBackup(
  root: string,
  output: string,
  expected: unknown,
): Promise<TownBackupManifest> {
  const manifest = await verifyTownBackup(root, expected);
  requireStorage(
    isAbsolute(output),
    "new absolute isolated restore directory required",
  );
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "RESTORE_INCOMPLETE"), "Not ready for use.\n", {
    flag: "wx",
    mode: 0o600,
  });
  for (const file of [
    manifest.database,
    manifest.config,
    ...manifest.archives,
  ]) {
    await copyFile(
      join(root, file.file),
      join(output, file.file),
      constants.COPYFILE_EXCL,
    );
    requireStorage(
      json(await hashFile(output, file.file)) === json(file),
      "restore copy checksum mismatch",
    );
  }
  await copyFile(
    join(root, "manifest.json"),
    join(output, "manifest.json"),
    constants.COPYFILE_EXCL,
  );
  await unlink(join(output, "RESTORE_INCOMPLETE"));
  await verifyTownBackup(output, expected);
  return manifest; // No signer, journal authorization, server or RPC is started.
}
