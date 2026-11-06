import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  TownMarketEventObserver,
  townMarketEventSchema,
} from "../dist/private/living-town/market-events.js";
import {
  adapterFixture,
  closeAdapterFixturesAt,
} from "./fixtures/living-town-adapter.mjs";
const f = JSON.parse(
    readFileSync(
      "tests/fixtures/chain/living-town-market-event-sandbox.json",
      "utf8",
    ),
  ),
  first = f.steps[0];
const identity = {
  deployment: first.foundation.deployment,
  codeHash: first.account.code_hash,
  ownerId: first.foundation.data.owner_account_id,
  operatorId: first.foundation.data.operator_account_id,
  controllers: first.foundation.data.merchant_controllers,
};
const handles = [];
function open(path) {
  const db = new DatabaseSync(path);
  handles.push({ db, path });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  if (
    !db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='town_market_observations'",
      )
      .get()
  )
    db.exec(townMarketEventSchema);
  const write = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  return { db, observer: new TownMarketEventObserver(db, write, identity) };
}
const observe = (o, c) =>
  o.observe(
    c.town,
    c.events,
    {
      hash: c.block.header.hash,
      height: String(c.block.header.height),
      timestampNs: c.block.header.timestamp_nanosec,
    },
    identity.codeHash,
  );
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-event-"));
  t.after(() => {
    for (const h of handles)
      if (h.path.startsWith(dir + sep) && h.db.isOpen) h.db.close();
    closeAdapterFixturesAt(dir);
    assert(dir.startsWith(join(tmpdir(), "bazaar-event-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
test("finalized start/end observations persist once across restart without transaction/receipt claims", (t) => {
  const dir = temporary(t),
    path = join(dir, "observations.sqlite");
  let { db, observer } = open(path);
  observe(observer, f.checkpoints[0]);
  assert.equal(observer.list().length, 0);
  observe(observer, f.checkpoints[1]);
  const original = observer.list();
  assert.equal(original.length, 1);
  assert.equal(original[0].boundary, "start");
  observe(observer, f.checkpoints[1]);
  assert.deepEqual(observer.list(), original);
  db.close();
  ({ db, observer } = open(path));
  t.after(() => {
    if (db.isOpen) db.close();
  });
  observe(observer, f.checkpoints.at(-1));
  observe(observer, f.checkpoints.at(-1));
  const rows = observer.list();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.boundary),
    ["start", "end"],
  );
  assert.deepEqual(rows[0], original[0]);
  for (const row of rows) {
    assert.equal(row.source, "chain_boundary_observation");
    assert.equal(row.checkpoint.codeHash, identity.codeHash);
    assert.equal(row.transactionHash, undefined);
    assert.equal(row.receiptId, undefined);
  }
});
test("recovery after both boundaries were missed records delayed observations without reissuing supply", (t) => {
  const { db, observer } = open(join(temporary(t), "late.sqlite"));
  t.after(() => {
    if (db.isOpen) db.close();
  });
  observe(observer, f.checkpoints.at(-1));
  const rows = observer.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].delayed, true);
  assert.equal(rows[0].observedEpoch, rows[1].observedEpoch);
  assert.equal(
    rows[0].checkpoint.block.hash,
    f.checkpoints.at(-1).block.header.hash,
  );
});
test("mixed/reversed checkpoints and a pruned unobserved boundary fail atomically", (t) => {
  const { db, observer } = open(join(temporary(t), "invalid.sqlite"));
  t.after(() => {
    if (db.isOpen) db.close();
  });
  const c = structuredClone(f.checkpoints[1]);
  c.events.market_revision = String(BigInt(c.events.market_revision) + 1n);
  assert.throws(() => observe(observer, c));
  assert.equal(observer.list().length, 0);
  observe(observer, f.checkpoints.at(-1));
  const before = observer.list();
  assert.throws(() => observe(observer, f.checkpoints[0]));
  assert.deepEqual(observer.list(), before);
  const changed = structuredClone(f.checkpoints.at(-1));
  for (const e of [
    changed.town.data.market_event,
    changed.events.data.items[0],
  ]) {
    e.start_epoch = String(BigInt(e.start_epoch) + 1n);
    e.end_epoch = String(BigInt(e.end_epoch) + 1n);
  }
  assert.throws(() => observe(observer, changed));
  assert.deepEqual(observer.list(), before);
  const wrongEpoch = structuredClone(f.checkpoints.at(-1));
  wrongEpoch.town.data.epoch = "10000";
  assert.throws(() => observe(observer, wrongEpoch));
  assert.deepEqual(observer.list(), before);
  const { db: other, observer: missing } = open(
    join(temporary(t), "gap.sqlite"),
  );
  t.after(() => {
    if (other.isOpen) other.close();
  });
  const gap = structuredClone(f.checkpoints.at(-1));
  gap.events.data.pruned_through = "1";
  gap.events.data.items[0].event_id = "2";
  gap.town.data.market_event.event_id = "2";
  gap.town.data.next_market_event_id = "3";
  assert.throws(() => observe(missing, gap));
  assert.equal(missing.list().length, 0);
});
test("the shared simulation poll observes boundaries through its current finalized reader", async (t) => {
  const a = await adapterFixture(temporary(t));
  t.after(() => a.close());
  const current = BigInt(a.state.town.data.epoch),
    event = {
      event_id: "1",
      definition_id: "herb_shortage_v1",
      start_epoch: String(current + 1n),
      end_epoch: String(current + 6n),
      herb_supply_ceiling: "4",
      revision: a.state.town.market_revision,
    };
  a.state.town.data.market_event = event;
  a.state.town.data.next_market_event_id = "2";
  await a.simulation.poll();
  assert.equal(a.store.marketEvents.list().length, 0);
  // Controlled finalized time advances; this is not another real chain receipt.
  a.state.town.data.epoch = event.end_epoch;
  a.state.town.data.customer_pool.epoch = event.end_epoch;
  a.state.town.block_timestamp_ns = (
    BigInt(a.state.town.data.genesis_time_ns) +
    BigInt(event.end_epoch) * 60000000000n +
    1000000000n
  ).toString();
  a.state.town.block_height = String(
    BigInt(a.state.town.block_height) + 10000n,
  );
  await a.simulation.poll();
  assert.equal(a.store.marketEvents.list().length, 2);
});
