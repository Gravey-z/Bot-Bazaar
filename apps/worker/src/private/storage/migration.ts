import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { discoverySchema } from "./schema.js";
import { requireStorage } from "./validation.js";

// Migration runs only after ownership, deployment identity and integrity checks.
// VACUUM INTO provides a consistent pre-migration snapshot without changing source.
export function migrateDiscovery(db: DatabaseSync, root: string): void {
  requireStorage(
    isAbsolute(root),
    "absolute migration backup directory required",
  );
  mkdirSync(root, { mode: 0o700, recursive: true });
  requireStorage(
    !lstatSync(root).isSymbolicLink() && readdirSync(root).length < 512,
    "migration backup directory unavailable or full",
  );
  const disk = statfsSync(root);
  const bytes =
    Number(db.prepare("PRAGMA page_count").get()!["page_count"]) *
    Number(db.prepare("PRAGMA page_size").get()!["page_size"]);
  let retainedBytes = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name),
      info = lstatSync(path);
    requireStorage(
      info.isDirectory() && !info.isSymbolicLink(),
      "unexpected migration backup entry",
    );
    for (const file of readdirSync(path)) {
      const info = lstatSync(join(path, file));
      requireStorage(
        info.isFile() && !info.isSymbolicLink(),
        "unexpected migration artifact",
      );
      retainedBytes += info.size;
    }
  }
  requireStorage(
    bytes <= 2 ** 31 && retainedBytes + bytes + 65536 <= 64 * 2 ** 30,
    "migration backup allowance exceeded",
  );
  requireStorage(
    disk.bavail * disk.bsize > 2 * bytes + 16 * 1024 * 1024,
    "insufficient migration backup headroom",
  );
  const directory = join(root, `incomplete-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "worker.sqlite");
  db.prepare("VACUUM INTO ?").run(path);
  chmodSync(path, 0o600);
  const fd = openSync(path, "r+");
  const hash = createHash("sha256");
  try {
    fsyncSync(fd);
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, size));
  } finally {
    closeSync(fd);
  }
  const snapshot = new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    requireStorage(
      snapshot.prepare("PRAGMA integrity_check").get()!["integrity_check"] ===
        "ok" &&
        snapshot.prepare("PRAGMA foreign_key_check").all().length === 0 &&
        snapshot.prepare("PRAGMA user_version").get()!["user_version"] === 1,
      "migration backup integrity failed",
    );
    const row = snapshot
      .prepare("SELECT * FROM deployment WHERE singleton=1")
      .get()!;
    const manifest = {
      schema: 1,
      identity: JSON.parse(String(row["identity"])),
      capturedAt: Date.now(),
      database: {
        file: "worker.sqlite",
        bytes: lstatSync(path).size,
        sha256: hash.digest("hex"),
      },
      observedRevision: row["observed_revision"],
      observedHeight: row["observed_height"],
      artifacts: [],
    };
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600, flag: "wx", flush: true },
    );
  } finally {
    snapshot.close();
  }
  renameSync(directory, join(root, `backup-${randomUUID()}`));
  if (process.platform !== "win32") {
    const fd = openSync(root, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(discoverySchema);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
