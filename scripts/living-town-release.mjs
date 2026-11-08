import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalLivingTownJson,
  parseLivingTownWebProfile,
} from "../packages/chain/dist/index.js";
import { parseLivingTownWorkerConfig } from "../apps/worker/dist/private/living-town/config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (name) =>
  JSON.parse(await readFile(resolve(root, name), "utf8"));
const configs = [
  "config/living-town-v1.json",
  "config/living-town-reader.example.json",
  "config/living-town-web.example.json",
  "config/living-town-assistant.example.json",
  "config/living-town-read-compose.example.yml",
];

/** Offline source candidate only: never approves a deployment or reads env/key files. */
export async function releaseCandidate() {
  const reader = await json(configs[1]);
  // The distributed example uses a Linux absolute path. Validate its other fields
  // on Windows too; no directory/database is opened by the config parser.
  const parsed = parseLivingTownWorkerConfig({
    ...reader,
    data_dir: resolve(root, "data/release-validation-only"),
  });
  const web = parseLivingTownWebProfile(await json(configs[2]));
  const assistant = parseLivingTownWorkerConfig({
    ...(await json(configs[3])),
    data_dir: resolve(root, "data/release-validation-only"),
  });
  assert.deepEqual(web.identity, parsed.identity);
  assert.deepEqual(web.public, parsed.public);
  assert.deepEqual(assistant.identity, parsed.identity);
  assert.deepEqual(
    assistant.boundary.allowedOrigins,
    parsed.boundary.allowedOrigins,
  );
  const economy = await json(configs[0]);
  const economyHash = digest(canonicalLivingTownJson(economy));
  assert.equal(economyHash, parsed.identity.deployment.config_sha256);
  const sqliteVersion = async (name) => {
    const source = await readFile(resolve(root, name), "utf8");
    const match = /PRAGMA user_version=(\d+);/.exec(source);
    assert.ok(match, "schema version missing");
    return Number(match[1]);
  };

  const paths = [];
  async function collect(name) {
    const path = resolve(root, name);
    const stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink(), "release inputs cannot be symlinks");
    if (stat.isDirectory()) {
      for (const child of await readdir(path))
        await collect(`${name}/${child}`);
    } else {
      assert.ok(stat.isFile() && stat.size <= 16 * 1024 * 1024);
      // Explicit trees and source types only. Never enumerate deploy env/keys.
      if (
        /\.(?:ts|rs|html|css|scss|json|svg|png|webp|ico|mjs|toml|yaml|yml|lock)$/.test(
          name,
        ) ||
        name.endsWith("/_headers") ||
        name === "Dockerfile.toolchain"
      )
        paths.push(name);
    }
  }
  for (const name of [
    "apps/web/src",
    "apps/web/public",
    "apps/worker/src",
    "packages/chain/src",
    "packages/shared/src",
    "contracts/living-town/src",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/web/package.json",
    "apps/worker/package.json",
    "apps/web/angular.json",
    "apps/web/tsconfig.json",
    "apps/worker/tsconfig.json",
    "tsconfig.base.json",
    "eslint.config.mjs",
    "rust-toolchain.toml",
    "Dockerfile.toolchain",
    "packages/chain/package.json",
    "packages/chain/tsconfig.json",
    "packages/shared/package.json",
    "packages/shared/tsconfig.json",
    "contracts/living-town/Cargo.toml",
    "Cargo.toml",
    "Cargo.lock",
    ...configs,
  ])
    await collect(name);
  const files = [];
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await readFile(resolve(root, path));
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  return {
    schema: "bot-bazaar-living-town-release-candidate-v1",
    status: "local_candidate_not_deployed",
    source: {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      content_sha256: digest(JSON.stringify(files)),
      files,
    },
    versions: {
      api: parsed.identity.deployment.api_version,
      state: parsed.identity.deployment.state_schema,
      command: parsed.identity.deployment.command_schema,
      economy: economy.version,
      projection_sqlite: await sqliteVersion(
        "apps/worker/src/private/living-town/schema.ts",
      ),
      execution_sqlite: await sqliteVersion(
        "apps/worker/src/private/living-town/execution-store.ts",
      ),
      assistant_sqlite: await sqliteVersion(
        "apps/worker/src/private/assistant/store.ts",
      ),
    },
    config: {
      canonical_economy_sha256: economyHash,
      profiles: "validated_examples_only",
    },
    deployment: {
      network: "testnet",
      identity: null,
      deployed_code_hash: null,
      contract_wasm_sha256: null,
      frontend_artifact_sha256: null,
      worker_artifact_sha256: null,
      approved_frontend_origin: null,
      approved_worker_origin: null,
      approved_assistant_origin: null,
    },
    blockers: [
      "Uncommitted source contents are fingerprinted; freeze and rebuild the release revision.",
      "Example accounts, genesis/code hashes and loopback origins are not deployed identity or approval.",
      "Record verified WASM/frontend/worker artifact hashes and finalized deployment identity.",
      "Approve actual HTTPS origins and validate matching real reader/web/assistant profiles.",
      "Complete P7.5 live conditions and P7.7-P7.11 hosted/manual gates.",
    ],
  };
}

export async function verifyCandidate(path) {
  const stat = await lstat(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024,
  );
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(
    saved,
    await releaseCandidate(),
    "release candidate differs from current reviewed inputs",
  );
  return saved;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const [mode, output, ...extra] = process.argv.slice(2);
    assert.ok(["create", "verify"].includes(mode) && output && !extra.length);
    const path = resolve(output);
    const candidate =
      mode === "verify"
        ? await verifyCandidate(path)
        : await releaseCandidate();
    if (mode === "create") {
      // Explicit new output only; never overwrite source, env files or a previous capture.
      const name = relative(root, path).split(sep).join("/");
      assert.ok(name && !name.startsWith("../") && !name.startsWith(".git/"));
      await writeFile(path, JSON.stringify(candidate, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
    console.log(
      JSON.stringify({
        status: candidate.status,
        files: candidate.source.files.length,
        content_sha256: candidate.source.content_sha256,
      }),
    );
  } catch {
    console.error(
      "Release candidate check failed; use create <new-workspace-manifest.json> or verify <manifest.json> after building chain/worker packages.",
    );
    process.exitCode = 1;
  }
}
