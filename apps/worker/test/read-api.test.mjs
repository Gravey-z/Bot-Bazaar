import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyFinalReceipt } from "@bot-bazaar/chain";
import { setupInferenceFixture as setup } from "./inference-fixture.mjs";
import { captured, proofFor } from "./chain-fixture.mjs";
import { dropActivity } from "./policy-fixture.mjs";
import { verifyBackup } from "../dist/private/storage/backup.js";
import {
  projectIntent,
  publicEntry,
} from "../dist/private/activity/projection.js";
import { ReadApiError } from "../dist/private/activity/repository.js";
import { createReadHandler } from "../dist/private/read-api/handler.js";
import { readHealth } from "../dist/private/read-api/health.js";

const explorer = "https://testnet.nearblocks.io";
const page = (f, after, limit = 50, now) =>
  f.store.activity.page(after, limit, explorer, now);
const hold = {
  action: { method: "hold" },
  reason: "Retain reserves and wait.",
};
const context = {
  backup: "verified",
  discovery: "ready",
  scheduling: "ready",
  aiMode: "disabled",
};
function decision(f, id) {
  f.store.saveDecision({
    id,
    jobId: f.turn.job_id,
    merchantId: "rex",
    provider: "near-ai",
    model: "fixture-model",
    promptVersion: "fixture-v1",
    ...hold,
  });
}
function altered(cursor, fields) {
  return Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(cursor, "base64url")),
      ...fields,
    }),
  ).toString("base64url");
}

test("inference, actual model selection and policy outcome append separate immutable entries", async (t) => {
  const f = await setup(t),
    before = page(f);
  let release;
  const running = f.runner.run(
    f.request,
    async () =>
      await new Promise((resolve) => {
        release = resolve;
      }),
  );
  // Dispatch persistence happens before invoking the provider.
  for (let i = 0; !release && i < 100; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release);
  const thinking = page(f, before.next_after);
  assert.deepEqual(
    thinking.entries.map((e) => [e.source, e.status]),
    [["system", "thinking"]],
  );
  release(hold);
  await running;
  f.store.policy.authorize(f.request.id);
  const after = page(f, thinking.next_after);
  assert.deepEqual(
    after.entries.map((e) => [e.source, e.status]),
    [
      ["model", "held"],
      ["policy", "held"],
    ],
  );
  assert.equal(after.entries[0].reason, hold.reason);
  assert.equal(after.entries[0].reason_kind, "model");
  assert.equal(after.entries[1].reason, null);
  assert.equal(thinking.entries[0].domain_key, after.entries[0].domain_key);
  assert.deepEqual(page(f, before.next_after).entries[0], thinking.entries[0]);
  assert.ok(after.entries.every((e) => e.live_ai_evidence === false));
});

test("invalid model output exposes a validation status without a fabricated model decision", async (t) => {
  const f = await setup(t),
    before = page(f);
  await assert.rejects(
    f.runner.run(f.request, async () => ({
      ...hold,
      secretKey: "PRIVATE_CANARY",
    })),
  );
  const events = page(f, before.next_after).entries;
  assert.equal(events.filter((e) => e.source === "model").length, 0);
  assert.ok(
    events.some(
      (e) => e.status === "rejected" && e.reason === "AI validation error",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_CANARY|secretKey|messages|payload/,
  );
});

test("pagination has ordered local sequences, stable IDs and bounded pages", async (t) => {
  const f = await setup(t),
    before = page(f);
  for (let i = 0; i < 55; i++) decision(f, `decision:${i}`);
  const first = page(f, before.next_after, 20),
    second = page(f, first.next_after, 50);
  assert.equal(first.entries.length, 20);
  assert.equal(first.has_more, true);
  assert.equal(second.entries.length, 35);
  assert.equal(second.has_more, false);
  const all = [...first.entries, ...second.entries];
  assert.equal(new Set(all.map((e) => e.id)).size, 55);
  assert.ok(
    all.every(
      (e, i) => i === 0 || BigInt(e.sequence) > BigInt(all[i - 1].sequence),
    ),
  );
  assert.ok(all.every((e) => Buffer.byteLength(JSON.stringify(e)) <= 4096));
  assert.ok(Buffer.byteLength(JSON.stringify(second)) <= 262144);
  assert.deepEqual(page(f, before.next_after, 20).entries, first.entries);
});

test("cursors reject malformed, noncanonical, overflow, ahead and wrong deployment values", async (t) => {
  const f = await setup(t),
    valid = page(f).next_after;
  const invalid = [
    "",
    "x".repeat(513),
    "*",
    "e30",
    valid + "=",
    altered(valid, { sequence: "01" }),
    altered(valid, { sequence: 1 }),
    altered(valid, { sequence: "9223372036854775808" }),
    altered(valid, { sequence: "99999" }),
    altered(valid, { extra: true }),
    Buffer.from(" " + Buffer.from(valid, "base64url").toString()).toString(
      "base64url",
    ),
  ];
  for (const cursor of invalid)
    assert.throws(
      () => page(f, cursor),
      (e) => e instanceof ReadApiError && e.status === 400,
    );
  assert.throws(() => page(f, altered(valid, { deployment: "0".repeat(64) })), {
    code: "cursor_deployment_mismatch",
  });
  assert.throws(() => page(f, altered(valid, { generation: randomUUID() })), {
    status: 409,
    code: "feed_generation_mismatch",
  });
  for (const limit of [0, -1, 51, 1.5, NaN])
    assert.throws(() => page(f, valid, limit), { code: "invalid_query" });
});

test("restart changes feed generation, preserves domain identity and explicitly reports a history gap", async (t) => {
  const f = await setup(t);
  decision(f, "restart:decision");
  const before = page(f);
  await f.reopen();
  assert.throws(() => page(f, before.next_after), { status: 409 });
  const after = page(f);
  assert.notEqual(after.feed_generation, before.feed_generation);
  assert.equal(after.history_gap, true);
  assert.deepEqual(after.entries, before.entries);
  assert.equal(page(f, after.next_after).history_gap, false);
});

test("retention preserves high water and reports gaps even when the retained window is empty", async (t) => {
  const f = await setup(t),
    before = page(f);
  decision(f, "prune:decision");
  const high = page(f).high_water_sequence;
  f.store.prune(Date.now() + 8 * 86400000);
  const empty = page(f, before.next_after);
  assert.equal(empty.history_gap, true);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.high_water_sequence, high);
  assert.equal(empty.pruned_through, high);
  assert.equal(page(f, empty.next_after).history_gap, false);
  decision(f, "after:prune");
  assert.equal(page(f, empty.next_after).entries[0].decision_id, "after:prune");
});

test("row retention bounds the feed without deleting domain deduplication tombstones", async (t) => {
  const f = await setup(t),
    db = f.store.db,
    sample = db
      .prepare("SELECT entry_json FROM activity_events LIMIT 1")
      .get().entry_json;
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare(
    "INSERT INTO activity_events(event_key,observed_at,entry_json) VALUES(?,?,?)",
  );
  for (let i = 0; i < 10005; i++)
    insert.run(`retention:${i}`, Date.now(), sample);
  db.exec("COMMIT");
  f.store.prune();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_events").get().count,
    10000,
  );
  assert.equal(page(f).history_gap, true);
  assert.ok(
    db.prepare("SELECT COUNT(*) AS count FROM activity_keys").get().count > 0,
  );
});

test("sequence cursors round trip integers above JavaScript's safe integer range", async (t) => {
  const f = await setup(t);
  f.store.db
    .prepare("UPDATE sqlite_sequence SET seq=? WHERE name='activity_events'")
    .run("9007199254740992");
  decision(f, "large:sequence");
  const first = page(f);
  assert.equal(first.entries.at(-1).sequence, "9007199254740993");
  decision(f, "large:next");
  assert.equal(
    page(f, first.next_after).entries[0].sequence,
    "9007199254740994",
  );
});

test("finalized trade observations deduplicate after pruning and omit player account identities", async (t) => {
  const f = await setup(t),
    before = page(f),
    state = structuredClone(f.state);
  state.trades = [structuredClone(captured.steps[1].result.data)];
  const commit = () =>
    f.store.commitDiscovery({
      previousHash: state.block.hash,
      state,
      signals: [],
    });
  commit();
  commit();
  const events = page(f, before.next_after).entries;
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "chain");
  assert.equal(events[0].status, "confirmed");
  assert.equal(events[0].trade.total_price, state.trades[0].total_price);
  assert.equal(events[0].trade.buyer, null);
  assert.equal(events[0].reason, null);
  assert.doesNotMatch(JSON.stringify(events), /account_id|player-bazaar/);
  f.store.prune(Date.now() + 8 * 86400000);
  commit();
  assert.deepEqual(page(f).entries, []);
});

test("the read projection drops private extras and stored explorer URLs", async (t) => {
  const f = await setup(t);
  decision(f, "redact:decision");
  const row = f.store.db
    .prepare(
      "SELECT sequence,entry_json FROM activity_events WHERE event_key='decision:redact:decision:selection'",
    )
    .get();
  const event = JSON.parse(row.entry_json);
  event.secretKey = "PRIVATE_CANARY";
  event.signed_json = "SIGNED_CANARY";
  event.selection.secret = "SELECTION_CANARY";
  event.transaction = {
    signed_hash: captured.seed.finalized_block.hash,
    receipt_hash: null,
    explorer_url: "https://private.invalid/PRIVATE_URL",
    evidence: "signed",
    evidence_incomplete: false,
    nonce: "NONCE_CANARY",
  };
  f.store.db
    .prepare("UPDATE activity_events SET entry_json=? WHERE sequence=?")
    .run(JSON.stringify(event), row.sequence);
  const result = page(f).entries.at(-1);
  assert.equal(result.transaction.explorer_url, null);
  assert.doesNotMatch(
    JSON.stringify(result),
    /CANARY|PRIVATE_URL|private.invalid/,
  );
});

test("a verified acceptance receipt supplies settled trade values; a missing receipt stays unknown", async () => {
  const step = captured.steps.find((s) => s.method === "accept_trade");
  const evidence = await verifyFinalReceipt(step.receipt, proofFor(step));
  assert.equal(evidence.kind, "succeeded");
  const row = {
    id: "accept:1",
    job_id: "root:1",
    merchant_id: "luna",
    decision_id: "decision:1",
    method: step.method,
    args_json: JSON.stringify(step.args),
    action_id: "1",
    offer_id: "1",
    status: "confirmed",
    updated_at: Date.now(),
  };
  const event = publicEntry(
    projectIntent(
      row,
      {
        tx_hash: step.transaction_hash,
        evidence_json: JSON.stringify(evidence),
      },
      "model",
    ),
  );
  assert.equal(event.source, "chain");
  assert.equal(event.trade.total_price, step.result.data.trade.total_price);
  assert.equal(event.trade.quantity, step.result.data.trade.quantity);
  assert.equal(event.trade.trade_id, step.result.data.trade.trade_id);
  assert.equal(event.reason, null);
  const unproven = projectIntent(
    row,
    { tx_hash: step.transaction_hash, evidence_json: null },
    "model",
  );
  assert.equal(unproven.status, "unknown");
  assert.equal(unproven.source, "system");
  assert.equal(unproven.trade, null);
});

test("v6 migration backs up the old database and marks missing historical activity explicitly", async (t) => {
  const f = await setup(t);
  decision(f, "legacy:decision");
  await f.store.close();
  const db = new DatabaseSync(join(f.dataDir, "worker.sqlite"));
  db.exec(dropActivity + "PRAGMA user_version=6;");
  db.close();
  await f.reopen();
  assert.equal(f.store.db.prepare("PRAGMA user_version").get().user_version, 7);
  assert.ok(f.store.getDecision("legacy:decision"));
  const migrated = page(f);
  assert.equal(migrated.history_gap, true);
  assert.deepEqual(migrated.entries, []);
  const folders = await readdir(join(f.dataDir, "backups"));
  assert.equal(
    (await verifyBackup(join(f.dataDir, "backups", folders[0]))).schema,
    6,
  );
});

test("a malformed historical projection advances the gap watermark for an existing client", async (t) => {
  const f = await setup(t),
    before = page(f);
  // Historical rows can predate the current schema validator. Never export them raw.
  f.store.db
    .prepare("INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      "legacy:bad",
      f.turn.job_id,
      "rex",
      "near-ai",
      "fixture-model",
      "v1",
      '{"method":"secret_method","privateKey":"PRIVATE_CANARY"}',
      "PRIVATE_REASON",
      Date.now(),
    );
  decision(f, "after:bad");
  const result = page(f, before.next_after);
  assert.equal(result.history_gap, true);
  assert.deepEqual(
    result.entries.map((e) => e.decision_id),
    ["after:bad"],
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_CANARY|PRIVATE_REASON|secret_method/,
  );
});

test("a failed activity append rolls back the private decision and its queue atomically", async (t) => {
  const f = await setup(t),
    before = page(f),
    db = f.store.db,
    prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes("INSERT INTO activity_events"))
      throw new Error("disk failure PRIVATE_CANARY");
    return prepare(sql);
  };
  try {
    assert.throws(() => decision(f, "rollback:decision"), /write rejected/);
  } finally {
    db.prepare = prepare;
  }
  assert.equal(f.store.getDecision("rollback:decision"), undefined);
  assert.deepEqual(page(f).entries, before.entries);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM activity_queue").get().count,
    0,
  );
});

test("health and activity reads perform no writes, calls or scheduling and expose independent staleness", async (t) => {
  const f = await setup(t),
    calls = f.chain.calls.length,
    db = f.store.db,
    prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    assert.match(sql.trim(), /^SELECT\b/i);
    return prepare(sql);
  };
  try {
    const recent = readHealth(f.store, context, f.now),
      stale = readHealth(f.store, context, f.now + 16000);
    assert.equal(recent.status, "not_ready");
    assert.equal(recent.database, "ready");
    assert.equal(recent.chain.stale, false);
    assert.equal(stale.chain.stale, true);
    assert.equal(recent.deployment.identity_kind, "configured");
    assert.equal(recent.ai.liveAiEvidence, false);
    for (let i = 0; i < 5; i++) page(f);
  } finally {
    db.prepare = prepare;
  }
  assert.equal(f.chain.calls.length, calls);
});

test("HTTP routes validate input, bound output, signal resets and sanitize internal failures", async (t) => {
  const f = await setup(t);
  let activityCalls = 0,
    fail = false,
    huge = false;
  const server = createServer(
    createReadHandler({
      health: () => readHealth(f.store, context),
      activity: (after, limit) => {
        activityCalls++;
        if (fail) throw new Error("PRIVATE_CANARY");
        if (huge) return { private: "x".repeat(262144) };
        return page(f, after, limit);
      },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    "/activity?limit=0",
    "/activity?limit=51",
    "/activity?limit=01",
    "/activity?limit=1&limit=2",
    "/activity?after=a&after=b",
    "/activity?secret=PRIVATE_CANARY",
    "/health?x=1",
  ]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /PRIVATE_CANARY/);
  }
  assert.equal(activityCalls, 0);
  assert.equal(
    (await fetch(url + "/activity", { method: "POST", body: "PRIVATE_CANARY" }))
      .status,
    405,
  );
  assert.equal(activityCalls, 0);
  assert.equal((await fetch(url + "/unknown")).status, 404);
  const response = await fetch(url + "/activity");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const cursor = (await response.json()).next_after;
  const reset = await fetch(
    url + "/activity?after=" + altered(cursor, { generation: randomUUID() }),
  );
  assert.equal(reset.status, 409);
  assert.equal((await reset.json()).reset_required, true);
  const head = await fetch(url + "/health", { method: "HEAD" });
  assert.equal(head.status, 503);
  assert.equal(await head.text(), "");
  fail = true;
  const failed = await fetch(url + "/activity");
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "read_unavailable" });
  fail = false;
  huge = true;
  assert.equal((await fetch(url + "/activity")).status, 503);
});
