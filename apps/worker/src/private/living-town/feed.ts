import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  canonicalLivingTownJson,
  livingTownActivity,
  livingTownActivityPage,
  townAgentInput,
  townActivityCursor,
} from "@bot-bazaar/chain";
import type {
  LivingTownIdentity,
  TownActivity,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
  livingTownTown,
  livingTownProductionJob,
  livingTownCheckpoint,
} from "@bot-bazaar/chain";
import { ReadApiError } from "../activity/repository.js";
import { requireStorage, sha256 } from "../storage/validation.js";
type Indexed = NonNullable<
  | ReturnType<typeof livingTownIndexedReceipt>
  | ReturnType<typeof livingTownIndexedCompletion>
>;
type Town = ReturnType<typeof livingTownTown>;
type Checkpoint = ReturnType<typeof livingTownCheckpoint>;
type Agent = ReturnType<typeof townAgentInput>;
export const townFeedSchema = `
CREATE TABLE town_feed_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL,sequence INTEGER NOT NULL) STRICT;
CREATE TABLE town_feed_keys(id TEXT PRIMARY KEY) STRICT;
CREATE TRIGGER bound_town_feed_keys BEFORE INSERT ON town_feed_keys WHEN (SELECT count(*) FROM town_feed_keys)>=10000 BEGIN SELECT RAISE(ABORT,'activity identity journal full'); END;
CREATE TABLE town_feed_entries(sequence INTEGER PRIMARY KEY,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=16384)) STRICT;
CREATE TABLE town_feed_pending(id TEXT PRIMARY KEY,revision TEXT NOT NULL,height TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=16384)) STRICT;
CREATE TRIGGER bound_town_feed_pending BEFORE INSERT ON town_feed_pending WHEN NOT EXISTS(SELECT 1 FROM town_feed_pending WHERE id=NEW.id) AND (SELECT count(*) FROM town_feed_pending)>=512 BEGIN SELECT RAISE(ABORT,'activity projection backlog full'); END;
CREATE TABLE town_feed_agents(id TEXT PRIMARY KEY,digest TEXT,transaction_hint TEXT,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=16384)) STRICT;
CREATE INDEX town_feed_agent_digest ON town_feed_agents(digest);
CREATE INDEX town_feed_agent_transaction ON town_feed_agents(transaction_hint);
CREATE TRIGGER bound_town_feed_agents BEFORE INSERT ON town_feed_agents WHEN NOT EXISTS(SELECT 1 FROM town_feed_agents WHERE id=NEW.id) AND (SELECT count(*) FROM town_feed_agents)>=10000 BEGIN SELECT RAISE(ABORT,'agent correlation full'); END;
CREATE TABLE town_feed_settlements(digest TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=16384)) STRICT;
CREATE TRIGGER bound_town_feed_settlements BEFORE INSERT ON town_feed_settlements WHEN NOT EXISTS(SELECT 1 FROM town_feed_settlements WHERE digest=NEW.digest) AND (SELECT count(*) FROM town_feed_settlements)>=10000 BEGIN SELECT RAISE(ABORT,'settlement correlation full'); END;
`;
const json = canonicalLivingTownJson;
/** All writes run inside the projection transaction; readers see only committed entries. */
export class TownActivityFeed {
  private readonly identityHash: string;
  constructor(
    private readonly db: DatabaseSync,
    private readonly identity: LivingTownIdentity,
    initialize = false,
  ) {
    this.identityHash = sha256(json(identity));
    if (!this.db.prepare("SELECT generation FROM town_feed_meta").get()) {
      requireStorage(initialize, "activity metadata missing");
      this.db
        .prepare("INSERT INTO town_feed_meta VALUES(1,?,0)")
        .run(randomUUID());
    }
    requireStorage(
      Number(this.meta()["sequence"]) ===
        Number(
          this.db.prepare("SELECT count(*) n FROM town_feed_keys").get()!["n"],
        ),
      "activity continuity mismatch",
    );
  }
  private meta() {
    return this.db
      .prepare("SELECT generation,sequence FROM town_feed_meta")
      .get()!;
  }
  reset(): void {
    this.db.prepare("UPDATE town_feed_meta SET generation=?").run(randomUUID());
    this.db.exec("DELETE FROM town_feed_entries");
  }
  private cursor(sequence: number): string {
    return Buffer.from(
      JSON.stringify({
        generation: this.meta()["generation"],
        identity: this.identityHash,
        sequence,
      }),
    ).toString("base64url");
  }
  page(
    after: string | null,
    limit = 50,
  ): ReturnType<typeof livingTownActivityPage> {
    requireStorage(
      Number.isInteger(limit) && limit >= 1 && limit <= 50,
      "invalid activity page bound",
    );
    const meta = this.meta(),
      head = Number(meta["sequence"]),
      min = Number(
        this.db
          .prepare("SELECT min(sequence) AS n FROM town_feed_entries")
          .get()!["n"] ?? head + 1,
      );
    let seq = min - 1;
    if (after !== null) {
      try {
        townActivityCursor(after);
        requireStorage(
          Buffer.from(after, "base64url").toString("base64url") === after,
          "noncanonical cursor",
        );
        const c = JSON.parse(
          Buffer.from(after, "base64url").toString("utf8"),
        ) as { generation: string; identity: string; sequence: number };
        requireStorage(
          Object.keys(c).sort().join() === "generation,identity,sequence" &&
            Number.isSafeInteger(c.sequence) &&
            c.sequence >= 0,
          "invalid cursor",
        );
        if (c.identity !== this.identityHash)
          throw new ReadApiError(409, "cursor_deployment_mismatch");
        if (c.generation !== meta["generation"])
          throw new ReadApiError(409, "feed_generation_mismatch");
        if (c.sequence < min - 1)
          throw new ReadApiError(410, "feed_retention_gap");
        if (c.sequence > head)
          throw new ReadApiError(410, "feed_retention_gap");
        seq = c.sequence;
      } catch (e) {
        if (e instanceof ReadApiError) throw e;
        throw new ReadApiError(400, "invalid_cursor");
      }
    }
    const rows = this.db
        .prepare(
          "SELECT sequence,body FROM town_feed_entries WHERE sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(seq, limit + 1),
      hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((r) => ({
      cursor: this.cursor(Number(r["sequence"])),
      event: livingTownActivity(JSON.parse(String(r["body"]))),
    }));
    return livingTownActivityPage({
      schema: "living-town-activity-v1",
      deployment: this.identity.deployment,
      code_hash: this.identity.codeHash,
      feed_generation: meta["generation"],
      events: entries,
      next_cursor: entries.at(-1)?.cursor ?? this.cursor(seq),
      has_more: hasMore,
    });
  }
  private event(
    type: TownActivity["type"],
    key: string,
    source: TownActivity["source"],
    checkpoint: unknown,
    data: unknown,
  ): TownActivity {
    return livingTownActivity({
      event_id: sha256(json([this.identityHash, type, key])),
      type,
      source,
      checkpoint,
      data,
    });
  }
  private queue(event: TownActivity): void {
    if (
      this.db
        .prepare("SELECT id FROM town_feed_keys WHERE id=?")
        .get(event.event_id)
    )
      return;
    this.db
      .prepare("INSERT OR IGNORE INTO town_feed_pending VALUES(?,?,?,?)")
      .run(
        event.event_id,
        event.checkpoint.market_revision,
        event.checkpoint.block_height,
        json(event),
      );
  }
  flush(checkpoint: Checkpoint): void {
    for (const row of this.db
      .prepare(
        "SELECT * FROM town_feed_pending ORDER BY length(revision),revision,length(height),height,rowid",
      )
      .all()) {
      if (
        BigInt(String(row["revision"])) >
          BigInt(checkpoint.through_market_revision) ||
        BigInt(String(row["height"])) >
          BigInt(checkpoint.finalized_block_height)
      )
        continue;
      const id = String(row["id"]);
      if (
        !this.db.prepare("SELECT id FROM town_feed_keys WHERE id=?").get(id)
      ) {
        this.db.prepare("INSERT INTO town_feed_keys VALUES(?)").run(id);
        this.db.exec("UPDATE town_feed_meta SET sequence=sequence+1");
        this.db
          .prepare("INSERT INTO town_feed_entries VALUES(?,?)")
          .run(this.meta()["sequence"]!, row["body"]!);
        this.db.exec(
          "DELETE FROM town_feed_entries WHERE sequence <= (SELECT sequence-256 FROM town_feed_meta)",
        );
      }
      this.db.prepare("DELETE FROM town_feed_pending WHERE id=?").run(id);
    }
  }
  agent(value: unknown): void {
    const a = townAgentInput(value);
    requireStorage(
      a.data.outcome !== "confirmed" &&
        a.data.transaction_hash === null &&
        a.data.receipt_id === null,
      "simulation cannot claim settlement",
    );
    const old = this.db
      .prepare("SELECT body FROM town_feed_agents WHERE id=?")
      .get(a.data.action_id);
    if (old) {
      const o = townAgentInput(JSON.parse(String(old["body"])));
      requireStorage(
        o.source === a.source &&
          o.data.tick_id === a.data.tick_id &&
          o.data.merchant === a.data.merchant &&
          o.data.proposal_type === a.data.proposal_type &&
          o.data.reason === a.data.reason &&
          o.data.validation === a.data.validation &&
          json(o.data.signals) === json(a.data.signals) &&
          o.data.command_digest === a.data.command_digest,
        "agent correlation changed",
      );
      requireStorage(
        o.transaction_hint === null ||
          o.transaction_hint === a.transaction_hint,
        "agent transaction correlation changed",
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO town_feed_agents VALUES(?,?,?,?)")
      .run(
        a.data.action_id,
        a.data.command_digest,
        a.transaction_hint,
        json(a),
      );
    this.queue(
      this.event(
        "agent_action",
        `${a.data.action_id}:${a.data.outcome}`,
        a.source,
        a.checkpoint,
        a.data,
      ),
    );
    if (a.data.command_digest) {
      const s = this.db
        .prepare("SELECT body FROM town_feed_settlements WHERE digest=?")
        .get(a.data.command_digest);
      if (s) this.confirm(a, JSON.parse(String(s["body"])) as Settlement);
    }
    if (a.transaction_hint) {
      const s = this.db
        .prepare("SELECT body FROM town_feed_settlements WHERE digest=?")
        .get(`tx:${a.transaction_hint}`);
      if (s) this.confirm(a, JSON.parse(String(s["body"])) as Settlement);
    }
  }
  private confirm(agent: Agent, s: Settlement): void {
    if (s.principal !== `merchant:${agent.data.merchant}`)
      throw new Error("agent settlement principal mismatch");
    const permitted =
      agent.data.proposal_type === "adjust_price"
        ? ["set_listing"]
        : agent.data.proposal_type === "restock"
          ? ["set_listing", "start_production", "complete_production"]
          : [];
    requireStorage(
      permitted.includes(s.method) &&
        (s.method !== "complete_production" ||
          agent.transaction_hint === s.hash),
      "agent settlement method/transaction mismatch",
    );
    this.queue(
      this.event(
        "agent_action",
        `${agent.data.action_id}:confirmed`,
        "confirmed",
        s.checkpoint,
        {
          ...agent.data,
          outcome: "confirmed",
          transaction_hash: s.hash,
          receipt_id: s.receipt,
        },
      ),
    );
  }
  receipt(indexed: Indexed): void {
    const status = indexed.status;
    if (status.kind !== "succeeded" || status.result.data.replayed) return;
    const result = status.result,
      o = result.data.outcome,
      cp = {
        block_hash: status.block.hash,
        block_height: status.block.height,
        block_timestamp_ns: status.block.timestampNs,
        market_revision: result.data.effect_revision,
        event_sequence: result.data.effect_event_sequence,
      },
      hash = indexed.proof.transactionHash,
      receipt = status.executionReceiptId;
    if (o.kind === "raw_purchased" || o.kind === "customer_sale") {
      const t = o.trade;
      this.queue(
        this.event(
          "sale_confirmed",
          result.data.effect_event_sequence,
          "confirmed",
          cp,
          {
            trade_id: t.trade_id,
            listing_id: t.listing_id,
            item_id: t.item_id,
            quantity: t.quantity,
            total_price: t.total_price,
            transaction_hash: hash,
            receipt_id: receipt,
            effect_event_sequence: result.data.effect_event_sequence,
          },
        ),
      );
    }
    if (o.kind === "market_event_scheduled")
      this.queue(
        this.event(
          "market_event",
          `${o.event.event_id}:scheduled`,
          "confirmed",
          cp,
          {
            event: o.event,
            boundary: "scheduled",
            observed_epoch: (BigInt(o.event.start_epoch) - 1n).toString(),
            delayed: false,
            transaction_hash: hash,
            receipt_id: receipt,
          },
        ),
      );
    const principal =
      result.data.principal ??
      (o.kind === "production_completed" && o.ledger.actor.kind === "merchant"
        ? `merchant:${o.ledger.actor.merchant_id}`
        : null);
    if (
      principal !== null &&
      (result.data.payload_sha256 !== null || o.kind === "production_completed")
    ) {
      const s: Settlement = {
        principal,
        method: indexed.proof.call.method,
        checkpoint: cp,
        hash,
        receipt,
      };
      this.db
        .prepare("INSERT OR IGNORE INTO town_feed_settlements VALUES(?,?)")
        .run(result.data.payload_sha256 ?? `tx:${hash}`, json(s));
      for (const row of this.db
        .prepare(
          "SELECT body FROM town_feed_agents WHERE digest=? OR transaction_hint=?",
        )
        .all(result.data.payload_sha256, hash)) {
        const a = townAgentInput(JSON.parse(String(row["body"])));
        if (
          result.data.payload_sha256 !== null
            ? a.data.command_digest === result.data.payload_sha256
            : a.transaction_hint === hash
        )
          this.confirm(a, s);
      }
    }
  }
  observe(
    town: Town,
    checkpoint: Checkpoint,
    timestamp: string,
    jobs: ReturnType<typeof livingTownProductionJob>[],
    events: NonNullable<Town["market_event"]>[],
  ): void {
    const cp = {
      block_hash: checkpoint.finalized_block_hash,
      block_height: checkpoint.finalized_block_height,
      block_timestamp_ns: timestamp,
      market_revision: checkpoint.through_market_revision,
      event_sequence: checkpoint.through_event_sequence,
    };
    for (const e of events)
      for (const boundary of ["start", "end"] as const) {
        const epoch = boundary === "start" ? e.start_epoch : e.end_epoch;
        if (BigInt(town.epoch) >= BigInt(epoch))
          this.queue(
            this.event(
              "market_event",
              `${e.event_id}:${boundary}`,
              "chain_boundary_observation",
              cp,
              {
                event: e,
                boundary,
                observed_epoch: town.epoch,
                delayed: BigInt(town.epoch) > BigInt(epoch),
                transaction_hash: null,
                receipt_id: null,
              },
            ),
          );
      }
    for (const job of jobs)
      if (
        job.status !== "completed" &&
        BigInt(timestamp) >= BigInt(job.ready_at_ns)
      )
        this.queue(
          this.event(
            "production_ready",
            job.job_id,
            "production_ready_hint",
            cp,
            {
              job_id: job.job_id,
              shop_id: job.shop_id,
              recipe_id: job.recipe_id,
              ready_at_ns: job.ready_at_ns,
            },
          ),
        );
    this.flush(checkpoint);
  }
}
interface Settlement {
  principal: string;
  method: string;
  checkpoint: {
    block_hash: string;
    block_height: string;
    block_timestamp_ns: string;
    market_revision: string;
    event_sequence: string;
  };
  hash: string;
  receipt: string;
}
