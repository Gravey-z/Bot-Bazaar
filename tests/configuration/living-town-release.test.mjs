import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  releaseCandidate,
  verifyCandidate,
} from "../../scripts/living-town-release.mjs";

test("release candidate binds actual source/config bytes while leaving deployment unapproved", async () => {
  const c = await releaseCandidate();
  assert.equal(c.status, "local_candidate_not_deployed");
  assert.equal(c.deployment.identity, null);
  assert.equal(c.deployment.approved_frontend_origin, null);
  assert.equal(c.deployment.contract_wasm_sha256, null);
  assert.equal(c.versions.projection_sqlite, 5);
  assert.equal(c.versions.execution_sqlite, 1009);
  assert.equal(c.versions.assistant_sqlite, 5005);
  for (const path of [
    "contracts/living-town/src/lib.rs",
    "config/living-town-v1.json",
    "scripts/living-town-release.mjs",
  ]) {
    const entry = c.source.files.find((f) => f.path === path);
    const bytes = await readFile(new URL(`../../${path}`, import.meta.url));
    assert.equal(
      entry.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(entry.bytes, bytes.length);
  }
  assert.ok(
    c.source.files.every(
      (f) =>
        !/(?:^|\/)(?:\.env|worker\.env|node_modules|data|\.git)(?:\/|$)/.test(
          f.path,
        ),
    ),
  );
  assert.deepEqual(c, await releaseCandidate());
});

test("verification rejects forged approval, changed file hashes and missing inventory entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "town-release-"));
  try {
    const path = join(dir, "candidate.json"),
      c = await releaseCandidate();
    await writeFile(path, JSON.stringify(c));
    assert.deepEqual(await verifyCandidate(path), c);
    for (const mutate of [
      (v) => {
        v.status = "approved";
      },
      (v) => {
        v.source.files[0].sha256 = "0".repeat(64);
      },
      (v) => {
        v.source.files.pop();
      },
      (v) => {
        v.deployment.identity = { contract_id: "forged.testnet" };
      },
    ]) {
      const changed = structuredClone(c);
      mutate(changed);
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(verifyCandidate(path));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
