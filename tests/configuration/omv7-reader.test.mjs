import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  omv7ReaderConfig,
  projectionInitialization,
} from "../../scripts/omv7-reader-config.mjs";

const profile = JSON.parse(
  await readFile(
    new URL("../../config/living-town-testnet.json", import.meta.url),
    "utf8",
  ),
);
const env = {
  V2_RELEASE_TARGET: "local",
  V2_WORKER_URL: "http://127.0.0.1:3011",
  V2_FRONTEND_ORIGIN: "http://127.0.0.1:4201",
};
test("OMV7 config isolates persistence, exact frontend origin and read-only role", () => {
  const config = omv7ReaderConfig(profile, env);
  assert.deepEqual(config.allowed_origins, [env.V2_FRONTEND_ORIGIN]);
  assert.equal(config.data_dir, "/data/projection");
  assert.deepEqual(config.identity, profile.identity);
  assert.equal(config.poll_ms, "15000");
  assert.equal(config.receipt_inbox, null);
  assert.equal(config.agent_activity_inbox, null);
  for (const edit of [
    { V2_RELEASE_TARGET: "other" },
    { V2_FRONTEND_ORIGIN: "http://127.0.0.1:4201/" },
    { V2_FRONTEND_ORIGIN: "https://web.example.org/path" },
    { V2_WORKER_URL: "http://127.0.0.1:4000" },
    { V2_RELEASE_TARGET: "public" },
    {
      V2_RELEASE_TARGET: "public",
      V2_FRONTEND_ORIGIN: "https://localhost",
      V2_WORKER_URL: "https://api.example.org",
    },
  ])
    assert.throws(() => omv7ReaderConfig(profile, { ...env, ...edit }));
  const pub = omv7ReaderConfig(profile, {
    V2_RELEASE_TARGET: "public",
    V2_WORKER_URL: "https://api.example.org",
    V2_FRONTEND_ORIGIN: "https://game.pages.dev",
  });
  assert.deepEqual(pub.allowed_origins, ["https://game.pages.dev"]);
});
test("projection creation requires explicit opt-in and never replaces nonempty storage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omv7-reader-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => projectionInitialization(dir, "false"));
  assert.equal(projectionInitialization(dir, "true"), true);
  await writeFile(join(dir, "recovery-material.json"), "{}");
  assert.throws(() => projectionInitialization(dir, "true"));
  await writeFile(
    join(dir, "living-town.sqlite"),
    "existing database is validated by the store",
  );
  assert.equal(projectionInitialization(dir, "true"), false);
  assert.equal(projectionInitialization(dir, "false"), false);
});
