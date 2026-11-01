import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const contractBuild = [
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

export async function testnetPreflight() {
  const definition = JSON.parse(
    await readFile(
      new URL("../tests/scenarios/near-ai-testnet.json", import.meta.url),
      "utf8",
    ),
  );
  // This command deliberately does not load worker.env, inspect credentials or
  // treat a CLI flag as an adapter/accounting/continuity implementation.
  return {
    schema: definition.schema,
    scenario: definition.scenario,
    mode: definition.mode,
    label: "Real-provider Testnet preflight; not executed",
    provider: "near-ai",
    status: "blocked",
    liveAiEvidence: false,
    providerRequests: 0,
    chainMutations: 0,
    blockers: definition.requires,
    execution:
      "Production NEAR AI adapter/accounting/continuity are not integrated; this command cannot dispatch or sign.",
    acceptance: definition.acceptance,
  };
}

export async function runScenario(args, run = spawnSync) {
  if (args.length !== 1 || !["sandbox", "testnet"].includes(args[0]))
    throw new Error(
      "Usage: node scripts/run-agent-scenario.mjs <sandbox|testnet>",
    );
  const mode = args[0],
    directory = join(root, "target", "scenarios", `${mode}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const reportPath = join(
    directory,
    mode === "sandbox"
      ? "controlled-sandbox.json"
      : "near-ai-testnet-preflight.json",
  );
  if (mode === "testnet") {
    const report = await testnetPreflight();
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
    return { reportPath, report, exitCode: 2 };
  }
  const metadata = {
    schema: "bot-bazaar-scenario-v1",
    scenario: "controlled-sandbox-crystal-shortage",
    mode: "controlled_sandbox",
    label: "Controlled sandbox test data",
    liveAiEvidence: false,
    provider: "controlled-fixture",
    network: "sandbox",
  };
  await writeFile(
    reportPath,
    JSON.stringify({ ...metadata, status: "running" }) + "\n",
    { flag: "wx" },
  );
  const commands = [
    ["build", "-f", "Dockerfile.worker", "-t", "bot-bazaar-worker:local", "."],
    [
      "build",
      "-f",
      "Dockerfile.scenarios",
      "-t",
      "bot-bazaar-scenarios:local",
      ".",
    ],
    ...[
      contractBuild,
      [
        "cargo",
        "test",
        "-p",
        "sandbox-tests",
        "--test",
        "scenarios",
        "--locked",
        "--",
        "--nocapture",
        "--test-threads=1",
      ],
    ].map((command) => [
      "run",
      "--rm",
      ...(command[0] === "cargo" && command[1] === "test"
        ? ["--network", "none"]
        : []),
      "--mount",
      "type=volume,source=bot-bazaar-cargo-registry,target=/usr/local/cargo/registry",
      "--mount",
      "type=volume,source=bot-bazaar-target,target=/workspace/target",
      "--mount",
      `type=bind,source=${resolve(directory)},target=/scenario-output`,
      "--env",
      "CARGO_BUILD_JOBS=2",
      "--env",
      "BAZAAR_SCENARIO_OUTPUT=/scenario-output/controlled-sandbox.json",
      "bot-bazaar-scenarios:local",
      ...command,
    ]),
  ];
  for (const [stage, command] of commands.entries()) {
    const result = run("docker", command, {
      cwd: root,
      stdio: "inherit",
      timeout: 600000,
    });
    if (result.error || result.status !== 0) {
      const report = {
        ...metadata,
        status: "failed",
        code: "sandbox_stage_failed",
        stage: [
          "worker_image",
          "scenario_image",
          "contract_build",
          "sandbox_execution",
        ][stage],
        completed: false,
      };
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      return { reportPath, report, exitCode: 1 };
    }
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    report.status !== "passed" ||
    report.mode !== "controlled_sandbox" ||
    report.liveAiEvidence !== false
  )
    throw new Error("Sandbox did not produce a valid controlled report");
  return { reportPath, report, exitCode: 0 };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const result = await runScenario(process.argv.slice(2));
    console.info(`${result.report.label}: ${result.report.status}`);
    console.info(`Report: ${result.reportPath}`);
    if (result.report.blockers)
      console.info(
        "Live execution is blocked; no provider or chain calls were made.",
      );
    process.exitCode = result.exitCode;
  } catch {
    console.error(
      "Scenario command failed; expected sandbox or testnet. Preserve any existing run report.",
    );
    process.exitCode = 1;
  }
}
