// Bounded operator supervisor. Gameplay/signing stays inside the existing runtime.
import assert from "node:assert/strict";
import { readFile, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
assert(
  args.length === 2 && args[0] === "--config" && isAbsolute(args[1]),
  "Use --config <absolute-AI-runtime-config>",
);
const config = JSON.parse(await readFile(args[1], "utf8"));
assert.equal(config.provider.kind, "near-ai");
const control = async (mode) => {
  const { rename } = await import("node:fs/promises");
  const temporary = config.control_file + ".acceptance.tmp";
  await writeFile(
    temporary,
    JSON.stringify({ schema: "living-town-runtime-control-v1", mode }),
    { mode: 0o600 },
  );
  await rename(temporary, config.control_file);
};
const stdout = await open(resolve("data/day03-runtime.stdout.log"), "a"),
  stderr = await open(resolve("data/day03-runtime.stderr.log"), "a");
let child,
  reason = "deadline",
  baseline,
  recoveryAt = 0,
  last = null;
const started = Date.now();
const initialStatus = JSON.parse(
  await readFile(resolve(config.execution_dir, "runtime-status.json"), "utf8"),
);
baseline = initialStatus.provider_attempts ?? 0;
const originalModelAction = initialStatus.last_model_action?.action_id;
try {
  await control("active");
  child = spawn(
    process.execPath,
    ["apps/worker/dist/living-town-runtime.js", "--config", args[1]],
    { windowsHide: true, stdio: ["ignore", stdout.fd, stderr.fd] },
  );
  await writeFile("data/day03-runtime.pid", String(child.pid));
  while (Date.now() - started < 900000) {
    if (child.exitCode !== null) {
      reason = "runtime_exited";
      break;
    }
    let status;
    try {
      status = JSON.parse(
        await readFile(
          resolve(config.execution_dir, "runtime-status.json"),
          "utf8",
        ),
      );
    } catch {
      await delay(1000);
      continue;
    }
    if (status.captured_at < started) {
      await delay(1000);
      continue;
    }
    const newConfirmedAction =
      status.last_model_action?.status === "confirmed" &&
      status.last_model_action.action_id !== originalModelAction;
    const summary = JSON.stringify({
      result: status.result,
      model_action: status.last_model_action,
      provider_attempts: status.provider_attempts,
      budget: status.budget,
    });
    if (summary !== last) {
      console.log(summary);
      last = summary;
    }
    if (
      !recoveryAt &&
      (newConfirmedAction ||
        status.provider_attempts - baseline >= 6 ||
        Date.now() - started >= 600000 ||
        status.budget?.dailyMicro >= 20000)
    ) {
      reason = newConfirmedAction
        ? "confirmed_model_action"
        : "bounded_test_limit";
      await control("recovery_only");
      recoveryAt = Date.now();
    }
    if (
      recoveryAt &&
      status.captured_at > recoveryAt &&
      status.unresolved_transactions === 0
    )
      break;
    await delay(1000);
  }
} finally {
  await control("paused");
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await stdout.close();
  await stderr.close();
  await writeFile(
    "data/day03-acceptance-supervisor.json",
    JSON.stringify(
      {
        started_at: started,
        finished_at: Date.now(),
        reason,
        control: "paused",
        runtime_stopped: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({ reason, control: "paused", runtime_stopped: true }),
  );
}
if (reason !== "confirmed_model_action") process.exitCode = 1;
