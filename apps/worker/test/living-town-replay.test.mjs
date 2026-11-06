import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  replaySimulation,
  fingerprint,
  replayEpochs,
} from "./fixtures/living-town-replay.mjs";
import {
  adapterFixture,
  closeAdapterFixturesAt,
  identity,
} from "./fixtures/living-town-adapter.mjs";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import {
  final,
  basicIdentity,
  basicRecords,
  projectionFixture,
} from "./fixtures/living-town-feed.mjs";
const projectionStores = new Map();
const recorded = JSON.parse(
  readFileSync(
    "tests/fixtures/simulation/living-town-recorded-replay.json",
    "utf8",
  ),
);
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-replay-"));
  t.after(() => {
    for (const store of projectionStores.get(dir) ?? []) store.close();
    projectionStores.delete(dir);
    closeAdapterFixturesAt(dir);
    assert(dir.startsWith(join(tmpdir(), "bazaar-replay-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("same seed/config/event sequence and recorded outputs replay identical worker commands, economic state and observations across restart", async (t) => {
  assert.equal(
    recorded.config_sha256,
    fingerprint(JSON.parse(readFileSync("config/living-town-v1.json", "utf8"))),
  );
  assert.equal(
    recorded.source_capture_sha256,
    fingerprint(
      JSON.parse(
        readFileSync(
          "tests/fixtures/chain/living-town-races-sandbox.json",
          "utf8",
        ),
      ),
    ),
  );
  assert.deepEqual(recorded.epochs, replayEpochs);
  const first = await replaySimulation(directory(t), {
    tape: recorded.outputs,
    seed: recorded.seed,
  });
  const replay = await replaySimulation(directory(t), {
    tape: first.tape,
    restart: true,
  });
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.digest, first.digest);
  assert.equal(first.digest, recorded.expected.digest);
  assert.deepEqual(first.result.epochs[0].town.market_event, recorded.event);
  assert.equal(first.tape.length, 21);
  assert.equal(first.report.missedEpochs, "9999");
  assert.deepEqual(
    first.result.boundaries.map((b) => b.boundary),
    ["start", "end"],
  );
  const types = new Set(first.tape.map((e) => e.output.action.type));
  for (const type of [
    "restock",
    "adjust_price",
    "propose_trade",
    "accept_trade",
    "reject_trade",
    "wait",
  ])
    assert(types.has(type));
  t.diagnostic("P49_REPLAY_REPORT=" + JSON.stringify(first.report));
});
test("replay rejects a changed seed or corrupted recorded output instead of claiming deterministic equivalence", async (t) => {
  await assert.rejects(
    replaySimulation(directory(t), { tape: recorded.outputs, seed: "43" }),
    /replay context changed/,
  );
  const broken = structuredClone(recorded.outputs);
  broken[0].output.action.method = "allocate_raw_supply";
  await assert.rejects(
    replaySimulation(directory(t), { tape: broken }),
    /proposal|fields|action/i,
  );
});
test("actual competing execution/projection processes cannot acquire the same physical journals", async (t) => {
  const dir = directory(t),
    execution = await adapterFixture(dir);
  t.after(() => execution.close());
  const code = `import {LivingTownExecutionStore} from './apps/worker/dist/private/living-town/execution-store.js';try{new LivingTownExecutionStore(process.argv[1],JSON.parse(process.argv[2]),'42');process.exit(99)}catch(e){if(!/locked|busy/i.test(String(e)))throw e;process.exit(17)}`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code, dir, JSON.stringify(identity)],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(child.status, 17, child.stderr);
  assert.equal(execution.stats.sign, 0);
  assert.equal(execution.stats.send, 0);
  const projected = projectionFixture(t),
    other = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {LivingTownProjectionStore} from './apps/worker/dist/private/living-town/store.js';try{new LivingTownProjectionStore(process.argv[1],JSON.parse(process.argv[2]));process.exit(99)}catch(e){if(!/locked|busy/i.test(String(e)))throw e;process.exit(17)}`,
        projected.dir,
        JSON.stringify(basicIdentity),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
  assert.equal(other.status, 17, other.stderr);
  assert.equal(projected.store.events().events.length, 0);
});
for (const point of [
  "before_projection_commit",
  "after_projection_commit",
  "before_broadcast",
  "after_broadcast",
])
  test(`actual process death ${point} retains original receipt/projection/outbox identity and resumable delivery`, (t) => {
    const dir = directory(t),
      child = spawnSync(
        process.execPath,
        [
          "apps/worker/test/fixtures/living-town-projection-crash.mjs",
          dir,
          point,
        ],
        { encoding: "utf8", timeout: 20000 },
      );
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0, child.stderr);
    assert.notEqual(child.status, 99, child.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "crash-marker.json"), "utf8")),
      { point },
    );
    assert.equal(
      existsSync(join(dir, "graceful-exit.json")),
      false,
      "expected process death, not a normal error exit",
    );
    const store = new LivingTownProjectionStore(dir, basicIdentity);
    projectionStores.set(dir, [store]);
    t.after(() => store.close());
    const sale = basicRecords.find(
      (r) =>
        r.status.kind === "succeeded" &&
        r.status.result.data.outcome.kind === "raw_purchased",
    );
    assert.equal(
      store.events().events.length,
      point === "before_projection_commit" ? 0 : 1,
    );
    store.baseline(final, Date.now(), true);
    const page = store.events(),
      events = page.events.filter((r) => r.event.type === "sale_confirmed");
    assert.equal(events.length, 1);
    assert.equal(
      events[0].event.data.transaction_hash,
      sale.proof.transactionHash,
    );
    assert.equal(store.commit(sale), "duplicate");
    if (point === "after_broadcast") {
      const ack = JSON.parse(
        readFileSync(join(dir, "client-ack.json"), "utf8"),
      );
      assert.equal(ack.event.event_id, events[0].event.event_id);
      assert.equal(store.events(ack.cursor).events.length, 0);
    }
    assert.equal(
      store.town().snapshot.data.registered_player_count,
      final.town.data.registered_player_count,
    );
    store.close();
  });
