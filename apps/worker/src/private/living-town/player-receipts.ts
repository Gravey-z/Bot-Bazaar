import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalLivingTownJson, playerReceiptProof } from "@bot-bazaar/chain";
import type { LivingTownIdentity } from "@bot-bazaar/chain";
import type { LivingTownProjector } from "./projector.js";

export class PlayerReceiptError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
/** Separate, bounded hint queue. Only projector.ingest may authenticate effects. */
export class PlayerReceipts {
  private readonly db: DatabaseSync;
  constructor(
    directory: string,
    private readonly identity: LivingTownIdentity,
  ) {
    this.db = new DatabaseSync(join(directory, "player-receipts.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hints (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, created INTEGER NOT NULL);`);
    const encoded = canonicalLivingTownJson(identity);
    const row = this.db.prepare("SELECT value FROM identity").get();
    if (row && row["value"] !== encoded) {
      this.db.close();
      throw new Error("player receipt deployment mismatch");
    }
    if (!row) this.db.prepare("INSERT INTO identity VALUES (?)").run(encoded);
  }
  receive(value: unknown, now = Date.now()): { id: string; status: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.admit(value, now);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private admit(value: unknown, now: number): { id: string; status: string } {
    const proof = playerReceiptProof(value);
    if (
      canonicalLivingTownJson(proof.deployment) !==
      canonicalLivingTownJson(this.identity.deployment)
    )
      throw new PlayerReceiptError(409, "deployment_mismatch");
    if (
      [
        this.identity.ownerId,
        this.identity.operatorId,
        this.identity.deployment.contract_id,
        ...Object.values(this.identity.controllers),
      ].includes(proof.signerId)
    )
      throw new PlayerReceiptError(422, "player_signer_required");
    const body = canonicalLivingTownJson(proof);
    if (Buffer.byteLength(body) > 16384)
      throw new PlayerReceiptError(413, "proof_too_large");
    const id = createHash("sha256").update(body).digest("hex");
    const old = this.db.prepare("SELECT status FROM hints WHERE id=?").get(id);
    if (old) return { id, status: String(old["status"]) };
    // Terminal acknowledgements are a bounded cache; verified archives are permanent.
    this.db
      .prepare(
        `DELETE FROM hints WHERE id IN (SELECT id FROM hints
      WHERE status!='queued' ORDER BY created DESC LIMIT -1 OFFSET 512)`,
      )
      .run();
    const count = this.db
      .prepare("SELECT count(*) AS n FROM hints WHERE status='queued'")
      .get()!;
    if (Number(count["n"]) >= 128)
      throw new PlayerReceiptError(429, "proof_queue_full");
    this.db
      .prepare("INSERT INTO hints VALUES (?,?,'queued',0,?,?)")
      .run(id, body, now, now);
    return { id, status: "queued" };
  }
  /** Local operator import only; never exposed through HTTP. */
  requeueExpired(
    value: unknown,
    now = Date.now(),
  ): { id: string; status: string } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.admit(value, now);
      if (result.status === "expired") {
        const count = this.db
          .prepare("SELECT count(*) AS n FROM hints WHERE status='queued'")
          .get()!;
        if (Number(count["n"]) >= 128)
          throw new PlayerReceiptError(429, "proof_queue_full");
        this.db
          .prepare(
            "UPDATE hints SET status='queued',attempts=0,next_at=? WHERE id=?",
          )
          .run(now, result.id);
        result.status = "queued";
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async drain(
    projector: Pick<LivingTownProjector, "ingest">,
    now = Date.now(),
  ): Promise<void> {
    const rows = this.db
      .prepare(
        "SELECT * FROM hints WHERE status='queued' AND next_at<=? ORDER BY next_at,created LIMIT 3",
      )
      .all(now);
    for (const row of rows) {
      let status = "queued";
      try {
        const result = await projector.ingest(
          playerReceiptProof(JSON.parse(String(row["body"]))),
        );
        if (result !== "unresolved") status = "indexed";
      } catch (error) {
        if (error instanceof Error && error.name === "ChainValidationError")
          status = "rejected";
        else if (!(error instanceof Error) || error.name !== "ChainRpcError")
          throw error;
      }
      const attempts = Number(row["attempts"]) + 1;
      // Keep the original hash queued across downtime and RPC outages. A slow
      // unresolved transaction backs off without silently expiring its recovery.
      this.db
        .prepare("UPDATE hints SET status=?,attempts=?,next_at=? WHERE id=?")
        .run(
          status,
          attempts,
          now + Math.min(300000, 2500 * 2 ** Math.min(attempts - 1, 7)),
          String(row["id"]),
        );
    }
  }
  close(): void {
    this.db.close();
  }
}
