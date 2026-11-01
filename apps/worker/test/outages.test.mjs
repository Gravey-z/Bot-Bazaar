import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  readAiAvailability,
  summarizeInference,
  InferenceUnavailableError,
} from "../dist/private/inference/availability.js";
import { runDiagnostic } from "../dist/private/inference/diagnostic.js";
import { parseDecision } from "../dist/private/decisions/schema.js";
import {
  ProviderRunner,
  DefinitiveProviderFailure,
} from "../dist/private/retries/provider.js";
import { setupInferenceFixture as setup } from "./inference-fixture.mjs";
const hold = () => ({ action: { method: "hold" }, reason: "Retain reserves." });

test("disabled and unconfigured workers explicitly report AI unavailable without claiming live evidence", async (t) => {
  const f = await setup(t);
  for (const [mode, code] of [
    ["disabled", "provider_disabled"],
    ["unconfigured", "provider_not_configured"],
  ]) {
    const value = readAiAvailability(f.store, mode);
    assert.equal(value.label, "AI unavailable");
    assert.equal(value.code, code);
    assert.equal(value.liveAiEvidence, false);
    assert.equal(value.lastInference, null);
  }
});
test("pending and received responses describe observed progress without claiming AI readiness", async (t) => {
  const f = await setup(t);
  let resolve, start;
  const pending = new Promise((done) => {
      resolve = done;
    }),
    started = new Promise((done) => {
      start = done;
    });
  const task = f.runner.run(f.request, () => {
    start();
    return pending;
  });
  await started;
  let value = readAiAvailability(f.store, "provider");
  assert.equal(value.status, "pending");
  assert.equal(value.code, "request_pending");
  resolve(hold());
  await task;
  value = readAiAvailability(f.store, "provider");
  assert.equal(value.status, "response_received");
  assert.equal(value.label, "AI response received");
  assert.equal(value.liveAiEvidence, false);
});
test("provider failure returns a stable unavailable code, preserves spend and never creates a fallback decision", async (t) => {
  const f = await setup(t);
  let calls = 0;
  await assert.rejects(
    f.runner.run(f.request, async () => {
      calls++;
      throw new DefinitiveProviderFailure("PRIVATE_PROVIDER_CANARY");
    }),
    (error) =>
      error instanceof InferenceUnavailableError &&
      error.code === "provider_failure" &&
      /AI unavailable/.test(error.message) &&
      !error.message.includes("PRIVATE_PROVIDER_CANARY"),
  );
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.code, "provider_failure");
  assert.equal(value.label, "AI unavailable");
  assert.equal(calls, 1);
  assert.equal(f.store.getDecision(f.request.id), undefined);
  assert.equal(f.store.budget.history().entries[0].charged_micro, 1000);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM inference_records").get().n,
    1,
  );
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_PROVIDER_CANARY/);
});
test("malformed model output surfaces a validation error without exposing the payload", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.runner.run(f.request, async () => ({
      action: { method: "send_tx", privateKey: "PRIVATE_OUTPUT_CANARY" },
      reason: "bad choice",
    })),
    (error) =>
      error.code === "schema_invalid" &&
      /AI validation error/.test(error.message),
  );
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.status, "validation_error");
  assert.equal(value.code, "schema_invalid");
  assert.doesNotMatch(
    JSON.stringify(value),
    /PRIVATE_OUTPUT_CANARY|send_tx|bad choice/,
  );
  assert.equal(f.store.records.get(f.request.id).links.length, 0);
});
test("policy rejection is visibly distinct from schema success and cannot authorize signing", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => ({
    action: {
      method: "set_listing",
      args: {
        merchant_id: "rex",
        resource: "crystal",
        unit_price: "6",
        quantity: "1",
        active: true,
        expected_version: "1",
        action_id: "1",
      },
    },
    reason: "invalid shortage price",
  }));
  assert.throws(() => f.store.policy.authorize(f.request.id), /price/);
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.code, "policy_rejected");
  assert.equal(value.label, "AI validation error");
  assert.equal(f.chain.loads.length, 0);
  assert.equal(f.store.records.get(f.request.id).links.length, 0);
});
test("timeout and ignored late output remain unavailable with one provider attempt", async (t) => {
  const f = await setup(t);
  let resolve,
    calls = 0;
  const pending = new Promise((done) => {
    resolve = done;
  });
  await assert.rejects(
    f.runner.run(
      f.request,
      () => {
        calls++;
        return pending;
      },
      { timeoutMs: 250 },
    ),
    (error) => error.code === "request_timeout",
  );
  resolve(hold());
  await delay(10);
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.code, "request_timeout");
  assert.equal(value.status, "unavailable");
  assert.equal(calls, 1);
  assert.equal(f.store.getDecision(f.request.id), undefined);
});
test("missing provider configuration is surfaced before any request or inference reservation", async (t) => {
  const f = await setup(t);
  let calls = 0;
  await assert.rejects(
    new ProviderRunner(f.store).run(f.request, async () => {
      calls++;
      return hold();
    }),
    (error) => error.code === "provider_not_configured",
  );
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.code, "provider_not_configured");
  assert.equal(value.lastAdmission.code, "provider_not_configured");
  assert.equal(value.lastInference, null);
  assert.equal(calls, 0);
  assert.equal(f.store.budget.history().entries.length, 0);
});
test("a successful new admission clears an earlier transient input failure", async (t) => {
  const f = await setup(t),
    payload = f.payload;
  f.setPayload('{"messages":[]}');
  await assert.rejects(
    f.runner.run(f.request, async () => hold()),
    (error) => error.code === "input_unavailable",
  );
  assert.equal(
    readAiAvailability(f.store, "provider").lastAdmission.code,
    "input_unavailable",
  );
  f.setPayload(payload);
  await f.runner.run(f.request, async () => hold());
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.code, "response_recorded");
  assert.equal(value.lastAdmission, null);
});
test("budget and continuity admission failures are unavailable rather than fabricated model holds", async (t) => {
  const f = await setup(t);
  f.store.db.exec("UPDATE usage_state SET verified_session=NULL");
  let calls = 0;
  await assert.rejects(
    f.runner.run(f.request, async () => {
      calls++;
      return hold();
    }),
    (error) => error.code === "admission_unavailable",
  );
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.label, "AI unavailable");
  assert.equal(value.lastAdmission.code, "admission_unavailable");
  assert.equal(calls, 0);
  assert.equal(f.store.getDecision(f.request.id), undefined);
});
test("recovery, pause and stale snapshots keep AI status unavailable even after a prior response", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => hold());
  assert.equal(
    readAiAvailability(f.store, "provider").code,
    "response_recorded",
  );
  f.store.requireRecovery();
  assert.equal(
    readAiAvailability(f.store, "provider").code,
    "recovery_required",
  );
  f.store.db.exec("UPDATE deployment SET recovery_required=0");
  const state = f.store.discoveryState();
  state.market.data.paused = true;
  f.store.commitDiscovery({
    previousHash: state.block.hash,
    state,
    signals: [],
  });
  assert.equal(readAiAvailability(f.store, "provider").code, "market_paused");
  assert.equal(
    readAiAvailability(f.store, "provider", state.observedAt + 16000).code,
    "snapshot_unavailable",
  );
});
test("restart exposes previous outcomes as history and cannot resurrect provider availability", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => hold());
  await f.reopen();
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.code, "recovery_required");
  assert.equal(value.lastInference.currentSession, false);
  assert.equal(value.lastInference.code, "response_recorded");
  assert.equal(value.liveAiEvidence, false);
});
test("status projection is bounded and read-only with no model, signing or private-record payload", async (t) => {
  const f = await setup(t);
  await f.runner.run(f.request, async () => hold());
  const calls = f.chain.calls.length,
    usage = f.store.budget.history().entries.length,
    prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    assert.match(sql, /^SELECT/);
    return prepare(sql);
  };
  const value = readAiAvailability(f.store, "provider");
  const output = JSON.stringify(value);
  assert.ok(Buffer.byteLength(output) < 4096);
  assert.doesNotMatch(
    output,
    /action_json|reason|input_json|payload_sha256|fixture-model|ed25519|signed_json/,
  );
  assert.equal(f.chain.calls.length, calls);
  assert.equal(f.chain.loads.length, 0);
  assert.equal(f.store.budget.history().entries.length, usage);
});
test("storage-read failure produces a sanitized unavailable response instead of leaking a raw exception", async (t) => {
  const f = await setup(t);
  f.store.records.latestStatus = () => {
    throw new Error("PRIVATE_STORAGE_CANARY");
  };
  const value = readAiAvailability(f.store, "provider");
  assert.equal(value.code, "storage_unavailable");
  assert.equal(value.label, "AI unavailable");
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_STORAGE_CANARY/);
});
test("unknown and prototype-like journal codes map to a fixed safe public vocabulary", () => {
  for (const code of [
    "PRIVATE_ERROR_CANARY",
    "__proto__",
    "constructor",
    "toString",
  ]) {
    const value = summarizeInference({
      outcome: "unknown",
      outcome_code: code,
      updated_at: NaN,
      current_session: 0,
    });
    assert.equal(value.code, "outcome_unknown");
    assert.equal(value.observedAt, null);
    assert.doesNotMatch(
      JSON.stringify(value),
      /PRIVATE_ERROR_CANARY|__proto__|constructor|toString/,
    );
  }
});
function diagnosticContext(f) {
  return {
    state: f.state,
    merchantId: "rex",
    phase: "decision",
    rootDeadline: f.now + 120000,
    rexShortageMode: true,
    mutationsRemaining: 8,
    commitments: [],
    rejectedOfferIds: [],
    changedResources: ["crystal"],
  };
}
test("diagnostics are visibly labelled offline test data and cannot be submitted as a live decision", async (t) => {
  const f = await setup(t),
    calls = f.chain.calls.length,
    result = runDiagnostic(
      { ...hold(), reason: "Diagnostic fixture" },
      diagnosticContext(f),
    );
  assert.equal(result.validation, "valid");
  assert.equal(result.source, "diagnostic");
  assert.equal(result.label, "Diagnostic test data");
  assert.equal(result.liveAiEvidence, false);
  assert.throws(() => parseDecision(result));
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM inference_records").get().n,
    0,
  );
  assert.equal(f.store.budget.history().entries.length, 0);
  assert.equal(f.chain.loads.length, 0);
  assert.equal(f.chain.calls.length, calls);
  assert.equal(
    readAiAvailability(f.store, "diagnostic").label,
    "Diagnostic test data",
  );
});
test("invalid diagnostic input returns labelled validation failure without a replacement decision", async (t) => {
  const f = await setup(t),
    result = runDiagnostic(
      {
        action: { method: "sign_secret" },
        reason: "PRIVATE_DIAGNOSTIC_CANARY",
      },
      diagnosticContext(f),
    );
  assert.equal(result.validation, "invalid");
  assert.equal(result.code, "schema_invalid");
  assert.equal(result.liveAiEvidence, false);
  assert.equal(result.candidate, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE_DIAGNOSTIC_CANARY|sign_secret/,
  );
});
test("diagnostic policy failure cannot bypass reserves or spend live budgets", async (t) => {
  const f = await setup(t),
    result = runDiagnostic(
      {
        action: {
          method: "set_listing",
          args: {
            merchant_id: "rex",
            resource: "crystal",
            unit_price: "6",
            quantity: "1",
            active: true,
            expected_version: "1",
            action_id: "1",
          },
        },
        reason: "fixture",
      },
      diagnosticContext(f),
    );
  assert.equal(result.code, "policy_rejected");
  assert.equal(result.liveAiEvidence, false);
  assert.equal(f.store.budget.history().entries.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM intents").get().n,
    0,
  );
});
