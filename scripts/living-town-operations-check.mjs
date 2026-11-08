import { lstat, readFile } from "node:fs/promises";
const path = process.argv[2];
try {
  if (process.argv.length !== 3) throw Error("report path required");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw Error("invalid report file");
  const report = JSON.parse(await readFile(path, "utf8")),
    age = Date.now() - report.capturedAt;
  if (
    report.schema !== "living-town-operations-v1" ||
    !["read_projection", "simulation"].includes(report.role) ||
    !["active", "paused", "recovery_only"].includes(report.mode) ||
    !Number.isSafeInteger(report.capturedAt) ||
    age < 0 ||
    age > 120000 ||
    !Array.isArray(report.alerts) ||
    report.alerts.length > 32 ||
    report.alerts.some(
      (code) => typeof code !== "string" || !/^[a-z_]{1,40}$/.test(code),
    )
  )
    throw Error("invalid or stale operations report");
  const ready =
    report.role === "read_projection"
      ? report.readiness?.readProjection === true
      : report.readiness?.signingRuntime === true;
  console.log(
    JSON.stringify({
      status: ready && report.alerts.length === 0 ? "ok" : "attention",
      role: report.role,
      mode: report.mode,
      ageMs: age,
      alerts: report.alerts,
    }),
  );
  process.exitCode = ready && report.alerts.length === 0 ? 0 : 1;
} catch {
  console.error("Operations report unavailable, stale or invalid");
  process.exitCode = 2;
}
