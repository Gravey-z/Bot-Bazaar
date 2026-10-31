import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  rm,
  copyFile,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkerStore } from "../dist/private/storage/database.js";
import { verifyBackup, retainBackups } from "../dist/private/storage/backup.js";
import { captured, fixture } from "./chain-fixture.mjs";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "bazaar-store-test-"));
  const data = join(root, "data"),
    backups = join(root, "backups");
  await mkdir(data);
  await mkdir(backups);
  const chain = fixture();
  const options = {
    dataDir: data,
    identity: chain.identity,
    policyVersion: "v1",
    create: true,
  };
  let store = new WorkerStore(options);
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    backups,
    chain,
    options,
    get store() {
      return store;
    },
    async reopen() {
      await store.close();
      store = new WorkerStore({ ...options, create: false });
      return store;
    },
  };
}
function active(store, id = "job", now = Date.now()) {
  store.enqueue(
    {
      id,
      triggerKey: `trigger:${id}`,
      triggerRef: "trade:1",
      deadline: now + 120000,
    },
    now,
  );
  store.activateJob(id, now);
  for (const merchant of ["rex", "luna", "bolt"])
    store.recordMerchantCheckpoint(merchant, "0", null, true);
}
const intent = () => ({
  id: "intent",
  jobId: "job",
  merchantId: "rex",
  method: "propose_trade",
  args: structuredClone(captured.steps[2].args),
});
async function signed(f) {
  active(f.store);
  f.store.claimLocks("job", ["rex"], "controller");
  await f.store.prepareIntent(intent());
  const prepared = await f.chain.adapter.prepareProposal(
    "rex",
    captured.steps[2].args,
  );
  f.store.saveSigned("intent", prepared);
  return prepared;
}

test("creates verified durable SQLite schema, excludes another owner and reopens losslessly", async (t) => {
  const f = await setup(t);
  assert.equal(f.store.checkpoint().recovery_required, 1);
  const generation = f.store.checkpoint().feed_generation;
  f.store.observe(
    "9007199254740993",
    "18446744073709551615",
    captured.seed.finalized_block.hash,
  );
  f.store.recordMerchantCheckpoint(
    "rex",
    "18446744073709551615",
    "a".repeat(64),
    true,
  );
  assert.throws(() => new WorkerStore(f.options), /ownership/);
  await f.reopen();
  assert.equal(f.store.checkpoint().observed_revision, "9007199254740993");
  assert.equal(
    f.store.merchantCheckpoint("rex").last_action_id,
    "18446744073709551615",
  );
  assert.notEqual(f.store.checkpoint().feed_generation, generation);
  assert.throws(() =>
    f.store.observe("01", "1", captured.seed.finalized_block.hash),
  );
  assert.throws(
    () => f.store.observe("1", "2", captured.seed.finalized_block.hash),
    /regression/,
  );
  await f.store.close();
  const db = new DatabaseSync(join(f.data, "worker.sqlite"));
  try {
    for (const [pragma, value] of [
      ["user_version", 2],
      ["journal_mode", "wal"],
      ["auto_vacuum", 2],
    ])
      assert.equal(
        Object.values(db.prepare(`PRAGMA ${pragma}`).get())[0],
        value,
      );
  } finally {
    db.close();
  }
});

test("missing, wrong-deployment, incompatible-policy and future-schema databases fail closed", async (t) => {
  const f = await setup(t);
  assert.throws(
    () => new WorkerStore({ ...f.options, dataDir: f.backups, create: false }),
    /initialization/,
  );
  await f.store.close();
  assert.throws(
    () =>
      new WorkerStore({
        ...f.options,
        identity: {
          ...f.options.identity,
          codeHash: "11111111111111111111111111111111",
        },
      }),
    /identity/,
  );
  assert.throws(
    () => new WorkerStore({ ...f.options, policyVersion: "v2" }),
    /policy/,
  );
  const db = new DatabaseSync(join(f.data, "worker.sqlite"));
  db.exec("PRAGMA user_version=999");
  db.close();
  assert.throws(() => new WorkerStore(f.options), /schema/);
});

test("queue is bounded and deduplicated with one active job", async (t) => {
  const f = await setup(t),
    now = Date.now();
  for (let i = 0; i < 100; i++)
    assert.equal(
      f.store.enqueue(
        {
          id: `job${i}`,
          triggerKey: `trade:${i}`,
          triggerRef: `trade:${i}`,
          deadline: now + 120000,
        },
        now,
      ),
      true,
    );
  assert.equal(
    f.store.enqueue(
      {
        id: "duplicate",
        triggerKey: "trade:0",
        triggerRef: "trade:0",
        deadline: now + 120000,
      },
      now,
    ),
    false,
  );
  assert.throws(() =>
    f.store.enqueue(
      {
        id: "overflow",
        triggerKey: "trade:100",
        triggerRef: "trade:100",
        deadline: now + 120000,
      },
      now,
    ),
  );
  f.store.activateJob("job0");
  assert.throws(() => f.store.activateJob("job1"));
  assert.equal(f.store.getJob("job1").status, "queued");
  assert.throws(() => f.store.activateJob("job1", now + 120001));
});

test("multi-merchant lock acquisition rolls back every slot on rejection", async (t) => {
  const f = await setup(t);
  active(f.store);
  assert.throws(() => f.store.claimLocks("job", ["bolt", "zzz"], "commitment"));
  assert.deepEqual(f.store.locks(), []);
  f.store.claimLocks("job", ["luna", "rex"], "commitment");
  assert.deepEqual(
    f.store.locks().map((row) => row.merchant_id),
    ["luna", "rex"],
  );
  assert.throws(() => f.store.completeJob("job", "completed"), /protected/);
  await f.reopen();
  assert.equal(f.store.locks().length, 2);
});

test("decisions whitelist persisted fields, redact known credentials and reject oversized/untrusted shapes", async (t) => {
  const f = await setup(t);
  active(f.store);
  const decision = {
    id: "decision",
    jobId: "job",
    merchantId: "rex",
    provider: "near-ai",
    model: "model-v1",
    promptVersion: "v1",
    action: { method: "hold" },
    reason: "wait\nBearer top-secret sk-test-only",
  };
  f.store.saveDecision(decision);
  assert.equal(
    f.store.getDecision("decision").reason,
    "wait [redacted] [redacted]",
  );
  assert.equal(f.store.getDecision("decision").provider, "near-ai");
  assert.throws(() =>
    f.store.saveDecision({
      ...decision,
      id: "bad",
      action: { method: "hold", apiKey: "secret" },
    }),
  );
  assert.throws(() =>
    f.store.saveDecision({
      ...decision,
      id: "huge",
      reason: "x".repeat(65537),
    }),
  );
  assert.throws(() =>
    f.store.saveDecision({ ...decision, id: "late" }, Date.now() + 200000),
  );
});

test("durable signed/unknown attempts retain controller locks across restart and cannot be rewritten", async (t) => {
  const f = await setup(t),
    prepared = await signed(f);
  f.store.markBroadcast("intent", "unknown");
  assert.throws(() => f.store.abandonUnsigned("intent"));
  assert.throws(() => f.store.releaseLocks("job", "controller"));
  assert.throws(() => f.store.completeJob("job", "failed"));
  await f.reopen();
  const restored = JSON.parse(f.store.attempt("intent").signed_json);
  assert.equal(
    restored.signedTransactionBase64,
    prepared.signedTransactionBase64,
  );
  assert.equal(f.store.unresolvedIntents()[0].status, "unknown");
  assert.equal(f.store.locks().length, 1);
  await assert.rejects(
    f.store.prepareIntent({ ...intent(), id: "replacement" }),
  );
  assert.throws(() => f.store.saveSigned("intent", prepared));
  assert.throws(() =>
    f.store.finishAttempt("intent", {
      kind: "unknown",
      transactionHash: prepared.transactionHash,
    }),
  );
});

test("failed attempts preserve evidence and allow a new intent with the unconsumed action ID", async (t) => {
  const f = await setup(t),
    prepared = await signed(f);
  f.store.finishAttempt("intent", {
    kind: "failed",
    transactionHash: prepared.transactionHash,
    code: "EXECUTION_FAILED",
  });
  await f.store.prepareIntent({ ...intent(), id: "corrected" });
  assert.equal(f.store.getIntent("intent").status, "failed");
  assert.equal(f.store.getIntent("corrected").action_id, "1");
  assert.ok(f.store.attempt("intent").evidence_json);
  assert.equal(f.store.merchantCheckpoint("rex").last_action_id, "0");
});

test("confirmed action checkpoints and offer identity are retained after evidence pruning", async (t) => {
  const f = await setup(t),
    prepared = await signed(f);
  f.store.finishAttempt("intent", {
    kind: "succeeded",
    transactionHash: prepared.transactionHash,
    result: captured.steps[2].result,
  });
  assert.equal(f.store.merchantCheckpoint("rex").last_action_id, "1");
  assert.equal(f.store.getIntent("intent").offer_id, "1");
  f.store.claimLocks("job", ["rex", "luna"], "commitment");
  assert.throws(() => f.store.releaseLocks("job", "commitment"), /offer/);
  f.store.putOffer({
    id: "1",
    jobId: "job",
    status: "cancelled",
    expiresAtNs: captured.steps[2].args.expires_at_ns,
    cleanupAck: true,
  });
  f.store.releaseLocks("job", "commitment");
  f.store.releaseLocks("job", "controller");
  f.store.completeJob("job", "completed");
  f.store.prune(Date.now() + 31 * 86400000);
  assert.equal(f.store.getIntent("intent"), undefined);
  assert.ok(f.store.merchantCheckpoint("rex").latest_success);
  assert.equal(f.store.getJob("job").trigger_key, "trigger:job");
  assert.equal(
    f.store.enqueue({
      id: "replay",
      triggerKey: "trigger:job",
      triggerRef: "trade:1",
      deadline: Date.now() + 120000,
    }),
    false,
  );
});

test("cleanup calls reserve a controller even without an application action ID", async (t) => {
  const f = await setup(t);
  active(f.store);
  f.store.claimLocks("job", ["bolt"], "controller");
  await f.store.prepareIntent({
    id: "cleanup",
    jobId: "job",
    merchantId: "bolt",
    method: "expire_offers",
    args: { offer_ids: ["1"] },
  });
  assert.equal(f.store.getIntent("cleanup").action_id, null);
  await assert.rejects(
    f.store.prepareIntent({
      id: "another",
      jobId: "job",
      merchantId: "bolt",
      method: "expire_offers",
      args: { offer_ids: ["2"] },
    }),
  );
  f.store.abandonUnsigned("cleanup");
  f.store.releaseLocks("job", "controller");
});

test("offer cache preserves unsigned ordering, capacity and unresolved cleanup obligations", async (t) => {
  const f = await setup(t);
  active(f.store);
  f.store.claimLocks("job", ["rex", "luna"], "commitment");
  f.store.putOffer({
    id: "18446744073709551615",
    jobId: "job",
    status: "expired",
    expiresAtNs: "1",
    cleanupAck: false,
  });
  for (let i = 1; i <= 111; i++)
    f.store.putOffer({
      id: String(i),
      status: "accepted",
      expiresAtNs: "1",
      cleanupAck: true,
    });
  assert.equal(f.store.offers().at(-1).offer_id, "18446744073709551615");
  assert.throws(() =>
    f.store.putOffer({
      id: "112",
      status: "pending",
      expiresAtNs: "1",
      cleanupAck: false,
    }),
  );
  assert.throws(() => f.store.releaseLocks("job", "commitment"));
  assert.throws(() => f.store.forgetTerminalOffer("18446744073709551615"));
  f.store.forgetTerminalOffer("1");
  f.store.putOffer({
    id: "112",
    status: "pending",
    expiresAtNs: "1",
    cleanupAck: false,
  });
});

test("retention never prunes unresolved signed work even far beyond the age cutoff", async (t) => {
  const f = await setup(t);
  await signed(f);
  f.store.markBroadcast("intent", "unknown");
  f.store.prune(Date.now() + 100 * 86400000);
  assert.equal(f.store.getIntent("intent").status, "unknown");
  assert.ok(f.store.attempt("intent").signed_json);
});

test("online backup restores unknown work, rejects corruption and serializes snapshots", async (t) => {
  const f = await setup(t),
    prepared = await signed(f);
  f.store.markBroadcast("intent", "unknown");
  const task = f.store.backup(f.backups);
  assert.throws(() => f.store.backup(f.backups), /already running/);
  const bundle = await task,
    manifest = await verifyBackup(bundle);
  assert.equal(manifest.identity.contractId, f.options.identity.contractId);
  await retainBackups(f.backups);
  const restored = join(f.root, "restored");
  await mkdir(restored);
  await copyFile(
    join(bundle, "worker.sqlite"),
    join(restored, "worker.sqlite"),
  );
  const store = new WorkerStore({
    ...f.options,
    dataDir: restored,
    create: false,
  });
  try {
    assert.equal(store.checkpoint().recovery_required, 1);
    assert.equal(
      store.unresolvedIntents()[0].tx_hash,
      prepared.transactionHash,
    );
    assert.equal(store.locks().length, 1);
  } finally {
    await store.close();
  }
  await writeFile(join(bundle, "worker.sqlite"), "corrupt");
  await assert.rejects(verifyBackup(bundle));
  const second = await f.store.backup(f.backups);
  await rm(join(second, "manifest.json"));
  await assert.rejects(verifyBackup(second));
});

test("SQLite OS ownership excludes a second process and releases after forced termination", async (t) => {
  const f = await setup(t);
  await f.store.close();
  const moduleUrl = new URL(
    "../dist/private/storage/database.js",
    import.meta.url,
  ).href;
  const script = `import {WorkerStore} from ${JSON.stringify(moduleUrl)}; const store=new WorkerStore(${JSON.stringify({ ...f.options, create: false })});store.enqueue({id:'crash-job',triggerKey:'trade:crash',triggerRef:'trade:1',deadline:Date.now()+120000});console.log('owned');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  try {
    await once(child.stdout, "data");
    const other = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {WorkerStore} from ${JSON.stringify(moduleUrl)};new WorkerStore(${JSON.stringify(f.options)});`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(other.status, 1);
    assert.match(other.stderr, /ownership/);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  await f.reopen();
  assert.equal(f.store.getJob("crash-job").status, "queued");
});

test("durable-write failure rolls back and reports no raw payload", async (t) => {
  const f = await setup(t);
  active(f.store);
  f.store.claimLocks("job", ["rex"], "controller");
  await f.store.prepareIntent(intent());
  await assert.rejects(
    f.store.prepareIntent({ ...intent(), id: "collision" }),
    (error) => {
      assert.doesNotMatch(error.message, /INSERT|propose_trade|total_price/);
      return true;
    },
  );
  assert.equal(f.store.getIntent("collision"), undefined);
  assert.equal(f.store.getIntent("intent").status, "prepared");
});

test("SQLITE_FULL rolls back the failing record and fences subsequent writes", async (t) => {
  const f = await setup(t);
  active(f.store);
  // Fault injection through the test-only JS handle; production exposes no SQL API.
  const pages = f.store.db.prepare("PRAGMA page_count").get().page_count;
  f.store.db.exec(`PRAGMA max_page_count=${pages}`);
  let rejected;
  for (let i = 0; i < 100; i++) {
    try {
      f.store.saveDecision({
        id: `decision${i}`,
        jobId: "job",
        merchantId: "rex",
        provider: "near-ai",
        model: "model",
        promptVersion: "v1",
        action: { method: "hold" },
        reason: "x".repeat(4000),
      });
    } catch {
      rejected = `decision${i}`;
      break;
    }
  }
  assert.ok(rejected, "injected page limit must reject a write");
  assert.equal(f.store.getDecision(rejected), undefined);
  assert.throws(
    () => f.store.observe("1", "1", captured.seed.finalized_block.hash),
    /unavailable/,
  );
});

test("backup retention keeps recent and daily verified bundles without deleting incomplete work", async (t) => {
  const f = await setup(t),
    original = await f.store.backup(f.backups);
  const manifest = JSON.parse(
    await readFile(join(original, "manifest.json"), "utf8"),
  );
  const base = Date.UTC(2026, 9, 31, 12);
  manifest.capturedAt = base;
  await writeFile(join(original, "manifest.json"), JSON.stringify(manifest));
  for (let i = 1; i <= 33; i++) {
    const directory = join(f.backups, `backup-${randomUUID()}`);
    await mkdir(directory);
    await copyFile(
      join(original, "worker.sqlite"),
      join(directory, "worker.sqlite"),
    );
    const capturedAt = i <= 25 ? base - i * 60000 : base - (i - 25) * 86400000;
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, capturedAt }),
    );
  }
  const incomplete = join(f.backups, `incomplete-${randomUUID()}`);
  await mkdir(incomplete);
  await writeFile(join(incomplete, "unfinished"), "preserve");
  await retainBackups(f.backups);
  const retained = (await readdir(f.backups)).filter((name) =>
    name.startsWith("backup-"),
  );
  assert.ok(retained.length >= 24 && retained.length <= 31);
  await verifyBackup(original);
  assert.equal(
    await readFile(join(incomplete, "unfinished"), "utf8"),
    "preserve",
  );
});
