import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkerStore } from "../dist/private/storage/database.js";
import { DiscoveryObserver } from "../dist/private/discovery/observer.js";
import { Scheduler } from "../dist/private/scheduling/scheduler.js";
import {
  ProviderRunner,
  DefinitiveProviderFailure,
} from "../dist/private/retries/provider.js";
import { SafetyClock } from "../dist/private/retries/clock.js";
import { readBackoff } from "../dist/private/retries/backoff.js";
import { CrashSafeProcessor } from "../dist/private/recovery/processor.js";
import { verifyBackup } from "../dist/private/storage/backup.js";
import { captured, fixture, changeView } from "./chain-fixture.mjs";

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "bazaar-retry-")),
    chain = fixture(options);
  const storeOptions = {
    dataDir,
    identity: chain.identity,
    policyVersion: "v1",
    create: true,
  };
  let store = new WorkerStore(storeOptions),
    runner = new ProviderRunner(store);
  await new DiscoveryObserver(chain.client, store).poll();
  const state = store.discoveryState(),
    now = Date.now();
  state.observedAt = now;
  const trade = {
    ...structuredClone(captured.steps[1].result.data),
    settled_at_ns: String(BigInt(now) * 1000000n),
  };
  store.commitDiscovery({
    previousHash: state.block.hash,
    state,
    signals: [
      { key: "purchase:1", kind: "player_purchase", merchantId: "rex", trade },
    ],
  });
  new Scheduler(store).tick();
  const root = store.scheduler.roots()[0].job_id;
  store.db.exec("UPDATE deployment SET recovery_required=0");
  store.recordMerchantCheckpoint("rex", "0", null, true);
  const turn = store.scheduler.nextTurn();
  store.scheduler.claimTurn(turn.id);
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    chain,
    root,
    turnId: turn.id,
    storeOptions,
    get store() {
      return store;
    },
    get runner() {
      return runner;
    },
    async reopen() {
      await store.close();
      store = new WorkerStore({ ...storeOptions, create: false });
      runner = new ProviderRunner(store);
    },
    pause() {
      const state = store.discoveryState();
      state.market.data.paused = true;
      store.commitDiscovery({
        previousHash: state.block.hash,
        state,
        signals: [],
      });
    },
  };
}
const request = (f, id = "request", retryOf) => ({
  id,
  turnId: f.turnId,
  provider: "near-ai",
  model: "test/model",
  promptVersion: "v1",
  ...(retryOf ? { retryOf } : {}),
});
const hold = () => ({ action: { method: "hold" }, reason: "wait" });

for (const invalid of ["envelope", "action", "numeric"])
  test(`invalid provider ${invalid} cannot persist a decision or reach a signer`, async (t) => {
    const f = await setup(t);
    let calls = 0;
    const value =
      invalid === "envelope"
        ? { ...hold(), tools: ["sign"] }
        : invalid === "action"
          ? {
              action: {
                method: "cancel_trade",
                args: { offer_id: "1", action_id: "1" },
              },
              reason: "cancel",
            }
          : {
              action: {
                method: "accept_trade",
                args: { offer_id: 1, action_id: "1" },
              },
              reason: "accept",
            };
    await assert.rejects(
      f.runner.run(request(f), async () => {
        calls++;
        return value;
      }),
    );
    assert.equal(calls, 1);
    assert.equal(f.store.getDecision("request"), undefined);
    assert.equal(f.store.retry.attempt("request").status, "failed");
    assert.equal(f.store.retry.attempt("request").reason, "invalid_decision");
    assert.equal(f.store.getJob(f.root).model_attempts, 1);
    assert.equal(f.chain.loads.length, 0);
    assert.equal(
      f.chain.calls.some((row) => row.method === "send_tx"),
      false,
    );
  });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("read backoff is exponential, capped and reset by a successful cycle", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 100].map((n) => readBackoff(n)),
    [3000, 3000, 6000, 12000, 24000, 30000, 30000],
  );
  assert.throws(() => readBackoff(-1));
  assert.throws(() => readBackoff(1, 0));
});

test("a provider attempt is durably debited before dispatch and accepted exactly once", async (t) => {
  const f = await setup(t);
  let calls = 0;
  const result = await f.runner.run(request(f), async () => {
    calls++;
    assert.equal(f.store.retry.attempt("request").status, "pending");
    assert.equal(f.store.getJob(f.root).model_attempts, 1);
    return { ...hold(), reason: "Bearer secret-token" };
  });
  assert.equal(calls, 1);
  assert.equal(result.decision.reason, "[redacted]");
  result.assertCurrent();
  await assert.rejects(
    f.runner.run(request(f), async () => {
      calls++;
      return hold();
    }),
  );
  assert.equal(calls, 1);
  assert.equal(
    f.store.retry.accept("request", hold().action, "duplicate", Date.now()),
    false,
  );
  assert.equal(f.store.getDecision("request").reason, "[redacted]");
});

test("failed durable reservation prevents every provider request", async (t) => {
  const f = await setup(t);
  f.store.retry.reserve = () => {
    throw new Error("disk failure");
  };
  let calls = 0;
  await assert.rejects(
    f.runner.run(request(f), async () => {
      calls++;
      return hold();
    }),
  );
  assert.equal(calls, 0);
});

test("a definitive failure permits only an explicit new attempt and consumes another root slot", async (t) => {
  const f = await setup(t);
  let calls = 0;
  await assert.rejects(
    f.runner.run(request(f), async () => {
      calls++;
      throw new DefinitiveProviderFailure("do not persist this raw error");
    }),
  );
  assert.equal(f.store.retry.attempt("request").status, "failed");
  assert.equal(calls, 1);
  await assert.rejects(
    f.runner.run(request(f, "implicit"), async () => {
      calls++;
      return hold();
    }),
  );
  await f.runner.run(request(f, "explicit", "request"), async () => {
    calls++;
    return hold();
  });
  assert.equal(calls, 2);
  assert.equal(f.store.getJob(f.root).model_attempts, 2);
  assert.equal(f.store.scheduler.roots()[0].model_calls, 2);
});

test("unknown outcomes never retry even with a new request ID", async (t) => {
  const f = await setup(t);
  let calls = 0;
  await assert.rejects(
    f.runner.run(request(f), async () => {
      calls++;
      throw new Error("unknown outcome");
    }),
  );
  assert.equal(f.store.retry.attempt("request").status, "unknown");
  await assert.rejects(
    f.runner.run(request(f, "replacement", "request"), async () => {
      calls++;
      return hold();
    }),
  );
  assert.equal(calls, 1);
  assert.equal(f.store.getJob(f.root).model_attempts, 1);
});

test("timeout ignores a late response, persists uncertain outcome and never invents a decision", async (t) => {
  const f = await setup(t),
    pending = deferred();
  let calls = 0;
  await assert.rejects(
    f.runner.run(
      request(f),
      () => {
        calls++;
        return pending.promise;
      },
      { timeoutMs: 250 },
    ),
  );
  pending.resolve(hold());
  await delay(5);
  assert.equal(calls, 1);
  assert.equal(f.store.retry.attempt("request").status, "unknown");
  assert.equal(f.store.retry.attempt("request").late_ignored, 1);
  assert.equal(f.store.getDecision("request"), undefined);
  assert.equal(f.store.getJob(f.root).model_attempts, 1);
});

for (const cause of ["pause", "recovery", "root_expiry", "cancel"])
  test(`${cause} revokes an in-flight response without refunding its attempt`, async (t) => {
    const f = await setup(t),
      pending = deferred(),
      abort = new AbortController();
    let started = false;
    const task = f.runner.run(
      request(f),
      () => {
        started = true;
        return pending.promise;
      },
      { signal: abort.signal },
    );
    const rejected = assert.rejects(task);
    await Promise.resolve();
    assert.equal(started, true);
    if (cause === "pause") f.pause();
    else if (cause === "recovery") f.store.requireRecovery();
    else if (cause === "root_expiry")
      f.store.db.prepare("UPDATE jobs SET deadline=1 WHERE id=?").run(f.root);
    else abort.abort();
    pending.resolve(hold());
    await rejected;
    assert.equal(f.store.getDecision("request"), undefined);
    assert.equal(f.store.getJob(f.root).model_attempts, 1);
    assert.equal(f.store.retry.attempt("request").status, "unknown");
  });

test("a pause observed before the dispatch microtask prevents the network call", async (t) => {
  const f = await setup(t);
  let calls = 0;
  const task = f.runner.run(request(f), async () => {
    calls++;
    return hold();
  });
  f.pause();
  await assert.rejects(task);
  assert.equal(calls, 0);
});

test("restart marks unfinished requests unknown and preserves counters and closed turn authority", async (t) => {
  const f = await setup(t);
  f.store.retry.reserve(request(f), Date.now(), 15000);
  await f.reopen();
  assert.equal(f.store.retry.attempt("request").status, "unknown");
  assert.equal(f.store.getJob(f.root).model_attempts, 1);
  assert.equal(f.store.scheduler.turns(f.root)[0].status, "skipped");
  assert.equal(f.store.checkpoint().recovery_required, 1);
  let calls = 0;
  await assert.rejects(
    f.runner.run(request(f, "new", "request"), async () => {
      calls++;
      return hold();
    }),
  );
  assert.equal(calls, 0);
});

for (const window of ["hour", "day"])
  test(`persistent ${window} request cap blocks dispatch without another debit`, async (t) => {
    const f = await setup(t),
      now = Date.now(),
      count = window === "hour" ? 60 : 600;
    const historicalTurn = "historical";
    f.store.db
      .prepare(
        "INSERT INTO scheduler_turns VALUES(?,?,?,'decision','historical','completed')",
      )
      .run(historicalTurn, f.root, "luna");
    const insert = f.store.db.prepare(
      "INSERT INTO provider_attempts(id,turn_id,job_id,merchant_id,session_id,epoch,provider,model,prompt_version,started_at,deadline,status) VALUES(?,?,?,'luna','old',0,'near-ai','model','v1',?,?,'failed')",
    );
    for (let i = 0; i < count; i++) {
      const at = now - (window === "hour" ? 1000 : 2 * 3600000);
      insert.run(`old${i}`, historicalTurn, f.root, at, at + 15000);
    }
    let calls = 0;
    await assert.rejects(
      f.runner.run(request(f), async () => {
        calls++;
        return hold();
      }),
      /limit/,
    );
    assert.equal(calls, 0);
    assert.equal(f.store.retry.attempt("request"), undefined);
    assert.equal(f.store.getJob(f.root).model_attempts, 0);
  });

test("each explicit retry consumes the persistent six-attempt root ceiling", async (t) => {
  const f = await setup(t);
  let previous;
  for (let i = 0; i < 6; i++) {
    const id = `try${i}`;
    await assert.rejects(
      f.runner.run(request(f, id, previous), async () => {
        throw new DefinitiveProviderFailure();
      }),
    );
    previous = id;
  }
  let calls = 0;
  await assert.rejects(
    f.runner.run(request(f, "seventh", previous), async () => {
      calls++;
      return hold();
    }),
  );
  assert.equal(calls, 0);
  assert.equal(f.store.getJob(f.root).model_attempts, 6);
});

test("monotonic clock guard latches on forward/backward jumps and persistent rollback blocks restart admission", async (t) => {
  const f = await setup(t);
  let wall = Date.now(),
    mono = 0;
  const clock = new SafetyClock(
    () => f.store.retry.blockClock(wall),
    () => wall,
    () => mono,
  );
  clock.now();
  mono += 10;
  wall += 10;
  clock.now();
  wall += 6000;
  assert.throws(() => clock.now(), /clock/);
  assert.equal(f.store.retry.state().clock_blocked, 1);
  assert.equal(f.store.checkpoint().recovery_required, 1);
  await f.reopen();
  assert.equal(f.store.retry.state().clock_blocked, 1);
  let calls = 0;
  await assert.rejects(
    f.runner.run(request(f), async () => {
      calls++;
      return hold();
    }),
  );
  assert.equal(calls, 0);
  let backWall = Date.now();
  const back = new SafetyClock(
    () => {},
    () => backWall,
    () => 0,
  );
  backWall -= 6000;
  assert.throws(() => back.now(), /clock/);
});

test("accepted decisions lose authority on a later pause even after resume", async (t) => {
  const f = await setup(t);
  const accepted = await f.runner.run(request(f), async () => hold());
  f.pause();
  const state = f.store.discoveryState();
  state.market.data.paused = false;
  f.store.commitDiscovery({
    previousHash: state.block.hash,
    state,
    signals: [],
  });
  assert.throws(accepted.assertCurrent, /revoked/);
  assert.equal(f.store.retry.attempt("request").status, "succeeded");
});

for (const cause of ["pause", "deadline"])
  test(`state changes during credential loading stop ${cause} before a signature is produced`, async (t) => {
    let f,
      reads = 0;
    f = await setup(t, {
      patch: (_method, params, result) => {
        if (
          params.method_name === "get_market_state" &&
          ++reads >= 4 &&
          cause === "pause"
        )
          return changeView(result, (view) => {
            view.data.paused = true;
          });
        return result;
      },
    });
    const verifier = async (context) => ({
      ...context,
      journal: "current",
      fencing: "verified",
      providerHistory: "accounted",
      evidenceRef: "unit:trusted",
      baselines: {
        rex: { actionId: "0", digest: null },
        luna: { actionId: "0", digest: null },
        bolt: { actionId: "0", digest: null },
      },
    });
    const processor = new CrashSafeProcessor(
      f.store,
      f.chain.client,
      f.chain.adapter,
      verifier,
    );
    // Close the synthetic model turn so recovery can own the session, then use an operator test job.
    assert.equal((await processor.recover()).kind, "ready");
    const now = Date.now();
    f.store.db
      .prepare("UPDATE jobs SET status='completed' WHERE id=?")
      .run(f.root);
    f.store.enqueue({
      id: "operator",
      triggerKey: "operator",
      triggerRef: "test",
      deadline: now + 120000,
    });
    f.store.activateJob("operator");
    f.store.claimLocks("operator", ["rex"], "controller");
    if (cause === "deadline") {
      const prepare = f.chain.adapter.prepare.bind(f.chain.adapter);
      f.chain.adapter.prepare = (...args) =>
        prepare(args[0], args[1], args[2], async (snapshot) => {
          f.store.db.exec("UPDATE jobs SET deadline=1 WHERE id='operator'");
          await args[3](snapshot);
        });
    }
    await assert.rejects(
      processor.execute({
        id: "stale",
        jobId: "operator",
        merchantId: "rex",
        method: "propose_trade",
        args: captured.steps[2].args,
      }),
    );
    assert.equal(f.store.attempt("stale"), undefined);
    assert.equal(
      f.chain.calls.filter((row) => row.method === "send_tx").length,
      0,
    );
  });

test("v3 migration preserves scheduler state, and upgrades backups before adding the request ledger", async (t) => {
  const f = await setup(t);
  await f.store.close();
  const db = new DatabaseSync(join(f.dataDir, "worker.sqlite"));
  db.exec(
    "DROP TABLE provider_attempts;DROP TABLE retry_state;PRAGMA user_version=3;",
  );
  db.close();
  await f.reopen();
  const directory = join(f.dataDir, "backups"),
    backups = await readdir(directory);
  assert.equal((await verifyBackup(join(directory, backups[0]))).schema, 3);
  assert.equal(f.store.scheduler.roots().length, 1);
});
