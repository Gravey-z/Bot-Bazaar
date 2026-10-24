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
const task = process.argv[2];
if (!Object.hasOwn(tasks, task)) {
  console.error(
    "Usage: node scripts/rust-toolchain.mjs <build|unit|test|check|format>",
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
