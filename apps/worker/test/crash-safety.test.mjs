import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerStore } from "../dist/private/storage/database.js";
import { CrashSafeProcessor } from "../dist/private/recovery/processor.js";
import { captured, fixture } from "./chain-fixture.mjs";
import { verifyBackup } from "../dist/private/storage/backup.js";

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "bazaar-crash-"));
  let receipt = { final_execution_status: "NONE" };
  let submits = 0;
  const chain = fixture({
    patch: async (method, params, result) => {
      if (method === "tx") return receipt;
      if (method === "send_tx") {
        submits++;
        if (options.onSend) await options.onSend();
        if (options.timeout) throw new Error("timeout secret-canary");
      }
      return options.patch
        ? await options.patch(method, params, result)
        : result;
    },
  });
  const storeOptions = {
    dataDir: root,
    identity: chain.identity,
    policyVersion: "v1",
    create: true,
  };
  let store = new WorkerStore(storeOptions);
  let authorityMode = "current";
  const verifier = async (context) => ({
    ...context,
    journal: authorityMode,
    fencing: "verified",
    providerHistory: "accounted",
    evidenceRef: "unit:verified-fence-and-current-journal",
    baselines: {
      rex: { actionId: "0", digest: null },
      luna: { actionId: "0", digest: null },
      bolt: { actionId: "0", digest: null },
    },
  });
  let processor = new CrashSafeProcessor(
    store,
    chain.client,
    chain.adapter,
    verifier,
  );
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    chain,
    root,
    verifier,
    get store() {
      return store;
    },
    get processor() {
      return processor;
    },
    get submits() {
      return submits;
    },
    setReceipt(value) {
      receipt = value;
    },
    setAuthority(mode) {
      authorityMode = mode;
    },
    async restart(withAuthority = true) {
      await store.close();
      store = new WorkerStore({ ...storeOptions, create: false });
      processor = new CrashSafeProcessor(
        store,
        chain.client,
        chain.adapter,
        withAuthority ? verifier : undefined,
      );
    },
    publish() {
      Object.assign(chain.state, structuredClone(captured.pending));
    },
  };
}
const proposal = () => ({
  id: "intent",
  jobId: "job",
  merchantId: "rex",
  method: "propose_trade",
  args: structuredClone(captured.steps[2].args),
});
async function ready(f) {
  assert.equal((await f.processor.recover()).kind, "ready");
  f.store.enqueue({
    id: "job",
    triggerKey: "test:root",
    triggerRef: "trade:1",
    deadline: Date.now() + 120000,
  });
  f.store.activateJob("job");
  f.store.claimLocks("job", ["rex", "luna"], "commitment");
  f.store.claimLocks("job", ["rex"], "controller");
}
function receiptFor(f) {
  const prepared = JSON.parse(f.store.attempt("intent").signed_json),
    value = structuredClone(captured.steps[2].receipt);
  Object.assign(value.transaction, {
    hash: prepared.transactionHash,
    public_key: prepared.publicKey,
    nonce: Number(prepared.nonce),
  });
  value.transaction_outcome.id = prepared.transactionHash;
  return value;
}

test("fresh signing needs explicit verified continuity and deployment-bound baselines", async (t) => {
  const f = await setup(t),
    readOnly = new CrashSafeProcessor(f.store, f.chain.client, f.chain.adapter);
  const blocked = await readOnly.recover();
  assert.equal(blocked.kind, "blocked");
  assert.ok(blocked.reasons.includes("merchant_baseline_unverified"));
  await assert.rejects(readOnly.execute(proposal()), /recovery/);
  assert.deepEqual(f.chain.loads, []);
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.checkpoint().recovery_required, 0);
});

test("the network sees only exact signed bytes that were durably marked unknown before broadcast", async (t) => {
  let f;
  f = await setup(t, {
    onSend: () => {
      assert.equal(f.store.getIntent("intent").status, "unknown");
      const stored = JSON.parse(f.store.attempt("intent").signed_json);
      const send = f.chain.calls.find((row) => row.method === "send_tx");
      assert.equal(
        send.params.signed_tx_base64,
        stored.signedTransactionBase64,
      );
    },
  });
  await ready(f);
  const result = await f.processor.execute(proposal());
  assert.equal(result.kind, "submitted");
  assert.equal(f.submits, 1);
  assert.equal(f.store.checkpoint().recovery_required, 1);
  assert.equal(f.chain.loads.length, 1);
  const events = f.store.activity
    .page(undefined, 50, "https://testnet.nearblocks.io")
    .entries.filter((e) => e.intent_id === "intent");
  assert.deepEqual(
    events.map((e) => e.status),
    ["prepared", "signed", "unknown", "submitted"],
  );
  assert.ok(
    events
      .slice(2)
      .every((e) =>
        e.transaction.explorer_url.endsWith(f.store.attempt("intent").tx_hash),
      ),
  );
  assert.ok(events.every((e) => e.transaction?.receipt_hash == null));
  assert.doesNotMatch(
    JSON.stringify(events),
    /signed_json|signedTransactionBase64|secretKey|nonce/,
  );
});

test("a failed intent commit never loads a signing secret or broadcasts", async (t) => {
  const f = await setup(t);
  await ready(f);
  f.store.prepareIntent = async () => {
    throw new Error("injected commit failure");
  };
  await assert.rejects(f.processor.execute(proposal()));
  assert.equal(f.chain.loads.length, 0);
  assert.equal(f.submits, 0);
});

for (const afterCommit of [false, true])
  test(`crash ${afterCommit ? "after" : "before"} signed-byte persistence never broadcasts or signs a replacement`, async (t) => {
    const f = await setup(t);
    await ready(f);
    const save = f.store.saveSigned.bind(f.store);
    f.store.saveSigned = (...args) => {
      if (afterCommit) save(...args);
      throw new Error("crash");
    };
    await assert.rejects(f.processor.execute(proposal()));
    assert.equal(f.submits, 0);
    assert.equal(f.chain.loads.length, 1);
    assert.equal(
      f.store.getIntent("intent").status,
      afterCommit ? "signed" : "prepared",
    );
    await f.restart();
    const report = await f.processor.recover();
    if (afterCommit) {
      assert.equal(report.kind, "blocked");
      const hash = f.store.attempt("intent").tx_hash;
      const resumed = await f.processor.submitPersisted("intent");
      assert.equal(resumed.transactionHash, hash);
      assert.equal(f.chain.loads.length, 1);
      assert.equal(f.submits, 1);
    } else {
      assert.equal(report.kind, "ready");
      assert.equal(f.store.getIntent("intent").status, "abandoned");
    }
  });

test("an unknown-marker commit failure prevents every network submission", async (t) => {
  const f = await setup(t);
  await ready(f);
  f.store.markBroadcast = () => {
    throw new Error("disk failure before send");
  };
  await assert.rejects(f.processor.execute(proposal()));
  assert.equal(f.submits, 0);
  assert.equal(f.store.getIntent("intent").status, "signed");
});

test("timeout/restart/nonce advancement/expiry never allocate a replacement or release locks", async (t) => {
  const f = await setup(t, { timeout: true });
  await ready(f);
  const sent = await f.processor.execute(proposal());
  assert.equal(sent.kind, "unknown");
  const hash = f.store.attempt("intent").tx_hash;
  await f.restart();
  f.chain.state.keys["rex-bazaar.testnet"].nonce += 10;
  f.store.db.exec("UPDATE jobs SET deadline=1 WHERE id='job'");
  assert.equal((await f.processor.recover()).kind, "blocked");
  await assert.rejects(
    f.processor.execute({
      ...proposal(),
      id: "replacement",
      args: { ...proposal().args, action_id: "2" },
    }),
  );
  await assert.rejects(f.processor.submitPersisted("intent"));
  assert.equal(f.submits, 1);
  assert.equal(f.chain.loads.length, 1);
  assert.equal(f.store.attempt("intent").tx_hash, hash);
  assert.throws(() => f.store.releaseLocks("job", "commitment"));
  assert.equal(f.store.locks().length, 3);
});

test("crash after network acknowledgement but before acknowledgement persistence leaves a recoverable unknown", async (t) => {
  const f = await setup(t);
  await ready(f);
  const mark = f.store.markBroadcast.bind(f.store);
  f.store.markBroadcast = (id, status) => {
    if (status === "submitted") throw new Error("crash after send");
    mark(id, status);
  };
  const result = await f.processor.execute(proposal());
  assert.equal(result.kind, "unknown");
  assert.equal(f.store.getIntent("intent").status, "unknown");
  f.publish();
  f.setReceipt(receiptFor(f));
  await f.restart();
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.getIntent("intent").status, "confirmed");
  assert.equal(f.submits, 1);
  const confirmed = f.store.activity
    .page(undefined, 50, "https://testnet.nearblocks.io")
    .entries.find((e) => e.intent_id === "intent" && e.status === "confirmed");
  assert.equal(confirmed.source, "chain");
  assert.equal(confirmed.transaction.evidence, "receipt");
  assert.equal(confirmed.transaction.evidence_incomplete, false);
  assert.equal(
    confirmed.transaction.receipt_hash,
    f.store.attempt("intent").tx_hash,
  );
  assert.equal(f.chain.loads.length, 1);
});

test("a final failed receipt consumes no action ID and preserves its exact evidence", async (t) => {
  const f = await setup(t);
  await ready(f);
  await f.processor.execute(proposal());
  const failed = receiptFor(f);
  failed.status = { Failure: { ActionError: {} } };
  failed.receipts_outcome[0].outcome.status = failed.status;
  f.setReceipt(failed);
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.getIntent("intent").status, "failed");
  const failedEvent = f.store.activity
    .page(undefined, 50, "https://testnet.nearblocks.io")
    .entries.find((e) => e.intent_id === "intent" && e.status === "failed");
  assert.equal(failedEvent.source, "chain");
  assert.equal(failedEvent.transaction.evidence, "receipt");
  assert.equal(failedEvent.trade, null);
  assert.equal(f.store.merchantCheckpoint("rex").last_action_id, "0");
  assert.equal(
    JSON.parse(f.store.attempt("intent").evidence_json).kind,
    "failed",
  );
});

test("matching onchain action proof records incomplete evidence without fabricating a transaction receipt", async (t) => {
  const f = await setup(t, { timeout: true });
  await ready(f);
  await f.processor.execute(proposal());
  f.publish();
  await f.restart();
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.getIntent("intent").status, "confirmed");
  const evidence = JSON.parse(f.store.attempt("intent").evidence_json);
  assert.equal(evidence.evidence_incomplete, true);
  assert.equal(evidence.transaction_hash, null);
  assert.equal(evidence.kind, "action_checkpoint");
  assert.equal(f.store.merchantCheckpoint("rex").last_action_id, "1");
  assert.equal(f.store.offers()[0].offer_id, "1");
  assert.equal(f.submits, 1);
  const confirmed = f.store.activity
    .page(undefined, 50, "https://testnet.nearblocks.io")
    .entries.find((e) => e.intent_id === "intent" && e.status === "confirmed");
  assert.equal(confirmed.source, "chain");
  assert.equal(confirmed.transaction.evidence, "action_checkpoint");
  assert.equal(confirmed.transaction.evidence_incomplete, true);
  assert.equal(confirmed.transaction.receipt_hash, null);
  assert.equal(confirmed.transaction.explorer_url, null);
  assert.equal(
    confirmed.transaction.signed_hash,
    f.store.attempt("intent").tx_hash,
  );
  assert.equal(confirmed.trade, null);
});

test("a conflicting digest or overwritten action with unavailable receipts keeps new signing blocked", async (t) => {
  for (const overwritten of [false, true]) {
    const f = await setup(t, { timeout: true });
    await ready(f);
    await f.processor.execute(proposal());
    f.publish();
    const rex = f.chain.state.market.data.merchants[0];
    rex.last_action.args_sha256 = "b".repeat(64);
    if (overwritten) {
      rex.last_action_id = "2";
      rex.last_action.action_id = "2";
    }
    const report = await f.processor.recover();
    assert.equal(report.kind, "blocked");
    assert.equal(f.store.getIntent("intent").status, "unknown");
    assert.equal(f.submits, 1);
  }
});

test("cleanup with no application action ID remains unknown without its own final receipt", async (t) => {
  const f = await setup(t);
  await ready(f);
  const cleanup = {
    id: "cleanup",
    jobId: "job",
    merchantId: "rex",
    method: "expire_offers",
    args: { offer_ids: ["1"] },
  };
  await f.processor.execute(cleanup);
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.equal(f.store.getIntent("cleanup").status, "submitted");
  assert.throws(() => f.store.releaseLocks("job", "controller"));
  assert.equal(f.submits, 1);
});

test("a restored missing interval cannot abandon prepared work or enable signing even with matching chain state", async (t) => {
  const f = await setup(t);
  await ready(f);
  await f.store.prepareIntent(proposal());
  await f.restart(false);
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.equal(f.store.getIntent("intent").status, "prepared");
  await f.restart();
  f.setAuthority("missing_interval");
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.equal(f.store.getIntent("intent").status, "prepared");
  assert.equal(f.store.checkpoint().recovery_required, 1);
  assert.equal(f.chain.loads.length, 0);
});

test("read-only restart can record definite facts but never clears an unverified restore barrier", async (t) => {
  const f = await setup(t);
  await ready(f);
  await f.processor.execute(proposal());
  f.publish();
  f.setReceipt(receiptFor(f));
  await f.restart(false);
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.equal(f.store.getIntent("intent").status, "confirmed");
  assert.equal(f.store.checkpoint().recovery_required, 1);
});

test("concurrent calls cannot sign two transactions for the same controller", async (t) => {
  const f = await setup(t);
  await ready(f);
  const first = f.processor.execute(proposal());
  await assert.rejects(
    f.processor.execute({ ...proposal(), id: "racing" }),
    /busy/,
  );
  await first;
  assert.equal(f.chain.loads.length, 1);
  assert.equal(f.submits, 1);
});

test("fencing/provider-history omissions and a replayed session attestation never authorize signing", async (t) => {
  const f = await setup(t),
    context = {
      sessionId: String(f.store.checkpoint().feed_generation),
      identityHash: "invalid",
    };
  for (const change of [
    { fencing: "unverified" },
    { providerHistory: "unknown" },
    { sessionId: "previous-process-session" },
    context,
  ]) {
    const verifier = async (current) => ({
      ...(await f.verifier(current)),
      ...change,
    });
    const processor = new CrashSafeProcessor(
      f.store,
      f.chain.client,
      f.chain.adapter,
      verifier,
    );
    assert.equal((await processor.recover()).kind, "blocked");
  }
  assert.equal(f.store.checkpoint().recovery_required, 1);
  assert.equal(f.chain.loads.length, 0);
});

test("a durable final-confirmation write failure preserves unknown identity until a later restart", async (t) => {
  const f = await setup(t);
  await ready(f);
  await f.processor.execute(proposal());
  f.publish();
  f.setReceipt(receiptFor(f));
  f.store.finishAttempt = () => {
    throw new Error("injected durable failure");
  };
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.equal(f.store.getIntent("intent").status, "submitted");
  const hash = f.store.attempt("intent").tx_hash;
  await f.restart();
  assert.equal((await f.processor.recover()).kind, "ready");
  assert.equal(f.store.attempt("intent").tx_hash, hash);
  assert.equal(f.submits, 1);
});

test("a pruned offer behind action-only proof remains a protected dependency across recovery passes", async (t) => {
  const f = await setup(t, {
    timeout: true,
    patch: (_method, params, result) => {
      if (params.method_name !== "get_offer") return result;
      const view = JSON.parse(Buffer.from(result.result).toString());
      view.data = { kind: "pruned", offer_id: "1" };
      return {
        ...result,
        result: Array.from(Buffer.from(JSON.stringify(view))),
      };
    },
  });
  await ready(f);
  await f.processor.execute(proposal());
  f.publish();
  const first = await f.processor.recover();
  assert.equal(first.kind, "blocked");
  assert.equal(f.store.getIntent("intent").status, "confirmed");
  assert.ok(first.reasons.includes("offer_dependency_evidence_unavailable"));
  assert.equal((await f.processor.recover()).kind, "blocked");
  assert.equal(f.store.unprovenOfferDependencies().length, 1);
  assert.equal(f.store.checkpoint().recovery_required, 1);
});

test("backup verification supports a reconciled snapshot but restoration always reinstates the barrier", async (t) => {
  const f = await setup(t);
  assert.equal((await f.processor.recover()).kind, "ready");
  const backups = join(f.root, "backups");
  await mkdir(backups);
  const bundle = await f.store.backup(backups);
  await verifyBackup(bundle);
  const restored = join(f.root, "restored");
  await mkdir(restored);
  await copyFile(
    join(bundle, "worker.sqlite"),
    join(restored, "worker.sqlite"),
  );
  const store = new WorkerStore({
    dataDir: restored,
    identity: f.chain.identity,
    policyVersion: "v1",
    create: false,
  });
  try {
    assert.equal(store.checkpoint().recovery_required, 1);
    const processor = new CrashSafeProcessor(store, f.chain.client);
    assert.equal((await processor.recover()).kind, "blocked");
  } finally {
    await store.close();
  }
});

test(
  "a real process kill at the send boundary recovers one original signed identity without rebroadcast",
  { timeout: 15000 },
  async (t) => {
    const f = await setup(t);
    await ready(f);
    await f.store.close();
    const modules = {
      store: new URL("../dist/private/storage/database.js", import.meta.url)
        .href,
      processor: new URL(
        "../dist/private/recovery/processor.js",
        import.meta.url,
      ).href,
      fixture: new URL("./chain-fixture.mjs", import.meta.url).href,
    };
    const code = [
      "import {WorkerStore} from " + JSON.stringify(modules.store) + ";",
      "import {CrashSafeProcessor} from " +
        JSON.stringify(modules.processor) +
        ";",
      "import {fixture,captured} from " + JSON.stringify(modules.fixture) + ";",
      'const chain=fixture({patch:(method,params,result)=>{if(method==="send_tx"){process.stdout.write("broadcast\\n");process.kill(process.pid,"SIGKILL");}return result;}});',
      "const store=new WorkerStore(" +
        JSON.stringify({
          dataDir: f.root,
          identity: f.chain.identity,
          policyVersion: "v1",
          create: false,
        }) +
        ");",
      'const verifier=async context=>({...context,journal:"current",fencing:"verified",providerHistory:"accounted",evidenceRef:"unit:verified-continuity"});',
      "const processor=new CrashSafeProcessor(store,chain.client,chain.adapter,verifier);await processor.recover();",
      "await processor.execute(" + JSON.stringify(proposal()) + ");",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    await closed;
    assert.match(output, /broadcast/, errors);
    await f.restart();
    assert.equal(f.store.getIntent("intent").status, "unknown");
    const hash = f.store.attempt("intent").tx_hash;
    f.publish();
    f.setReceipt(receiptFor(f));
    assert.equal((await f.processor.recover()).kind, "ready");
    assert.equal(f.store.getIntent("intent").status, "confirmed");
    assert.equal(f.store.attempt("intent").tx_hash, hash);
    assert.equal(f.submits, 0);
    assert.equal(f.chain.loads.length, 0);
  },
);
