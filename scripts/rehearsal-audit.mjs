import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkerStore } from "../apps/worker/dist/private/storage/database.js";
import { verifyBackup } from "../apps/worker/dist/private/storage/backup.js";
import { validateRehearsalManifest } from "./rehearsal-plan.mjs";

// Run only after this rehearsal worker is stopped. WorkerStore's exclusive
// ownership lock rejects an active owner; an old database is never copied in.
export async function auditRehearsalStore(manifestPath) {
  const directory = dirname(resolve(manifestPath));
  const plan = JSON.parse(await readFile(manifestPath, "utf8"));
  validateRehearsalManifest(plan);
  const store = new WorkerStore({
    dataDir: join(directory, "data"),
    identity: plan.identity,
    policyVersion: plan.policyVersion,
    create: false,
  });
  try {
    const counts = Object.fromEntries(
      [
        "jobs",
        "decisions",
        "intents",
        "attempts",
        "inference_records",
        "inference_usage",
        "usage_state",
      ].map((table) => [
        table,
        Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n),
      ]),
    );
    const unresolved = Number(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM intents WHERE status NOT IN ('confirmed','failed','abandoned')",
        )
        .get().n,
    );
    const backupDirectory = join(directory, "data", "backups");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backupPath = await store.backup(backupDirectory);
    const backup = await verifyBackup(backupPath);
    return {
      schema: plan.schema,
      runId: plan.runId,
      observedAt: new Date().toISOString(),
      identity: plan.identity,
      workerStoppedForAudit: true,
      counts,
      unresolvedIntents: unresolved,
      drainStatus:
        unresolved === 0
          ? "no_unresolved_intents"
          : "blocked_preserve_and_reconcile",
      backup: {
        directory: backupPath,
        capturedAt: backup.capturedAt,
        sha256: backup.database.sha256,
        observedRevision: backup.observedRevision,
      },
      providerContinuity: "unverified_do_not_enable_paid_admission",
      providerUsageReset: false,
      liveAiEvidence: false,
    };
  } finally {
    await store.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (process.argv.length !== 3) throw new Error("Manifest required");
    const report = await auditRehearsalStore(process.argv[2]);
    const output = join(
      dirname(resolve(process.argv[2])),
      `store-audit-${Date.now()}.json`,
    );
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
    console.info(
      JSON.stringify({
        report: output,
        drainStatus: report.drainStatus,
        backup: "verified",
        providerContinuity: report.providerContinuity,
      }),
    );
  } catch {
    console.error(
      "Rehearsal audit stopped. Stop only the intended worker and preserve its journal/usage history; do not delete, replace or initialize its database to bypass this check.",
    );
    process.exitCode = 1;
  }
}
