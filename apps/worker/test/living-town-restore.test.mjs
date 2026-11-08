import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { backup } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  executionFixture,
  closeFixturesAt,
  identity,
} from "./fixtures/living-town-execution.mjs";
import { providerFixture, prepared } from "./fixtures/living-town-provider.mjs";
import { readReceiptInbox } from "../dist/private/living-town/config.js";

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "bazaar-p72-"));
  t.after(() => {
    for (const name of ["current", "restored"])
      closeFixturesAt(join(root, name));
    assert(root.startsWith(join(tmpdir(), "bazaar-p72-")));
    rmSync(root, { recursive: true, force: true });
  });
  const current = join(root, "current");
  mkdirSync(current);
  return { root, current };
}
test("a missing configured receipt-inbox artifact is an error, not a silently empty history", (t) => {
  const { current } = directory(t),
    artifact = join(current, "receipt-inbox.json");
  writeFileSync(
    artifact,
    JSON.stringify({ schema: "living-town-receipt-inbox-v1", requests: [] }),
  );
  assert.deepEqual(readReceiptInbox(artifact, identity), []);
  unlinkSync(artifact);
  assert.throws(
    () => readReceiptInbox(artifact, identity),
    (error) => error.code === "ENOENT",
  );
});
for (const point of ["after_submission", "after_confirmation"])
  test(`forced process death ${point} recovers the original intent/hash with no replacement send`, async (t) => {
    const { current } = directory(t);
    const script = `import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {executionFixture} from './apps/worker/test/fixtures/living-town-execution.mjs';process.on('exit',()=>writeFileSync(join(process.argv[1],'graceful-exit.json'),'true'));const f=await executionFixture(process.argv[1],{crashAt:process.argv[2]});await f.processor.recover();await f.processor.executeCustomer(f.input());await f.processor.recover();process.exit(99);`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, current, point],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0, child.stderr);
    assert.notEqual(child.status, 99, child.stderr);
    const marker = JSON.parse(
      readFileSync(join(current, "crash-marker.json"), "utf8"),
    );
    assert.equal(marker.point, point);
    assert.equal(marker.counts.sign, 1);
    assert.equal(marker.counts.send, 1);
    assert.equal(existsSync(join(current, "graceful-exit.json")), false);
    const f = await executionFixture(current),
      row = f.store.unresolved()[0];
    assert.equal(row.status, "submitted");
    const hash = row.tx_hash,
      signed = row.signed_json;
    assert.equal((await f.processor.recover()).kind, "ready");
    const resolved = f.store.get(row.id);
    assert.equal(resolved.status, "confirmed");
    assert.equal(resolved.tx_hash, hash);
    assert.equal(resolved.signed_json, signed);
    assert.equal(
      (await f.processor.executeCustomer(f.input())).kind,
      "duplicate",
    );
    assert.equal(f.counts.sign, 0);
    assert.equal(f.counts.send, 0);
  });

test("real SQLITE_FULL rolls back admission and fences signing without filling the host disk", async (t) => {
  const { current } = directory(t),
    f = await executionFixture(current);
  await f.processor.recover();
  const db = f.store.db;
  db.exec(
    "CREATE TABLE p72_fill(body BLOB); CREATE TRIGGER p72_exhaust BEFORE INSERT ON jobs BEGIN INSERT INTO p72_fill VALUES(zeroblob(1048576)); END;",
  );
  const pages = db.prepare("PRAGMA page_count").get().page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
  await assert.rejects(f.processor.executeCustomer(f.input()), /full/i);
  assert.equal(f.counts.sign, 0);
  assert.equal(f.counts.send, 0);
  assert.equal(f.store.unresolved().length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM p72_fill").get().n, 0);
  assert.throws(() => f.store.gate(), /recovery/);
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /recovery|continuity/,
  );
});

test("SQLITE_FULL after confirmation retains submitted bytes and recovers without rebroadcast", async (t) => {
  const { current } = directory(t),
    f = await executionFixture(current);
  await f.processor.recover();
  const action = await f.processor.executeCustomer(f.input()),
    original = f.store.get(action.actionId),
    db = f.store.db;
  db.exec(
    "CREATE TABLE p72_fill(body BLOB); CREATE TRIGGER p72_exhaust BEFORE UPDATE OF evidence_json ON attempts BEGIN INSERT INTO p72_fill VALUES(zeroblob(1048576)); END;",
  );
  const pages = db.prepare("PRAGMA page_count").get().page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
  await assert.rejects(f.processor.recover(), /full/i);
  assert.equal(f.store.get(action.actionId).status, "submitted");
  assert.equal(f.store.get(action.actionId).signed_json, original.signed_json);
  assert.equal(f.store.checkpoint("operator").last_action_id, "0");
  assert.throws(() => f.store.gate(), /recovery/);
  db.exec("PRAGMA max_page_count=2147483646; DROP TRIGGER p72_exhaust;");
  f.save();
  f.close();
  const reopened = await executionFixture(current);
  assert.equal((await reopened.processor.recover()).kind, "ready");
  assert.equal(reopened.store.get(action.actionId).tx_hash, original.tx_hash);
  assert.equal(reopened.counts.sign, 0);
  assert.equal(reopened.counts.send, 0);
});

test("an acknowledged shared usage-history gap blocks new inference and cannot age out early", async (t) => {
  const f = await providerFixture(t);
  await f.runner.propose(f.context);
  assert.equal(f.stats.invoke, 1);
  const charged = f.budget.status().dailyMicro;
  f.budget.missingHistory(Date.now(), "controlled:p72-history-gap");
  assert.throws(
    () =>
      f.budget.reconcile({
        ...f.budget.context(),
        fencing: "verified",
        history: "aged_out",
        evidenceRef: "controlled:premature-reopen",
      }),
    /protected/,
  );
  assert.throws(
    () =>
      f.budget.reserve(
        "controlled:p72-new-request",
        prepared(f.context),
        Date.now(),
      ),
    /reconciliation/,
  );
  assert.equal(f.stats.invoke, 1);
  assert.equal(f.budget.status().dailyMicro, charged);
  assert.equal(f.budget.history().entries.length, 1);
});

test("old SQLite snapshot missing an executed intent cannot silently rebaseline the chain high-water", async (t) => {
  const { root, current } = directory(t),
    f = await executionFixture(current);
  await f.processor.recover();
  const snapshot = join(root, "old.sqlite");
  await backup(f.store.db, snapshot);
  const action = await f.processor.executeCustomer(f.input());
  f.save();
  const original = f.store.get(action.actionId);
  assert.equal(original.status, "submitted");
  const restored = join(root, "restored");
  mkdirSync(restored);
  copyFileSync(snapshot, join(restored, "worker.sqlite"));
  copyFileSync(
    join(current, "controlled-chain.json"),
    join(restored, "controlled-chain.json"),
  );
  // A copied journal can open while the original process owns a different path;
  // the host's fence must therefore be independently established, not inferred.
  const copy = await executionFixture(restored, {
    continuityVerifier: async (context) => ({
      ...context,
      journal: "current",
      fencing: "unverified",
      providerHistory: "accounted",
      evidenceRef: "controlled:no-fence",
    }),
  });
  assert.equal((await copy.processor.recover()).kind, "blocked");
  assert.equal(copy.counts.sign, 0);
  assert.equal(copy.counts.send, 0);
  copy.close();
  // Even a controlled attestation cannot explain a lost interval when the chain advanced.
  const checked = await executionFixture(restored);
  await assert.rejects(checked.processor.recover(), /high-water/);
  await assert.rejects(
    checked.processor.executeCustomer(checked.input()),
    /continuity|recovery/,
  );
  assert.equal(checked.counts.sign, 0);
  assert.equal(checked.counts.send, 0);
  assert.equal(f.store.get(action.actionId).tx_hash, original.tx_hash);
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.get(action.actionId).status, "confirmed");
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});

test("a missing receipt and pruned checkpoint preserve unknown bytes until original evidence returns", async (t) => {
  const { current } = directory(t),
    f = await executionFixture(current);
  await f.processor.recover();
  const action = await f.processor.executeCustomer(f.input());
  const original = f.store.get(action.actionId),
    effect = f.state.effect,
    sequence = f.state.sequence;
  f.state.receipts = false;
  f.state.effect = null;
  f.state.sequence = "9";
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.equal(f.store.get(action.actionId).signed_json, original.signed_json);
  assert.throws(() => f.store.abandon(action.actionId), /broadcast/);
  await assert.rejects(
    f.processor.executeCustomer(f.input()),
    /recovery|continuity/,
  );
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
  f.state.receipts = true;
  f.state.effect = effect;
  f.state.sequence = sequence;
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.get(action.actionId).tx_hash, original.tx_hash);
  assert.equal(f.counts.sign, 1);
  assert.equal(f.counts.send, 1);
});
