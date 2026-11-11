import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { open, readFile, unlink } from "node:fs/promises";
import { atomicRuntimeJson } from "../apps/worker/dist/private/living-town/runtime-outbox.js";

const context = new AsyncLocalStorage();
export const demoLifecycle = () => context.getStore();
export function checkDemoAdmission() { demoLifecycle()?.check(); }
const failure = (code) => Object.assign(new Error(code), { code });
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

/** One helper owns only the child handle it spawned. Saved PIDs are never killed. */
class DemoLifecycle {
  constructor(plan, config, recover) {
    this.plan = plan;
    this.config = config;
    this.recover = recover;
    this.id = randomUUID();
    this.controller = new AbortController();
    this.stopped = false;
    this.signalName = null;
    this.child = null;
    this.childStop = null;
    this.childCleanupFailed = false;
    this.playerIntents = new Map();
    this.controlWrites = Promise.resolve();
    this.stateWrites = Promise.resolve();
    this.pauseError = false;
    this.statePath = join(plan.directory, "helper-lifecycle.json");
    this.lockPath = join(plan.directory, "helper-lifecycle.lock");
  }
  check() {
    if (this.stopped) throw failure("DEMO_INTERRUPTED");
    if (this.recover) throw failure("DEMO_RECOVERY_ONLY");
  }
  async control(mode) {
    const work = this.controlWrites.catch(() => {}).then(() => atomicRuntimeJson(this.config.control_file, {
      schema: "living-town-runtime-control-v1",
      mode: this.stopped || (this.recover && mode === "active") ? "paused" : mode,
    }));
    this.controlWrites = work;
    return work;
  }
  async persist(state, extra = {}) {
    const work = this.stateWrites.catch(() => {}).then(() => atomicRuntimeJson(this.statePath, {
      run_id: this.id, host: hostname(), pid: process.pid,
      state: this.stopped && state === "finished" ? "needs_recovery" : state,
      signal: this.signalName, child_pid: this.child?.pid ?? null,
      pause_write_failed: this.pauseError,
      child_cleanup_failed: this.childCleanupFailed,
      player_intents: [...this.playerIntents.values()],
      captured_at: new Date().toISOString(), ...extra,
    }));
    this.stateWrites = work;
    return work;
  }
  async playerIntent(record) {
    this.playerIntents.set(record.label ?? record.transaction_hash, record);
    await this.persist(this.stopped ? "stopping" : "running");
  }
  interrupt(signal) {
    if (this.stopped) return;
    // Fence synchronously, before any asynchronous control-file write completes.
    this.stopped = true;
    this.signalName = signal;
    this.controller.abort();
    this.interruption = (async () => {
      try { await this.control("paused"); } catch { this.pauseError = true; }
      await this.stopChild();
      await this.persist("stopping");
    })().catch(() => { this.pauseError = true; });
  }
  async stopChild() {
    if (this.childStop) return this.childStop;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.childStop = (async () => {
      try { await this.control("paused"); } catch { this.pauseError = true; }
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(force); clearTimeout(deadline);
          child.off("close", done);
          resolve();
        };
        // Signal only this ChildProcess object, never a process name/tree or a
        // PID recovered from disk. Hard termination leaves original work unknown.
        child.once("close", done);
        const force = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { this.childCleanupFailed = true; }
        }, 5000);
        const deadline = setTimeout(() => { this.childCleanupFailed = true; done(); }, 10000);
        try { child.kill("SIGTERM"); } catch { this.childCleanupFailed = true; }
      });
    })();
    try { await this.childStop; } finally { this.childStop = null; }
  }
  async attach(child) {
    this.child = child;
    await this.persist("running");
    if (this.stopped) await this.stopChild();
  }
  detach(child) { if (this.child === child) this.child = null; }
  async acquire() {
    let prior = null;
    try { prior = await read(this.statePath); } catch (e) { if (e.code !== "ENOENT") throw e; }
    try {
      this.lock = await open(this.lockPath, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Serialize stale-owner recovery. Another recover command must not unlink
      // a lock newly acquired between the stale-owner check and replacement.
      const recoveryPath = this.lockPath + ".recovery";
      const claim = await open(recoveryPath, "wx", 0o600);
      try {
      await claim.writeFile(JSON.stringify({ host: hostname(), pid: process.pid, run_id: this.id }));
      await claim.sync();
      const owner = await read(this.lockPath);
      if (owner.host !== hostname() || alive(owner.pid)) throw failure("DEMO_HELPER_OWNER_NOT_FENCED");
      // The previous helper is gone. Pause first; a surviving child must be
      // stopped/fenced by its operator, never killed by trusting its saved PID.
      await this.control("paused");
      if (!this.recover || (prior?.child_pid && alive(prior.child_pid)))
        throw failure("DEMO_RECOVERY_REQUIRED");
      const currentOwner = await read(this.lockPath);
      if (currentOwner.run_id !== owner.run_id) throw failure("DEMO_HELPER_OWNER_CHANGED");
      await unlink(this.lockPath);
      this.lock = await open(this.lockPath, "wx", 0o600);
      } finally {
        await claim.close();
        await unlink(recoveryPath);
      }
    }
    try {
      await this.lock.writeFile(JSON.stringify({ run_id: this.id, host: hostname(), pid: process.pid }));
      await this.lock.sync();
      if (prior && prior.state !== "finished" && !this.recover) {
        await this.control("paused");
        throw failure("DEMO_RECOVERY_REQUIRED");
      }
      if (prior && prior.state !== "finished" && this.recover &&
        (prior.host !== hostname() || (prior.child_pid && alive(prior.child_pid))))
        throw failure("DEMO_HELPER_OWNER_NOT_FENCED");
      this.previous = prior;
      for (const record of prior?.player_intents ?? [])
        if (record.status === "unresolved") this.playerIntents.set(record.label ?? record.transaction_hash, record);
      await this.persist("running");
    } catch (error) { await this.release(); throw error; }
  }
  async release() {
    if (!this.lock) return;
    await this.lock.close(); this.lock = null;
    const owner = await read(this.lockPath);
    if (owner.run_id !== this.id) throw failure("DEMO_HELPER_OWNER_CHANGED");
    await unlink(this.lockPath);
  }
}

export async function withDemoLifecycle(plan, config, work, capture, { recover = false } = {}) {
  if (demoLifecycle()) throw failure("DEMO_HELPER_ALREADY_RUNNING");
  const lifecycle = new DemoLifecycle(plan, config, recover);
  await lifecycle.acquire();
  const onInt = () => lifecycle.interrupt("SIGINT");
  const onTerm = () => lifecycle.interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  let failed = false;
  try {
    return await context.run(lifecycle, async () => {
      try { return await work(lifecycle); }
      catch (error) { failed = true; throw error; }
      finally {
        await lifecycle.interruption;
        try { await lifecycle.control("paused"); } catch { lifecycle.pauseError = true; }
        await lifecycle.stopChild();
        let evidence = null;
        try { if (!lifecycle.childCleanupFailed) evidence = await capture(); }
        catch { /* Keep the recovery marker even when a journal cannot be read. */ }
        const unknownPlayer = [...lifecycle.playerIntents.values()].some(p => p.status === "unresolved");
        const needsRecovery = failed || lifecycle.stopped || lifecycle.pauseError ||
          lifecycle.childCleanupFailed || !evidence || evidence.unresolved.length > 0 || unknownPlayer ||
          evidence.providers.some(p => ["prepared", "reserved", "dispatched"].includes(p.status));
        await lifecycle.persist(needsRecovery ? "needs_recovery" : "finished", { evidence });
        await atomicRuntimeJson(join(plan.public_dir, "helper-shutdown.json"), {
          interrupted: lifecycle.stopped, signal: lifecycle.signalName,
          control_pause_confirmed: !lifecycle.pauseError,
          child_cleanup_confirmed: !lifecycle.childCleanupFailed,
          needs_recovery: needsRecovery || lifecycle.stopped,
          unresolved_player_transactions: [...lifecycle.playerIntents.values()].filter(p => p.status === "unresolved"),
          audit: evidence,
        });
        if (lifecycle.pauseError || lifecycle.childCleanupFailed || !evidence)
          throw failure("DEMO_SHUTDOWN_INCOMPLETE");
      }
    });
  } finally {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    if (!lifecycle.childCleanupFailed) await lifecycle.release();
    if (lifecycle.stopped) process.exitCode = lifecycle.signalName === "SIGINT" ? 130 : 143;
  }
}
