import { backup, DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { DeploymentIdentity } from "@bot-bazaar/chain";
import { schemaVersion } from "./schema.js";
import { identityJson, requireStorage, StorageError } from "./validation.js";

interface Manifest {
  schema: number;
  identity: DeploymentIdentity;
  capturedAt: number;
  database: { file: "worker.sqlite"; bytes: number; sha256: string };
  observedRevision: string | null;
  observedHeight: string | null;
  artifacts: never[];
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}
export async function verifyBackup(directory: string): Promise<Manifest> {
  try {
    requireStorage(
      (await lstat(directory)).isDirectory() &&
        !(await lstat(directory)).isSymbolicLink(),
      "invalid backup directory",
    );
    const manifestPath = join(directory, "manifest.json");
    const info = await lstat(manifestPath);
    requireStorage(
      info.isFile() && !info.isSymbolicLink() && info.size <= 65536,
      "invalid backup manifest",
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as Manifest;
    requireStorage(
      [1, 2, 3, 4, 5, 6, schemaVersion].includes(manifest.schema) &&
        Array.isArray(manifest.artifacts) &&
        manifest.artifacts.length === 0 &&
        Number.isSafeInteger(manifest.capturedAt) &&
        manifest.capturedAt >= 0 &&
        manifest.database.file === "worker.sqlite" &&
        /^[a-f0-9]{64}$/.test(manifest.database.sha256),
      "invalid backup manifest",
    );
    identityJson(manifest.identity);
    const path = join(directory, "worker.sqlite");
    const file = await lstat(path);
    requireStorage(
      file.isFile() &&
        !file.isSymbolicLink() &&
        file.size === manifest.database.bytes &&
        file.size <= 2 ** 31 &&
        (await fileHash(path)) === manifest.database.sha256,
      "backup database hash mismatch",
    );
    const db = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      requireStorage(
        db.prepare("PRAGMA integrity_check").get()!["integrity_check"] ===
          "ok" &&
          db.prepare("PRAGMA foreign_key_check").all().length === 0 &&
          db.prepare("PRAGMA user_version").get()!["user_version"] ===
            manifest.schema,
        "backup integrity failed",
      );
      const deployment = db
        .prepare("SELECT * FROM deployment WHERE singleton=1")
        .get()!;
      requireStorage(
        deployment["identity"] === identityJson(manifest.identity) &&
          deployment["observed_revision"] === manifest.observedRevision &&
          deployment["observed_height"] === manifest.observedHeight &&
          [0, 1].includes(Number(deployment["recovery_required"])) &&
          db.prepare("SELECT count(*) AS n FROM merchants").get()!["n"] === 3,
        "backup checkpoint mismatch",
      );
    } finally {
      db.close();
    }
    return manifest;
  } catch {
    throw new StorageError("backup verification failed");
  }
}

export async function createBackup(
  db: DatabaseSync,
  identity: DeploymentIdentity,
  destination: string,
): Promise<string> {
  try {
    requireStorage(
      isAbsolute(destination),
      "absolute backup directory required",
    );
    const root = await realpath(destination);
    const rootInfo = await lstat(destination);
    requireStorage(
      rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
      "existing backup directory required",
    );
    const entries = await readdir(root);
    requireStorage(
      entries.length < 512,
      "backup directory requires maintenance",
    );
    const disk = await statfs(root);
    const pages = Number(db.prepare("PRAGMA page_count").get()!["page_count"]);
    const pageSize = Number(db.prepare("PRAGMA page_size").get()!["page_size"]);
    requireStorage(
      disk.bavail * disk.bsize > pages * pageSize * 2 + 16 * 1024 * 1024,
      "insufficient backup disk headroom",
    );
    let existingBytes = 0;
    for (const entry of entries) {
      const dir = join(root, entry),
        info = await lstat(dir);
      requireStorage(
        info.isDirectory() && !info.isSymbolicLink(),
        "unexpected backup entry",
      );
      for (const name of await readdir(dir)) {
        const item = await lstat(join(dir, name));
        requireStorage(
          item.isFile() && !item.isSymbolicLink(),
          "unexpected backup artifact",
        );
        existingBytes += item.size;
      }
    }
    requireStorage(
      existingBytes + pages * pageSize + 65536 <= 64 * 2 ** 30,
      "backup allowance exceeded",
    );
    const suffix = randomUUID(),
      staging = join(root, `incomplete-${suffix}`),
      completed = join(root, `backup-${suffix}`);
    await mkdir(staging, { mode: 0o700 });
    const path = join(staging, "worker.sqlite");
    await backup(db, path);
    await chmod(path, 0o600);
    const fileHandle = await open(path, "r+");
    try {
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    const snapshot = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
    });
    let revision: string | null, height: string | null;
    try {
      const row = snapshot
        .prepare(
          "SELECT observed_revision,observed_height FROM deployment WHERE singleton=1",
        )
        .get()!;
      revision = row["observed_revision"] as string | null;
      height = row["observed_height"] as string | null;
    } finally {
      snapshot.close();
    }
    const manifest: Manifest = {
      schema: schemaVersion,
      identity: JSON.parse(identityJson(identity)) as DeploymentIdentity,
      capturedAt: Date.now(),
      database: {
        file: "worker.sqlite",
        bytes: (await lstat(path)).size,
        sha256: await fileHash(path),
      },
      observedRevision: revision,
      observedHeight: height,
      artifacts: [],
    };
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600, flush: true },
    );
    await verifyBackup(staging);
    await rename(staging, completed);
    if (process.platform !== "win32") {
      const directoryHandle = await open(root, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
    return completed;
  } catch {
    throw new StorageError("backup failed; no verified replacement published");
  }
}

// Only verified bundles created by this implementation are eligible for removal.
// Incomplete bundles count against capacity but require operator review.
export async function retainBackups(root: string): Promise<void> {
  requireStorage(
    isAbsolute(root) && !(await lstat(root)).isSymbolicLink(),
    "invalid backup root",
  );
  root = await realpath(root);
  const bundles: { path: string; manifest: Manifest }[] = [];
  for (const name of await readdir(root))
    if (/^backup-[a-f0-9-]{36}$/.test(name)) {
      const path = join(root, name);
      bundles.push({ path, manifest: await verifyBackup(path) });
    }
  bundles.sort(
    (a, b) =>
      b.manifest.capturedAt - a.manifest.capturedAt ||
      b.path.localeCompare(a.path),
  );
  const keep = new Set(bundles.slice(0, 24).map((row) => row.path));
  const days = new Set<string>();
  for (const row of bundles) {
    const day = new Date(row.manifest.capturedAt).toISOString().slice(0, 10);
    if (!days.has(day) && days.size < 7) {
      days.add(day);
      keep.add(row.path);
    }
  }
  for (const row of bundles)
    if (!keep.has(row.path)) await rm(row.path, { recursive: true });
}
