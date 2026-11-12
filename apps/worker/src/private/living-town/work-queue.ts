import type { DatabaseSync } from "node:sqlite";
import { canonicalLivingTownJson } from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";
import type { TownWork } from "./town-executor.js";

export const townWorkQueueSchema = `
CREATE TABLE IF NOT EXISTS town_work_queue(
 id TEXT PRIMARY KEY, lane TEXT NOT NULL CHECK(lane IN ('rex','luna','bolt','operator')),
 tick TEXT NOT NULL, arrival TEXT NOT NULL, decision_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','executing','completed','failed','expired')),
 created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_maintenance_per_lane ON town_work_queue(lane)
 WHERE state IN ('queued','executing');
CREATE TRIGGER IF NOT EXISTS bound_town_work_queue BEFORE INSERT ON town_work_queue
 WHEN (SELECT count(*) FROM town_work_queue)>=10000 BEGIN SELECT RAISE(ABORT,'maintenance queue full'); END;
`;

/** This repository never signs. Its writes use the original witnessed journal. */
export class TownWorkQueue {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(fn: () => T) => T,
  ) {}

  enqueue(work: TownWork): boolean {
    return this.write(() => {
      if (
        this.db
          .prepare(
            "SELECT id FROM town_work_queue WHERE id=? OR (lane=? AND state IN ('queued','executing'))",
          )
          .get(work.id, work.lane)
      )
        return false;
      this.db
        .prepare(
          "INSERT INTO town_work_queue VALUES(?,?,?,?,?,'queued',?,NULL)",
        )
        .run(
          work.id,
          work.lane,
          work.tick,
          work.arrival,
          canonicalLivingTownJson(work.decision),
          Date.now(),
        );
      return true;
    });
  }

  get(id: string): TownWork | null {
    if (
      !this.db
        .prepare("SELECT name FROM sqlite_schema WHERE name='town_work_queue'")
        .get()
    )
      return null;
    const row = this.db
      .prepare("SELECT * FROM town_work_queue WHERE id=?")
      .get(id);
    return row
      ? {
          id: String(row["id"]),
          lane: row["lane"] as TownWork["lane"],
          tick: String(row["tick"]),
          arrival: String(row["arrival"]),
          decision: JSON.parse(String(row["decision_json"])),
        }
      : null;
  }

  next(): TownWork | null {
    const row = this.db
      .prepare(
        "SELECT id FROM town_work_queue WHERE state='queued' ORDER BY created_at,rowid LIMIT 1",
      )
      .get();
    return row ? this.get(String(row["id"])) : null;
  }

  bind(work: TownWork): void {
    const saved = this.get(work.id);
    requireStorage(
      saved && canonicalLivingTownJson(saved) === canonicalLivingTownJson({
        id: work.id, lane: work.lane, tick: work.tick, arrival: work.arrival, decision: work.decision,
      }),
      "original maintenance plan required",
    );
    const result = this.db
      .prepare(
        "UPDATE town_work_queue SET state='executing' WHERE id=? AND state='queued'",
      )
      .run(work.id);
    requireStorage(result.changes === 1, "maintenance work already claimed");
  }

  settled(id: string, state: string): void {
    if (
      !this.db
        .prepare("SELECT name FROM sqlite_schema WHERE name='town_work_queue'")
        .get()
    )
      return;
    this.db
      .prepare(
        "UPDATE town_work_queue SET state=?,finished_at=? WHERE id=? AND state='executing'",
      )
      .run(state, Date.now(), id);
  }

  expireUnstarted(id: string): void {
    this.write(() => {
      requireStorage(!this.db.prepare("SELECT id FROM jobs WHERE id=?").get(id), "started work must recover through its journal");
      this.db.prepare("UPDATE town_work_queue SET state='expired',finished_at=? WHERE id=? AND state='queued'").run(Date.now(), id);
    });
  }

  counts(): unknown {
    return this.db
      .prepare(
        "SELECT state,count(*) AS count FROM town_work_queue GROUP BY state",
      )
      .all();
  }
}
