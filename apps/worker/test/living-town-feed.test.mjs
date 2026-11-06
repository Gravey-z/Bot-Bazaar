import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { livingTownActivity, townActivityPosition } from "@bot-bazaar/chain";
import {
  TownActivityFeed,
  townFeedSchema,
} from "../dist/private/living-town/feed.js";
import { readAgentActivityInbox } from "../dist/private/living-town/config.js";
import {
  adapterFixture,
  closeAdapterFixturesAt,
} from "./fixtures/living-town-adapter.mjs";
import {
  projectionFixture,
  initial,
  final,
  basicIdentity,
  basicRecords,
  eventIdentity,
  eventCapture,
  eventRecords,
  eventBaseline,
  agent,
} from "./fixtures/living-town-feed.mjs";

test("verified sales stay unpublished until the durable projection covers their original effect; duplicate/restart never repeats them", (t) => {
  const f = projectionFixture(t),
    sale = basicRecords.find(
      (r) =>
        r.status.kind === "succeeded" &&
        r.status.result.data.outcome.kind === "raw_purchased",
    ),
    cursor = f.store.events().next_cursor;
  f.store.commit(sale);
  assert.equal(f.store.events(cursor).events.length, 0);
  f.reopen();
  assert.equal(f.store.events(cursor).events.length, 0);
  f.store.baseline(final, Date.now(), true);
  const page = f.store.events(cursor);
  assert.equal(page.events.length, 1);
  const event = page.events[0].event;
  assert.equal(event.type, "sale_confirmed");
  assert.equal(event.source, "confirmed");
  assert.equal(event.data.transaction_hash, sale.proof.transactionHash);
  assert.equal(f.store.commit(sale), "duplicate");
  assert.equal(f.store.events(page.next_cursor).events.length, 0);
  f.reopen();
  assert.equal(f.store.events(page.next_cursor).events.length, 0);
});
test("a publication fault rolls projection and activity back together and recovery publishes the original sale once", (t) => {
  const f = projectionFixture(t),
    sale = basicRecords.find(
      (r) =>
        r.status.kind === "succeeded" &&
        r.status.result.data.outcome.kind === "raw_purchased",
    );
  f.store.commit(sale);
  f.sql(
    "CREATE TRIGGER reject_feed BEFORE INSERT ON town_feed_entries BEGIN SELECT RAISE(ABORT,'controlled publication fault'); END;",
  );
  assert.throws(
    () => f.store.baseline(final, Date.now(), true),
    /controlled publication fault/,
  );
  assert.equal(f.store.town().snapshot.data.registered_player_count, "0");
  assert.equal(f.store.events().events.length, 0);
  f.sql("DROP TRIGGER reject_feed");
  f.store.baseline(final, Date.now(), true);
  assert.equal(f.store.events().events.length, 1);
});
test("cursor replay is generation/deployment-bound and bounded retention reports an explicit gap without forgetting event identities", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(townFeedSchema);
  const feed = new TownActivityFeed(db, basicIdentity, true),
    cursor = feed.page(null).next_cursor;
  const cp = {
    through_market_revision: "1",
    finalized_block_height: initial.town.block_height,
  };
  for (let n = 1; n <= 260; n++) {
    const a = agent();
    a.data.action_id = n.toString(16).padStart(64, "0");
    feed.agent(a);
    feed.flush(cp);
  }
  assert.equal(
    db.prepare("SELECT count(*) n FROM town_feed_entries").get().n,
    256,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM town_feed_keys").get().n,
    260,
  );
  assert.throws(
    () => feed.page(cursor),
    (e) => e.status === 410 && e.code === "feed_retention_gap",
  );
  const p = feed.page(null, 50);
  assert.equal(p.events.length, 50);
  assert.equal(p.has_more, true);
  assert(townActivityPosition(p.next_cursor).sequence > 0);
  const db2 = new DatabaseSync(":memory:");
  t.after(() => db2.close());
  db2.exec(townFeedSchema);
  const different = new TownActivityFeed(
    db2,
    { ...basicIdentity, codeHash: basicIdentity.deployment.genesis_hash },
    true,
  );
  assert.throws(
    () => different.page(p.next_cursor),
    (e) => e.status === 409 && e.code === "cursor_deployment_mismatch",
  );
  feed.reset();
  assert.throws(
    () => feed.page(p.next_cursor),
    (e) => e.status === 409 && e.code === "feed_generation_mismatch",
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM town_feed_keys").get().n,
    260,
  );
});
test("agent proposals expose bounded tick/signals/validation, but only verified matching receipts can produce confirmed outcomes", (t) => {
  const f = projectionFixture(t, eventIdentity, eventBaseline()),
    set = eventRecords.find(
      (r) => r.status.result.data.outcome.kind === "listing_set",
    );
  const a = agent(eventCapture.checkpoints[0].town);
  a.checkpoint.block_hash = eventCapture.checkpoints[0].block.header.hash;
  a.data.command_digest = set.status.result.data.payload_sha256;
  f.store.agentActivity([a]);
  const p = f.store.events();
  assert.equal(
    p.events.filter((r) => r.event.type === "agent_action").length,
    1,
  );
  assert.equal(p.events.at(-1).event.source, "deterministic_rule");
  f.store.commit(set);
  const confirmed = f.store
    .events()
    .events.find(
      (r) => r.event.type === "agent_action" && r.event.source === "confirmed",
    );
  assert(confirmed);
  assert.equal(confirmed.event.data.tick_id, a.data.tick_id);
  assert.equal(
    confirmed.event.data.transaction_hash,
    set.proof.transactionHash,
  );
  assert.throws(() =>
    f.store.agentActivity([
      {
        ...a,
        data: {
          ...a.data,
          outcome: "confirmed",
          transaction_hash: set.proof.transactionHash,
          receipt_id: set.status.executionReceiptId,
        },
      },
    ]),
  );
  assert.throws(() =>
    livingTownActivity({ ...confirmed.event, source: "model_proposal" }),
  );
  const late = projectionFixture(t, eventIdentity, eventBaseline());
  late.store.commit(set);
  late.reopen();
  late.store.agentActivity([a]);
  assert.equal(
    late.store.events().events.filter((r) => r.event.type === "agent_action")
      .length,
    0,
  );
  late.store.baseline(eventBaseline(), Date.now(), true);
  const recovered = late.store
    .events()
    .events.filter(
      (r) => r.event.type === "agent_action" && r.event.source === "confirmed",
    );
  assert.equal(recovered.length, 1);
  assert.equal(
    recovered[0].event.data.transaction_hash,
    set.proof.transactionHash,
  );
});
test("market boundaries observed after downtime stay observations with no fabricated hashes; readiness hints cannot claim settlement", (t) => {
  const f = projectionFixture(t, eventIdentity, eventBaseline());
  const events = f.store.events().events.map((r) => r.event);
  assert.deepEqual(
    events.map((e) => e.data.boundary),
    ["start", "end"],
  );
  assert(
    events.every(
      (e) =>
        e.source === "chain_boundary_observation" &&
        e.data.transaction_hash === null &&
        e.data.receipt_id === null,
    ),
  );
  f.reopen();
  f.store.baseline(eventBaseline(), Date.now(), true);
  assert.equal(f.store.events().events.length, 2);
  assert.throws(() =>
    livingTownActivity({
      ...events[0],
      data: { ...events[0].data, transaction_hash: eventIdentity.codeHash },
    }),
  );
});

test("commandless NPC completion uses its verified transaction and recipient, never a readiness hint or business-command checkpoint", (t) => {
  // Controlled verified-receipt boundary for the private feed unit; not another WASM receipt.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(townFeedSchema);
  const feed = new TownActivityFeed(db, basicIdentity, true),
    a = agent();
  a.data.merchant = "bolt";
  a.data.proposal_type = "restock";
  a.transaction_hint = basicIdentity.deployment.genesis_hash;
  const checkpoint = {
    through_market_revision: initial.town.market_revision,
    finalized_block_height: initial.town.block_height,
  };
  feed.agent(a);
  feed.flush(checkpoint);
  assert.equal(feed.page(null).events.length, 1);
  const completion = {
    proof: {
      transactionHash: a.transaction_hint,
      call: { method: "complete_production" },
    },
    status: {
      kind: "succeeded",
      executionReceiptId: basicIdentity.codeHash,
      block: initial.block,
      result: {
        data: {
          replayed: false,
          principal: null,
          payload_sha256: null,
          effect_revision: initial.town.market_revision,
          effect_event_sequence: initial.town.event_sequence,
          outcome: {
            kind: "production_completed",
            ledger: { actor: { kind: "merchant", merchant_id: "bolt" } },
          },
        },
      },
    },
  };
  feed.receipt(completion);
  feed.flush(checkpoint);
  const rows = feed.page(null).events;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].event.source, "confirmed");
  assert.equal(rows[1].event.data.command_digest, null);
  assert.equal(rows[1].event.data.transaction_hash, a.transaction_hint);
  assert(!("transaction_hint" in rows[1].event));
  feed.receipt(completion);
  feed.flush(checkpoint);
  assert.equal(feed.page(null).events.length, 2);
});
test("the real shared execution journal exports only bounded public correlation through an identity-pinned private inbox", async (t) => {
  const f = projectionFixture(t);
  const execution = await adapterFixture(f.dir);
  f.onClose(() => closeAdapterFixturesAt(f.dir));
  for (let n = 0; n < 8; n++) await execution.simulation.poll();
  const exported = execution.store.publicActivity();
  assert.equal(exported.records.length, 1);
  const a = exported.records[0];
  assert(a.data.signals.length > 0);
  assert.equal(a.source, "deterministic_rule");
  const raw = JSON.stringify(exported);
  for (const forbidden of [
    "signedTransactionBase64",
    "signed_json",
    "payload",
    "loadSecretKey",
    "provider_key",
    "messages",
  ])
    assert(!raw.includes(forbidden));
  const path = join(f.dir, "agent.json");
  writeFileSync(path, raw);
  assert.deepEqual(
    readAgentActivityInbox(path, exported.identity),
    exported.records,
  );
  assert.throws(() => readAgentActivityInbox(path, basicIdentity));
  execution.close();
});
