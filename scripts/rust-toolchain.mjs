import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const image = "bot-bazaar-toolchain:1.93.0-near0.22.0";
const build = [
  "cargo",
  "near",
  "build",
  "non-reproducible-wasm",
  "--manifest-path",
  "contracts/market/Cargo.toml",
  "--out-dir",
  "target/near",
  "--locked",
];
const tasks = {
  build: [build],
  unit: [["cargo", "test", "-p", "bot-bazaar-market", "--lib", "--locked"]],
  test: [
    build,
    [
      "cargo",
      "near",
      "build",
      "non-reproducible-wasm",
      "--manifest-path",
      "tests/fixtures/storage/Cargo.toml",
      "--out-dir",
      "target/near/fixtures",
      "--locked",
    ],
    [
      "cargo",
      "test",
      "-p",
      "sandbox-tests",
      "--test",
      "sandbox",
      "--locked",
      "--",
      "--nocapture",
      "--test-threads=2",
    ],
  ],
  check: [
    ["cargo", "fmt", "--all", "--", "--check"],
    [
      "cargo",
      "clippy",
      "-p",
      "storage-fixture",
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
    [
      "cargo",
      "near",
      "check",
      "--manifest-path",
      "tests/fixtures/storage/Cargo.toml",
      "--clippy",
      "--locked",
    ],
    [
      "cargo",
      "clippy",
      "-p",
      "bot-bazaar-market",
      "--lib",
      "--tests",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
    [
      "cargo",
      "near",
      "check",
      "--manifest-path",
      "contracts/market/Cargo.toml",
      "--clippy",
      "--locked",
    ],
    [
      "cargo",
      "clippy",
      "-p",
      "sandbox-tests",
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
  ],
  format: [["cargo", "fmt", "--all"]],
};
const buildV2 = [...build];
buildV2[buildV2.indexOf("contracts/market/Cargo.toml")] =
  "contracts/living-town/Cargo.toml";
buildV2[buildV2.indexOf("target/near")] = "target/near/living-town";
tasks["build-v2"] = [buildV2];
tasks["unit-v2"] = [
  ["cargo", "test", "-p", "bot-bazaar-living-town", "--lib", "--locked"],
];
tasks["test-v2"] = [
  ...tasks["unit-v2"],
  buildV2,
  [
    "cargo",
    "test",
    "-p",
    "sandbox-tests",
    "--test",
    "living_town",
    "--locked",
    "--",
    "--nocapture",
    "--test-threads=1",
  ],
];
tasks["check-v2"] = [
  ["cargo", "fmt", "--all", "--", "--check"],
  [
    "cargo",
    "clippy",
    "-p",
    "bot-bazaar-living-town",
    "--lib",
    "--tests",
    "--locked",
    "--",
    "-D",
    "warnings",
  ],
  [
    "cargo",
    "near",
    "check",
    "--manifest-path",
    "contracts/living-town/Cargo.toml",
    "--clippy",
    "--locked",
  ],
  [
    "cargo",
    "clippy",
    "-p",
    "sandbox-tests",
    "--test",
    "living_town",
    "--locked",
    "--",
    "-D",
    "warnings",
  ],
];
const task = process.argv[2];
if (!Object.hasOwn(tasks, task)) {
  console.error(
    "Usage: node scripts/rust-toolchain.mjs <build|unit|test|check|format|build-v2|unit-v2|test-v2|check-v2>",
  );
  process.exit(1);
}

for (const command of tasks[task]) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${root},target=/workspace`,
      "--mount",
      "type=volume,source=bot-bazaar-cargo-registry,target=/usr/local/cargo/registry",
      "--mount",
      "type=volume,source=bot-bazaar-target,target=/workspace/target",
      "--env",
      "CARGO_BUILD_JOBS=2",
      image,
      ...command,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    console.error(
      "Rust command failed. Check Docker Desktop (Linux containers) and run corepack pnpm toolchain:build if the image is missing.",
    );
    process.exit(result.status || 1);
  }
}
