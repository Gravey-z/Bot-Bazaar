import type { DatabaseSync } from "node:sqlite";
import {
  canonicalLivingTownJson,
  decodeLivingTownSnapshot,
  livingTownMarketEventHistory,
  livingTownTown,
} from "@bot-bazaar/chain";
import type { FinalizedBlock, LivingTownIdentity } from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";

export const townMarketEventSchema = `
CREATE TABLE town_market_observations(event_id TEXT NOT NULL,boundary TEXT NOT NULL CHECK(boundary IN ('start','end')),body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),PRIMARY KEY(event_id,boundary)) STRICT;
CREATE TRIGGER bound_town_market_observations BEFORE INSERT ON town_market_observations WHEN (SELECT count(*) FROM town_market_observations)>=10000 BEGIN SELECT RAISE(ABORT,'market observation journal full'); END;
CREATE TABLE town_market_checkpoint(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL) STRICT;
`;
/** Finalized observations, never synthetic chain transactions or confirmation receipts. */
export class TownMarketEventObserver {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(fn: () => T) => T,
    private readonly identity: LivingTownIdentity,
  ) {}
  list(): unknown[] {
    return this.db
      .prepare(
        "SELECT body FROM town_market_observations ORDER BY length(event_id),event_id,CASE boundary WHEN 'start' THEN 0 ELSE 1 END",
      )
      .all()
      .map((r) => JSON.parse(String(r["body"])) as unknown);
  }
  observe(
    town: unknown,
    history: unknown,
    block: FinalizedBlock,
    codeHash: string,
  ): void {
    const t = decodeLivingTownSnapshot(
        town,
        this.identity.deployment,
        livingTownTown,
      ),
      h = decodeLivingTownSnapshot(
        history,
        this.identity.deployment,
        livingTownMarketEventHistory,
      );
    requireStorage(
      codeHash === this.identity.codeHash &&
        t.block_height === block.height &&
        t.block_timestamp_ns === block.timestampNs &&
        t.block_height === h.block_height &&
        t.block_timestamp_ns === h.block_timestamp_ns &&
        t.market_revision === h.market_revision &&
        t.event_sequence === h.event_sequence,
      "market boundary checkpoint mismatch",
    );
    requireStorage(
      BigInt(t.block_timestamp_ns) >= BigInt(t.data.genesis_time_ns) &&
        (BigInt(t.block_timestamp_ns) - BigInt(t.data.genesis_time_ns)) /
          60000000000n ===
          BigInt(t.data.epoch),
      "market epoch checkpoint mismatch",
    );
    requireStorage(
      h.data.items.every(
        (e) => BigInt(e.revision) <= BigInt(t.market_revision),
      ),
      "future market definition",
    );
    const last = h.data.items.at(-1);
    requireStorage(
      canonicalLivingTownJson(last ?? null) ===
        canonicalLivingTownJson(t.data.market_event),
      "market history/town mismatch",
    );
    this.write(() => {
      const previous = this.db
        .prepare("SELECT body FROM town_market_checkpoint")
        .get();
      if (previous) {
        const p = JSON.parse(String(previous["body"])) as {
          height: string;
          time: string;
          revision: string;
          hash: string;
        };
        requireStorage(
          BigInt(block.height) >= BigInt(p.height) &&
            BigInt(block.timestampNs) >= BigInt(p.time) &&
            BigInt(t.market_revision) >= BigInt(p.revision) &&
            (block.height !== p.height || block.hash === p.hash),
          "market observation rollback",
        );
      }
      if (h.data.pruned_through !== "0")
        requireStorage(
          this.db
            .prepare(
              "SELECT event_id FROM town_market_observations WHERE event_id=? AND boundary='end'",
            )
            .get(h.data.pruned_through),
          "market boundary history gap",
        );
      for (const event of h.data.items)
        for (const boundary of ["start", "end"] as const) {
          const old = this.db
            .prepare(
              "SELECT body FROM town_market_observations WHERE event_id=? LIMIT 1",
            )
            .get(event.event_id);
          if (old)
            requireStorage(
              canonicalLivingTownJson(
                (JSON.parse(String(old["body"])) as { event: unknown }).event,
              ) === canonicalLivingTownJson(event),
              "market definition changed",
            );
          const epoch =
            boundary === "start" ? event.start_epoch : event.end_epoch;
          if (BigInt(t.data.epoch) < BigInt(epoch)) continue;
          const body = canonicalLivingTownJson({
            source: "chain_boundary_observation",
            event,
            boundary,
            boundaryEpoch: epoch,
            observedEpoch: t.data.epoch,
            delayed: BigInt(t.data.epoch) > BigInt(epoch),
            checkpoint: {
              deployment: this.identity.deployment,
              codeHash,
              block,
              marketRevision: t.market_revision,
              eventSequence: t.event_sequence,
            },
          });
          this.db
            .prepare(
              "INSERT OR IGNORE INTO town_market_observations VALUES(?,?,?)",
            )
            .run(event.event_id, boundary, body);
        }
      this.db
        .prepare("INSERT OR REPLACE INTO town_market_checkpoint VALUES(1,?)")
        .run(
          canonicalLivingTownJson({
            height: block.height,
            time: block.timestampNs,
            revision: t.market_revision,
            hash: block.hash,
          }),
        );
    });
  }
}
