import assert from "node:assert/strict";
import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DefinitiveProviderFailure } from "../dist/private/retries/provider.js";
import { promptVersion } from "../dist/private/prompts/merchant-prompt.js";
import { recordInferenceInput } from "../dist/private/inference/input.js";
import { verifyBackup } from "../dist/private/storage/backup.js";
import { dropInference } from "./policy-fixture.mjs";
import { setupInferenceFixture as setup } from "./inference-fixture.mjs";

const hold = () => ({
  action: { method: "hold" },
  reason: "Retain reserves and wait.",
});

const buy = (f) => ({
  action: {
    method: "propose_trade",
    args: {
      proposer: "rex",
      buyer: "rex",
      seller: "luna",
      resource: "crystal",
      quantity: "4",
      total_price: "24",
      expires_at_ns: String(BigInt(f.now + 120000) * 1000000n),
      action_id: "1",
    },
  },
  reason: "Restore crystal stock while retaining gold.",
});

test("an inference record commits before dispatch and stores actual identity, sanitized input, response and timestamps", async (t) => {
  const f = await setup(t);
  let calls = 0;
  await f.runner.run(f.request, async (context) => {
    calls++;
    const during = f.store.records.get(f.request.id).record;
    assert.equal(during.outcome, "pending");
    assert.ok(during.dispatched_at >= during.prepared_at);
    assert.equal(during.returned_action_json, null);
    assert.equal(context.payload, f.payload);
    context.reportIdentity({ provider: "near-ai", model: "fixture-model" });
    return hold();
  });
  const { record, links } = f.store.records.get(f.request.id);
  assert.equal(calls, 1);
  assert.equal(record.provider, "near-ai");
  assert.equal(record.model, "fixture-model");
  assert.equal(record.actual_model, "fixture-model");
  assert.equal(record.prompt_version, promptVersion);
  assert.equal(record.input_status, "recorded");
  assert.equal(JSON.parse(record.input_json).own.gold, "228");
  assert.equal(
    record.payload_sha256,
    createHash("sha256").update(f.payload).digest("hex"),
  );
  assert.deepEqual(JSON.parse(record.returned_action_json), { method: "hold" });
  assert.equal(record.reason, hold().reason);
  assert.equal(record.schema_outcome, "valid");
  assert.equal(record.policy_outcome, "not_evaluated");
  assert.equal(record.outcome, "schema_valid");
  assert.ok(record.responded_at >= record.dispatched_at);
  assert.ok(record.finished_at >= record.responded_at);
  assert.deepEqual(links, []);
});
test("recording projects public market fields and omits prompts, credentials, provider options and reasoning traces", async (t) => {
  const f = await setup(t),
    body = JSON.parse(f.payload),
    market = JSON.parse(body.messages[1].content);
  market.privateKey = "INPUT_SECRET_CANARY";
  market.own.privateKey = "INPUT_SECRET_CANARY";
  market.own.inventory.apiKey = "INPUT_SECRET_CANARY";
  market.offers = [];
  body.messages[0].content = "SYSTEM_SECRET_CANARY";
  body.messages[1].content = JSON.stringify(market);
  body.authorization = "HEADER_SECRET_CANARY";
  f.setPayload(JSON.stringify(body));
  await f.runner.run(f.request, async () => ({
    ...hold(),
    reason: "wait\nBearer credential sk-only-for-tests",
  }));
  const saved = JSON.stringify(f.store.records.get(f.request.id));
  assert.doesNotMatch(
    saved,
    /INPUT_SECRET_CANARY|SYSTEM_SECRET_CANARY|HEADER_SECRET_CANARY/,
  );
  assert.match(saved, /\[redacted\]/);
  const other = recordInferenceInput(
    JSON.stringify({
      messages: [{ role: "user", content: "unstructured private text" }],
    }),
  );
  assert.equal(other.status, "unavailable");
  assert.equal(other.inputJson, null);
});
test("schema-invalid output records validation failure and safe returned action without logging raw extras", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.runner.run(f.request, async () => ({
      ...hold(),
      chain_of_thought: "REASONING_SECRET_CANARY",
      apiKey: "OUTPUT_SECRET_CANARY",
    })),
  );
  const { record } = f.store.records.get(f.request.id);
  assert.equal(record.outcome, "schema_invalid");
  assert.equal(record.schema_outcome, "invalid");
  assert.equal(record.outcome_code, "invalid_decision");
  assert.deepEqual(JSON.parse(record.returned_action_json), { method: "hold" });
  assert.equal(record.reason, hold().reason);
  assert.doesNotMatch(
    JSON.stringify(record),
    /REASONING_SECRET_CANARY|OUTPUT_SECRET_CANARY/,
  );
  assert.equal(f.store.getDecision(f.request.id), undefined);
});
test("unusable output never invents an action or a model reason", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.runner.run(f.request, async () => ({
      action: { method: "send_private_key", key: "OUTPUT_SECRET_CANARY" },
      reason: "x".repeat(1000),
    })),
  );
  const record = f.store.records.get(f.request.id).record;
  assert.equal(record.returned_action_json, null);
  assert.equal(record.reason, null);
  assert.equal(record.schema_outcome, "invalid");
  assert.doesNotMatch(
    JSON.stringify(record),
    /OUTPUT_SECRET_CANARY|send_private_key/,
  );
});
test("schema success and rejected policy are distinct and a rejected decision never silently becomes approved", async (t) => {
  const f = await setup(t),
    state = f.store.discoveryState();
  state.market.data.merchants[0].inventory.crystal = "5";
  f.store.commitDiscovery({
    previousHash: state.block.hash,
    state,
    signals: [],
  });
  await f.runner.run(f.request, async () => buy(f));
  assert.throws(
    () => f.store.policy.authorize(f.request.id),
    /purchase_trigger/,
  );
  let record = f.store.records.get(f.request.id).record;
  assert.equal(record.schema_outcome, "valid");
  assert.equal(record.policy_outcome, "rejected");
  assert.equal(record.policy_code, "purchase_trigger_unmet");
  assert.ok(record.policy_at >= record.responded_at);
  assert.equal(f.store.records.get(f.request.id).links.length, 0);
  state.market.data.merchants[0].inventory.crystal = "3";
  f.store.commitDiscovery({
    previousHash: state.block.hash,
    state,
    signals: [],
  });
  assert.throws(
    () => f.store.policy.authorize(f.request.id),
    /already rejected/,
  );
  record = f.store.records.get(f.request.id).record;
  assert.equal(record.policy_outcome, "rejected");
});
test("approved decisions link real action IDs, signed transaction identities and prerequisite purpose without signed bytes", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => buy(f));
  f.store.policy.authorize(f.request.id);
  const step = f.store.policy.next(f.request.id);
  await f.store.prepareIntent(step);
  let saved = f.store.records.get(f.request.id);
  assert.equal(saved.record.policy_outcome, "approved");
  assert.equal(saved.links[0].action_id, "1");
  assert.equal(saved.links[0].purpose, "prerequisite");
  assert.equal(saved.links[0].transaction_hash, null);
  const signed = await f.chain.adapter.prepare(
    step.merchantId,
    step.method,
    step.args,
  );
  f.store.saveSigned(step.id, signed);
  saved = f.store.records.get(f.request.id);
  assert.equal(saved.links[0].transaction_hash, signed.transactionHash);
  assert.equal(saved.links[0].nonce, signed.nonce);
  assert.equal(saved.links[0].status, "signed");
  assert.doesNotMatch(
    JSON.stringify(saved),
    /signedTransactionBase64|signed_json|secretKey/,
  );
});
test("offchain decisions retain actual brief reasons without creating transaction links", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => hold());
  f.store.policy.authorize(f.request.id);
  const saved = f.store.records.get(f.request.id);
  assert.equal(saved.record.policy_outcome, "offchain");
  assert.equal(saved.record.reason, hold().reason);
  assert.deepEqual(saved.links, []);
});
test("an inference-record commit failure rolls back attempt admission and prevents every provider call", async (t) => {
  const f = await setup(t);
  let calls = 0;
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    if (sql.startsWith("INSERT INTO inference_records"))
      throw new Error("private-db-canary");
    return prepare(sql);
  };
  await assert.rejects(
    f.runner.run(f.request, async () => {
      calls++;
      return hold();
    }),
    (error) => !error.message.includes("private-db-canary"),
  );
  assert.equal(calls, 0);
  assert.equal(f.store.retry.attempt(f.request.id), undefined);
  assert.equal(f.store.records.get(f.request.id), undefined);
  assert.equal(f.store.budget.history().entries.length, 1);
});
test("a dispatch-marker write failure cannot start inference or fabricate a response", async (t) => {
  const f = await setup(t);
  let calls = 0;
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    if (sql.startsWith("UPDATE inference_records SET dispatched_at"))
      throw new Error("write fault");
    return prepare(sql);
  };
  await assert.rejects(
    f.runner.run(f.request, async () => {
      calls++;
      return hold();
    }),
  );
  const record = f.store.records.get(f.request.id).record;
  assert.equal(calls, 0);
  assert.equal(record.dispatched_at, null);
  assert.equal(record.responded_at, null);
  assert.equal(record.reason, null);
  assert.equal(record.outcome, "unknown");
});
test("late output is recorded as ignored and never acquires a decision or transaction", async (t) => {
  const f = await setup(t);
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  await assert.rejects(
    f.runner.run(f.request, () => pending, { timeoutMs: 250 }),
  );
  resolve(hold());
  await delay(10);
  const saved = f.store.records.get(f.request.id);
  assert.equal(saved.record.outcome, "unknown");
  assert.equal(saved.record.outcome_code, "timeout");
  assert.equal(saved.record.late_ignored, 1);
  assert.equal(saved.record.schema_outcome, "valid");
  assert.equal(saved.record.reason, hold().reason);
  assert.equal(f.store.getDecision(f.request.id), undefined);
  assert.deepEqual(saved.links, []);
});
test("reported model mismatch is recorded, closes financial admission and cannot be hidden by a callback", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.runner.run(f.request, async (context) => {
      try {
        context.reportIdentity({
          provider: "near-ai",
          model: "unexpected-model",
        });
      } catch {
        /* Deliberately hostile fixture. */
      }
      return hold();
    }),
  );
  const record = f.store.records.get(f.request.id).record;
  assert.equal(record.actual_model, "unexpected-model");
  assert.equal(record.outcome, "failed");
  assert.equal(record.outcome_code, "model_identity_mismatch");
  assert.equal(record.schema_outcome, "valid");
  assert.equal(f.store.getDecision(f.request.id), undefined);
  assert.equal(f.store.budget.status().blocked, true);
});
test("restart and verified backup preserve interrupted input and mark unknown without invented model output", async (t) => {
  const f = await setup(t);
  f.store.retry.reserve(
    f.request,
    f.now,
    15000,
    recordInferenceInput(f.payload),
  );
  f.store.records.dispatch(f.request.id, f.now);
  await mkdir(join(f.dataDir, "backups"));
  const directory = await f.store.backup(join(f.dataDir, "backups"));
  assert.equal((await verifyBackup(directory)).schema, 6);
  await f.reopen();
  const record = f.store.records.get(f.request.id).record;
  assert.equal(record.outcome, "unknown");
  assert.equal(record.outcome_code, "restart");
  assert.equal(record.input_status, "recorded");
  assert.equal(record.returned_action_json, null);
  assert.equal(record.reason, null);
  assert.equal(record.actual_model, null);
  assert.equal(record.responded_at, null);
});
test("v5 migration preserves old journal metadata and explicitly marks missing historical input/output", async (t) => {
  const f = await setup(t);
  f.store.retry.reserve(f.request, f.now, 15000);
  await f.store.close();
  const db = new DatabaseSync(join(f.dataDir, "worker.sqlite"));
  db.exec(dropInference + "PRAGMA user_version=5;");
  db.close();
  await f.reopen();
  const record = f.store.records.get(f.request.id).record;
  assert.equal(record.input_status, "legacy_unavailable");
  assert.equal(record.outcome, "legacy_unavailable");
  assert.equal(record.input_json, null);
  assert.equal(record.returned_action_json, null);
  assert.equal(record.provider, "near-ai");
  assert.equal(record.prompt_version, promptVersion);
  const folders = await readdir(join(f.dataDir, "backups"));
  assert.equal(
    (await verifyBackup(join(f.dataDir, "backups", folders[0]))).schema,
    5,
  );
});
test("terminal inference details prune independently of the protected monetary ledger", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => hold());
  f.store.policy.authorize(f.request.id);
  f.store.scheduler.finishTurn(f.turn.id);
  f.store.scheduler.finishRoot(f.turn.job_id);
  f.store.prune(Date.now() + 8 * 86400000);
  assert.equal(f.store.records.get(f.request.id), undefined);
  assert.equal(f.store.budget.history().entries.length, 1);
  assert.equal(f.store.retry.attempt(f.request.id).status, "succeeded");
});
test("uncertain inference details survive ordinary terminal-log retention", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.runner.run(f.request, async () => {
      throw new Error("private-provider-canary");
    }),
  );
  f.store.scheduler.finishRoot(f.turn.job_id);
  f.store.prune(Date.now() + 8 * 86400000);
  const record = f.store.records.get(f.request.id).record;
  assert.equal(record.outcome, "unknown");
  assert.equal(record.returned_action_json, null);
  assert.doesNotMatch(JSON.stringify(record), /private-provider-canary/);
});

test("unsupported input stops before budget or dispatch instead of logging arbitrary free text", async (t) => {
  const f = await setup(t);
  f.setPayload(
    JSON.stringify({
      messages: [{ role: "user", content: "PRIVATE_FREE_TEXT_CANARY" }],
    }),
  );
  let calls = 0;
  await assert.rejects(
    f.runner.run(f.request, async () => {
      calls++;
      return hold();
    }),
  );
  assert.equal(calls, 0);
  assert.equal(f.store.records.get(f.request.id), undefined);
  assert.equal(f.store.budget.history().entries.length, 0);
});
test("a received response survives failure before decision acceptance without granting authority", async (t) => {
  const f = await setup(t);
  f.store.retry.accept = () => {
    throw new Error("acceptance write fault");
  };
  await assert.rejects(f.runner.run(f.request, async () => hold()));
  let record = f.store.records.get(f.request.id).record;
  assert.equal(record.outcome, "unknown");
  assert.equal(record.schema_outcome, "valid");
  assert.equal(record.reason, hold().reason);
  assert.equal(f.store.getDecision(f.request.id), undefined);
  await f.reopen();
  record = f.store.records.get(f.request.id).record;
  assert.equal(record.schema_outcome, "valid");
  assert.equal(record.reason, hold().reason);
});
test("policy approval and its audit outcome commit together or roll back together", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => buy(f));
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    if (sql.startsWith("UPDATE inference_records SET policy_outcome"))
      throw new Error("audit write fault");
    return prepare(sql);
  };
  assert.throws(() => f.store.policy.authorize(f.request.id));
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM policy_plans").get().n,
    0,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM policy_commitments").get().n,
    0,
  );
  assert.equal(
    f.store.records.get(f.request.id).record.policy_outcome,
    "not_evaluated",
  );
});
test("a definitive provider failure stores a code with no invented response or reason", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.runner.run(f.request, async () => {
      throw new DefinitiveProviderFailure("PRIVATE_PROVIDER_MESSAGE_CANARY");
    }),
  );
  const record = f.store.records.get(f.request.id).record;
  assert.equal(record.outcome, "failed");
  assert.equal(record.outcome_code, "definitive_failure");
  assert.equal(record.responded_at, null);
  assert.equal(record.returned_action_json, null);
  assert.equal(record.reason, null);
  assert.doesNotMatch(
    JSON.stringify(record),
    /PRIVATE_PROVIDER_MESSAGE_CANARY/,
  );
});
