import type { DatabaseSync } from "node:sqlite";
import { requireStorage } from "./validation.js";

export const unresolvedStatuses = "('prepared','signed','submitted','unknown')";

/** Common V1/V2 journal durability and OS fencing; no heartbeat takeover. */
export function configureJournal(db: DatabaseSync, fresh: boolean): void {
  db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000;");
  if (fresh) db.exec("PRAGMA auto_vacuum=INCREMENTAL");
  db.exec("BEGIN EXCLUSIVE; COMMIT;");
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
  );
  for (const [setting, expected] of [
    ["locking_mode", "exclusive"],
    ["journal_mode", "wal"],
    ["synchronous", 2],
    ["foreign_keys", 1],
    ["auto_vacuum", 2],
  ] as const)
    requireStorage(
      Object.values(db.prepare(`PRAGMA ${setting}`).get()!)[0] === expected,
      "journal durability setting did not take effect",
    );
}

/** Shared intent/attempt tables. Caller owns the enclosing durable transaction. */
export class RuntimeJournal {
  constructor(private readonly db: DatabaseSync) {}
  unresolved(): Record<string, string | number | bigint | Uint8Array | null>[] {
    return this.db
      .prepare(
        `SELECT intents.*,attempts.tx_hash,attempts.signed_json FROM intents LEFT JOIN attempts ON attempts.intent_id=intents.id WHERE status IN ${unresolvedStatuses} ORDER BY created_at,id LIMIT 4`,
      )
      .all();
  }
  insert(
    input: {
      id: string;
      jobId: string;
      decisionId?: string;
      lane: string;
      method: string;
      actionId: string | null;
      argsJson: string;
      digest: string;
      offerId: string | null;
    },
    now: number,
  ): void {
    this.db
      .prepare("INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)")
      .run(
        input.id,
        input.jobId,
        input.decisionId ?? null,
        input.lane,
        input.method,
        input.actionId,
        input.argsJson,
        input.digest,
        input.offerId,
        now,
        now,
      );
  }
  signed(
    intentId: string,
    signed: { hash: string; nonce: string; json: string },
    now: number,
  ): void {
    requireStorage(
      this.db.prepare("SELECT status FROM intents WHERE id=?").get(intentId)?.[
        "status"
      ] === "prepared",
      "prepared intent required",
    );
    this.db
      .prepare(
        "INSERT INTO attempts(intent_id,tx_hash,nonce,signed_json,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(intentId, signed.hash, signed.nonce, signed.json, now);
    this.db
      .prepare("UPDATE intents SET status='signed',updated_at=? WHERE id=?")
      .run(now, intentId);
  }
  broadcast(
    intentId: string,
    status: "submitted" | "unknown",
    now: number,
  ): void {
    const row = this.db
      .prepare("SELECT status FROM intents WHERE id=?")
      .get(intentId);
    requireStorage(
      ["submitted", "unknown"].includes(status) &&
        ["signed", "submitted", "unknown"].includes(String(row?.["status"])),
      "signed attempt required",
    );
    this.db
      .prepare("UPDATE intents SET status=?,updated_at=? WHERE id=?")
      .run(status, now, intentId);
  }
}
