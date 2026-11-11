import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, realpathSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { BudgetRepository } from "../policy/budget.js";
import { policySchema } from "../storage/schema.js";
import { requireStorage, sha256 } from "../storage/validation.js";

/** One project authority, independent of deployments and API keys. Never initialize on restart. */
export class RuntimeBudget {
  readonly budget: BudgetRepository;
  private readonly db: DatabaseSync;
  private readonly witness: DatabaseSync;
  private readonly session = randomUUID();
  readonly binding: { projectId: string; laneId: string; ledgerId: string };
  constructor(directory: string, witnessDirectory: string, create = false) {
    const file = join(directory, "shared-inference.sqlite"),
      witnessFile = join(witnessDirectory, "inference-continuity.sqlite");
    requireStorage(
      create
        ? !existsSync(file) && !existsSync(witnessFile)
        : existsSync(file) && existsSync(witnessFile),
      "explicit existing shared inference ledger and witness required",
    );
    if (create) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      mkdirSync(witnessDirectory, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(file);
    this.witness = new DatabaseSync(witnessFile);
    try {
      for (const path of [file, witnessFile]) chmodSync(path, 0o600);
      for (const db of [this.db, this.witness])
        db.exec(
          "PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        );
      let witnessing = !create;
      this.budget = new BudgetRepository(
        this.db,
        (fn) => {
          if (witnessing) this.verify();
          this.db.exec("BEGIN IMMEDIATE");
          let result;
          try {
            result = fn();
            this.db.exec("COMMIT");
          } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
          }
          if (witnessing) this.checkpoint();
          return result;
        },
        () => this.session,
        "bot-bazaar-shared-project",
        {
          dailyMicro: 2000000,
          monthlyMicro: 10000000,
          lifetimeMicro: 10000000,
          lifetimeOnly: true,
        },
      );
      if (create) {
        this.db.exec(
          policySchema.slice(
            0,
            policySchema.indexOf("CREATE TABLE policy_plans"),
          ),
        );
        this.db.exec(
          "CREATE TABLE inference_receipts(request_id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;",
        );
        this.budget.configure({
          projectId: "bot-bazaar",
          laneId: "shared",
          portions: [
            { laneId: "shared", dailyMicro: 2000000, monthlyMicro: 10000000 },
          ],
        });
        this.witness.exec(
          "CREATE TABLE witness(singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding TEXT NOT NULL,state TEXT NOT NULL) STRICT;",
        );
        this.witness
          .prepare("INSERT INTO witness VALUES(1,?,?)")
          .run(this.hostBinding(directory), this.digest());
      }
      requireStorage(
        this.witness.prepare("SELECT binding FROM witness").get()?.[
          "binding"
        ] === this.hostBinding(directory),
        "shared budget host/path changed; fence and reconcile before moving",
      );
      witnessing = true;
      this.verify();
      this.binding = {
        projectId: "bot-bazaar",
        laneId: "shared",
        ledgerId: this.budget.context().ledgerId,
      };
      // Unknown billing keeps its entire original reservation. Never release it on timeout/restart.
      this.budget.reconcile({
        ...this.budget.context(),
        fencing: "verified",
        history: "accounted",
        evidenceRef: `budget-witness:${this.digest()}`,
      });
    } catch (error) {
      this.db.close();
      this.witness.close();
      throw error;
    }
  }
  private hostBinding(directory: string): string {
    return JSON.stringify({
      host: hostname(),
      path: realpathSync(directory),
      project: "bot-bazaar",
    });
  }
  useHackathonBudget(): void {
    this.verify();
    const before = this.budget.history().config;
    this.budget.reallocate(
      {
        projectId: "bot-bazaar",
        laneId: "shared",
        portions: [
          { laneId: "shared", dailyMicro: 2000000, monthlyMicro: 10000000 },
        ],
      },
      "owner:hackathon-10-usd-2026-11-08",
    );
    this.record(`budget-policy:${randomUUID()}`, {
      kind: "owner_budget_revision",
      at: Date.now(),
      before,
      after: this.budget.history().config,
      total_limit_micro: 10000000,
      ledger_id: this.binding.ledgerId,
    });
  }
  private digest(): string {
    return sha256(
      JSON.stringify([
        this.db.prepare("SELECT * FROM usage_state").all(),
        this.db
          .prepare("SELECT * FROM inference_usage ORDER BY request_id")
          .all(),
        this.db
          .prepare("SELECT * FROM inference_receipts ORDER BY request_id")
          .all(),
      ]),
    );
  }
  verify(): void {
    requireStorage(
      this.witness.prepare("SELECT state FROM witness").get()?.["state"] ===
        this.digest(),
      "shared budget journal/witness mismatch",
    );
  }
  private checkpoint(): void {
    this.witness
      .prepare("UPDATE witness SET state=? WHERE singleton=1")
      .run(this.digest());
  }
  record(requestId: string, value: unknown): void {
    this.verify();
    this.db
      .prepare("INSERT INTO inference_receipts VALUES(?,?)")
      .run(requestId, JSON.stringify(value));
    this.checkpoint();
  }
  receipt(requestId: string): unknown {
    const row = this.db
      .prepare("SELECT body FROM inference_receipts WHERE request_id=?")
      .get(requestId);
    return row ? JSON.parse(String(row["body"])) : null;
  }
  recordBilling(
    requestId: string,
    inferenceId: string,
    costNanoUsd: number,
  ): void {
    this.verify();
    const old = this.receipt(requestId) as Record<string, unknown> | null;
    requireStorage(
      old &&
        old["inference_id"] === inferenceId &&
        Number.isSafeInteger(costNanoUsd) &&
        costNanoUsd >= 0,
      "billing receipt identity mismatch",
    );
    this.db
      .prepare("UPDATE inference_receipts SET body=? WHERE request_id=?")
      .run(
        JSON.stringify({
          ...old,
          billing: { inference_id: inferenceId, cost_nano_usd: costNanoUsd },
        }),
        requestId,
      );
    this.checkpoint();
  }
  verifyAttempts(
    attempts: { id: string; ledger_id: string | null; status: string }[],
  ): void {
    this.verify();
    const usage = new Map(
      this.budget.history().entries.map((r) => [r.request_id, r]),
    );
    for (const attempt of attempts) {
      requireStorage(
        attempt.ledger_id === this.binding.ledgerId,
        "foreign provider budget history",
      );
      if (
        attempt.status === "reserved" ||
        attempt.status === "dispatched" ||
        attempt.status === "accepted"
      )
        requireStorage(
          usage.has(attempt.id),
          "provider attempt missing protected budget reservation",
        );
    }
  }
  close(): void {
    this.db.close();
    this.witness.close();
  }
}
