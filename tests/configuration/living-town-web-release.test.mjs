import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  releaseProfileUrl,
  validateTownRelease,
  townDeployment,
} from "../../scripts/living-town-web-release.mjs";
import { writeWebConfig } from "../../scripts/write-web-config.mjs";

const baseline = JSON.parse(await readFile(releaseProfileUrl, "utf8"));
test("V2 generation ignores legacy env and writes matching public-only files", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "town-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, "config.json");
  await writeWebConfig("missing.env", output, {
    WEB_EXPERIENCE: "living-town",
    LIVING_TOWN_TARGET: "local",
    NEAR_CONTRACT_ID: "wrong.testnet",
    WORKER_URL: "https://wrong.example",
  });
  const config = JSON.parse(await readFile(output, "utf8"));
  const raw = JSON.parse(
    await readFile(path.join(dir, "living-town.json"), "utf8"),
  );
  const parsed = await validateTownRelease(raw, "local");
  assert.deepEqual(config, parsed.public);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, "deployment.json"), "utf8")),
    townDeployment(config),
  );
  await assert.rejects(
    writeWebConfig("missing.env", output, {
      WEB_EXPERIENCE: "living-town",
      LIVING_TOWN_TARGET: "public",
    }),
  );
  await assert.rejects(readFile(output));
  await assert.rejects(readFile(path.join(dir, "living-town.json")));
});

test("V2 rejects changed code, authorities, config and unsuitable service origins", async () => {
  for (const edit of [
    (p) => {
      p.identity.codeHash = "11111111111111111111111111111111";
    },
    (p) => {
      p.identity.operatorId = "other.testnet";
    },
    (p) => {
      p.identity.deployment.config_sha256 = "0".repeat(64);
    },
    (p) => {
      p.public.contractId = "other.testnet";
      p.identity.deployment.contract_id = "other.testnet";
    },
    (p) => {
      p.private_key = "unexpected";
    },
  ]) {
    const raw = structuredClone(baseline);
    edit(raw);
    await assert.rejects(validateTownRelease(raw, "local"));
  }
  for (const workerUrl of [
    "http://127.0.0.1:3011",
    "https://localhost",
    "https://127.0.0.1",
    "https://192.168.1.2",
    "https://[::1]",
    "https://reader.local",
    "https://user:password@reader.example",
    "https://reader.example/?token=secret",
  ]) {
    await assert.rejects(
      validateTownRelease(
        { ...baseline, public: { ...baseline.public, workerUrl } },
        "public",
      ),
    );
  }
  await validateTownRelease(
    {
      ...baseline,
      public: { ...baseline.public, workerUrl: "https://reader.example.org" },
    },
    "public",
  );
});

test("release scanner requires profile, matching identity/config and explicit classic choice", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "town-scan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "replays"));
  await writeFile(
    path.join(dir, "replays/index.json"),
    JSON.stringify({ schema: "bot-bazaar-replay-collection-v1", entries: [] }),
  );
  await writeFile(path.join(dir, "main.js"), "// public fixture");
  await writeWebConfig("missing.env", path.join(dir, "config.json"), {
    WEB_EXPERIENCE: "living-town",
    LIVING_TOWN_TARGET: "local",
  });
  const scan = (mode) =>
    spawnSync(
      process.execPath,
      ["scripts/check-web-output.mjs", dir, ...(mode ? [mode] : [])],
      { encoding: "utf8" },
    );
  assert.equal(scan("v2-local").status, 0);
  assert.notEqual(scan().status, 0); // public is the safe default
  assert.notEqual(scan("classic").status, 0);
  const changed = structuredClone(baseline);
  changed.public.workerUrl = "https://reader.example.org";
  await writeFile(path.join(dir, "living-town.json"), JSON.stringify(changed));
  assert.notEqual(scan("v2-public").status, 0); // config/profile disagree
  await rm(path.join(dir, "living-town.json"));
  assert.notEqual(scan("v2-local").status, 0);
  assert.equal(scan("classic").status, 0);
});
