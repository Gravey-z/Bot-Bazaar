import { TownWorkQueue, townWorkQueueSchema } from "./work-queue.js";
import {
  townMarketEventSchema,
  TownMarketEventObserver,
} from "./market-events.js";
import { TownOfferRepository, townOfferSchema } from "./offer-store.js";
import { TownReactionRepository, reactionSchema } from "./reactions.js";
import {
  livingTownOfferEffect,
  isLivingTownOfferMethod,
} from "@bot-bazaar/chain";
import {
  townProviderSchema,
  TownProviderRepository,
} from "./provider-store.js";
import { townCall, readTownPrepared } from "./town-chain.js";
import type { TownCall, PreparedTownCall } from "./town-chain.js";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalLivingTownJson,
  townAgentInput,
  parseLivingTownIdentity,
  livingTownCustomerEffect,
  livingTownSourceEffect,
  livingTownProductionEffect,
  livingTownPurchaseEffect,
  livingTownListingEffect,
  livingTownAssistantRepriceEffect,
  livingTownProductionJob,
  livingTownLedger,
  parseU64,
} from "@bot-bazaar/chain";
import { schema } from "../storage/schema.js";
import {
  configureJournal,
  RuntimeJournal,
  unresolvedStatuses,
} from "../storage/journal.js";
import { id, json, requireStorage, sha256 } from "../storage/validation.js";
import { readCustomerPrepared, customerCall } from "./customer-chain.js";
import type { PreparedCustomerCall, CustomerCall } from "./customer-chain.js";
import { tickSchema, TownTickRepository } from "./ticks.js";
import {
  isVerifiedAdmissionRejection,
  isVerifiedExpiredUnappliedCommand,
  isVerifiedMerchantBatchCommand,
  isVerifiedExpiredTownCommand
} from "./admission-rejection.js";

import type {
  ExpiredAdmissionRejection,
  ExpiredUnappliedCommand,
  ExpiredMerchantBatchCommand,
  ExpiredTownCommand
} from "./admission-rejection.js";

export const townLanes = ["rex", "luna", "bolt", "operator"] as const;
export type TownLane = (typeof townLanes)[number];
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface CustomerAction {
  id: string;
  tick: string;
  arrival: string;
  decision: unknown;
  call: CustomerCall | null;
  digest: string | null;
}
// The same journal schema/indexes as V1, with V2's fourth actor and customer methods.
const townJournalSchema = schema
  .replace(
    "merchant_id IN ('rex','luna','bolt')",
    "merchant_id IN ('rex','luna','bolt','operator')",
  )
  .replace(
    "'cancel_trade','expire_offers'))",
    "'cancel_trade','expire_offers','batch_set_listings','reject_trade','fund_customer_budget','settle_customer_purchase','start_production','complete_production','allocate_raw_supply','sweep_merchant_treasury','assistant_reprice','merchant_purchase'))",
  );

/** One exclusive execution database for all V2 actors; never a customer-only side journal. */
export class LivingTownExecutionStore {
  readonly maintenance: TownWorkQueue;
  readonly reactions: TownReactionRepository;
  readonly merchantTrading: boolean;
  readonly negotiatedTrading: boolean;
  readonly offers: TownOfferRepository;
  private readonly db: DatabaseSync;
  private readonly journal: RuntimeJournal;
  readonly ticks: TownTickRepository;
  readonly providerAttempts: TownProviderRepository;
  readonly marketEvents: TownMarketEventObserver;
  readonly identity: ReturnType<typeof parseLivingTownIdentity>;
  readonly path: string;
  readonly sessionId = randomUUID();
  readonly identityHash: string;
  private stopped = false;
  private ready = false;
  private mutationObserver?: () => void;
  constructor(
    readonly dataDir: string,
    identity: unknown,
    readonly seed: string,
    create = false,
    deferProviderRecovery = false,
  ) {
    const parsedIdentity = parseLivingTownIdentity(identity);
    this.identity = Object.freeze({
      ...parsedIdentity,
      deployment: Object.freeze(parsedIdentity.deployment),
      controllers: Object.freeze(parsedIdentity.controllers),
    });
    parseU64(seed);
    const identityJson = canonicalLivingTownJson(this.identity);
    this.identityHash = sha256(identityJson);
    requireStorage(
      isAbsolute(dataDir) &&
        lstatSync(dataDir).isDirectory() &&
        !lstatSync(dataDir).isSymbolicLink(),
      "absolute local journal directory required",
    );
    this.path = join(realpathSync(dataDir), "worker.sqlite");
    const fresh = !existsSync(this.path);
    requireStorage(
      !fresh || create,
      "explicit V2 execution journal initialization required",
    );
    if (fresh) closeSync(openSync(this.path, "wx", 0o600));
    requireStorage(
      lstatSync(this.path).isFile() && !lstatSync(this.path).isSymbolicLink(),
      "regular execution database required",
    );
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path, {
      timeout: 1000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      configureJournal(this.db, fresh);
      if (fresh) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(
            townJournalSchema +
              tickSchema +
              townProviderSchema +
              townMarketEventSchema +
              townOfferSchema +
              reactionSchema +
              `
            CREATE TABLE town_runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1), seed TEXT NOT NULL, epoch TEXT, next_arrival INTEGER NOT NULL DEFAULT 0 CHECK(next_arrival BETWEEN 0 AND 4)) STRICT;
            CREATE TABLE customer_actions(id TEXT PRIMARY KEY REFERENCES jobs(id), tick TEXT NOT NULL, arrival TEXT NOT NULL, decision_json TEXT NOT NULL CHECK(length(CAST(decision_json AS BLOB))<=65536), UNIQUE(tick,arrival)) STRICT;
            CREATE TRIGGER bound_customer_actions BEFORE INSERT ON customer_actions WHEN (SELECT count(*) FROM customer_actions)>=10000 BEGIN SELECT RAISE(ABORT,'customer action journal full'); END;
            PRAGMA user_version=1009;`,
          );
          this.db
            .prepare(
              "INSERT INTO deployment(singleton,identity,policy_version,feed_generation,created_at) VALUES(1,?,'living-town-demand-v1',?,?)",
            )
            .run(identityJson, this.sessionId, Date.now());
          this.db
            .prepare("INSERT INTO town_runtime(singleton,seed) VALUES(1,?)")
            .run(seed);
          for (const lane of townLanes)
            this.db
              .prepare(
                "INSERT INTO merchants(merchant_id,controller_id) VALUES(?,?)",
              )
              .run(
                lane,
                lane === "operator"
                  ? this.identity.operatorId
                  : this.identity.controllers[lane],
              );
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      const schemaVersion = this.db.prepare("PRAGMA user_version").get()?.[
        "user_version"
      ];
      this.merchantTrading = schemaVersion === 1008 || schemaVersion === 1009;
      this.negotiatedTrading =
        schemaVersion === 1009 && this.identity.deployment.state_schema === "2";
      requireStorage(
        (schemaVersion === 1007 ||
          schemaVersion === 1008 ||
          schemaVersion === 1009) &&
          this.db.prepare("SELECT identity FROM deployment").get()?.[
            "identity"
          ] === identityJson &&
          this.db.prepare("SELECT seed FROM town_runtime").get()?.["seed"] ===
            seed,
        "execution identity/schema/seed mismatch; do not recreate journal",
      );
      requireStorage(
        Object.values(this.db.prepare("PRAGMA quick_check").get()!)[0] ===
          "ok" &&
          this.db.prepare("PRAGMA foreign_key_check").all().length === 0,
        "execution journal integrity failure",
      );
      // In-place migration of the provider admission index only. Existing
      // transaction evidence and unresolved provider reservations are retained.
      if (this.negotiatedTrading) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(`
            DROP INDEX IF EXISTS one_town_provider_pending;
            CREATE UNIQUE INDEX one_town_provider_pending
              ON town_provider_attempts(merchant)
              WHERE status IN ('prepared','reserved','dispatched');
          `);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      this.db
        .prepare("UPDATE deployment SET feed_generation=?,recovery_required=1")
        .run(this.sessionId);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.maintenance = new TownWorkQueue(this.db, fn => this.write(fn));
    this.journal = new RuntimeJournal(this.db);
    this.providerAttempts = new TownProviderRepository(
      this.db,
      (fn) => this.write(fn),
      this.sessionId,
      deferProviderRecovery,
    );
    this.marketEvents = new TownMarketEventObserver(
      this.db,
      (fn) => {
        this.gate();
        return this.write(fn);
      },
      this.identity,
    );
    this.offers = new TownOfferRepository(
      this.db,
      this.negotiatedTrading,
      (fn) => this.write(fn),
    );
    this.reactions = new TownReactionRepository(
      this.db,
      (fn) => this.write(fn),
      () => this.gate(),
      this.identity.deployment,
    );
    this.ticks = new TownTickRepository(
      this.db,
      (fn) => this.write(fn),
      () => this.gate(),
      this.identity,
      this.seed,
    );
  }
  private write<T>(fn: () => T): T {
    requireStorage(!this.stopped, "execution journal unavailable");
    const disk = statfsSync(this.dataDir);
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix))
        bytes += statSync(this.path + suffix).size;
    requireStorage(
      disk.bavail * disk.bsize >= 16 * 1024 * 1024 && bytes < 0.9 * 2 ** 31,
      "execution storage headroom exhausted",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.mutationObserver?.();
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* fail closed */
      }
      this.ready = false;
      throw error;
    }
  }
  /** Preserve all signed work and row identities while widening the method constraint. */
  enableBatchListings(): void {
    const row = this.db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='intents'",
      )
      .get();
    const sql = String(row?.["sql"] ?? "");
    if (sql.includes("'batch_set_listings'")) return;
    requireStorage(
      !!this.mutationObserver &&
        sql.includes("'set_listing'") &&
        /^CREATE TABLE intents\s*\(/i.test(sql),
      "verified execution witness and known intent schema required for migration",
    );
    const objects = this.db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name='intents' AND type IN ('index','trigger') AND sql IS NOT NULL",
      )
      .all();
    const columns = this.db
      .prepare("PRAGMA table_info(intents)")
      .all()
      .map((c) => String(c["name"]));
    requireStorage(
      columns.every((c) => /^[a-z_]+$/.test(c)),
      "unexpected intent columns",
    );
    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      this.write(() => {
        this.db.exec(
          sql
            .replace(
              /^CREATE TABLE intents/i,
              "CREATE TABLE intents_batch_migration",
            )
            .replace("'set_listing'", "'set_listing','batch_set_listings'"),
        );
        const names = ["rowid", ...columns].join(",");
        this.db.exec(
          `INSERT INTO intents_batch_migration(${names}) SELECT ${names} FROM intents`,
        );
        this.db.exec(
          "DROP TABLE intents; ALTER TABLE intents_batch_migration RENAME TO intents",
        );
        for (const object of objects) this.db.exec(String(object["sql"]));
        requireStorage(
          this.db.prepare("PRAGMA foreign_key_check").all().length === 0,
          "batch migration foreign key check failed",
        );
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
  }
  enableIndependentWorkers(): void {
    requireStorage(!!this.mutationObserver, "verified witness required for worker migration");
    if (this.db.prepare("SELECT name FROM sqlite_schema WHERE name='one_active_reaction_per_merchant'").get() &&
      this.db.prepare("SELECT name FROM sqlite_schema WHERE name='town_work_queue'").get() &&
      String(this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='one_town_provider_pending'").get()?.["sql"]).includes("(merchant)")) return;
    this.write(() => {
      this.db.exec(townWorkQueueSchema);
      this.db.exec("DROP INDEX IF EXISTS one_active_reaction; CREATE UNIQUE INDEX IF NOT EXISTS one_active_reaction_per_merchant ON reaction_roots(merchant) WHERE state='active'");
      this.db.exec("DROP INDEX IF EXISTS one_town_provider_pending; CREATE UNIQUE INDEX one_town_provider_pending ON town_provider_attempts(merchant) WHERE status IN ('prepared','reserved','dispatched')");
    });
  }
  get planningReady(): boolean { return this.ready && !this.stopped; }
  gate(): void {
    requireStorage(
      this.ready && !this.stopped,
      "verified V2 recovery required",
    );
  }
  invalidate(): void {
    this.ready = false;
  }
  /** Private executable continuity seam; called after durable commits, before callers may sign/send. */
  observeMutations(observer: () => void): void {
    requireStorage(
      !this.mutationObserver,
      "execution witness already attached",
    );
    this.mutationObserver = observer;
  }
  continuityDigest(): string {
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const state = tables.map((t) => {
      const name = String(t["name"]);
      requireStorage(/^[a-z_]+$/.test(name), "unexpected execution table");
      const rows = this.db
        .prepare(`SELECT * FROM ${name} ORDER BY rowid`)
        .all();
      if (name === "deployment")
        for (const row of rows) {
          delete row["feed_generation"];
          delete row["recovery_required"];
        }
      return [name, rows];
    });
    return sha256(JSON.stringify(state));
  }
  rulesOnlyHistory(): boolean {
    return (
      this.db.prepare("SELECT count(*) n FROM town_provider_attempts").get()![
        "n"
      ] === 0
    );
  }
  providerHistory(): {
    id: string;
    ledger_id: string | null;
    status: string;
  }[] {
    return this.db
      .prepare(
        "SELECT id,ledger_id,status FROM town_provider_attempts ORDER BY rowid",
      )
      .all() as { id: string; ledger_id: string | null; status: string }[];
  }
  latestModelAction(): unknown {
    return (
      this.db
        .prepare(
          "SELECT c.id AS action_id,i.status,i.method,a.tx_hash AS transaction_hash,json_extract(c.decision_json,'$.inferenceRef') AS inference_ref FROM customer_actions c JOIN intents i ON i.id=c.id LEFT JOIN attempts a ON a.intent_id=i.id WHERE json_extract(c.decision_json,'$.origin')='model_proposal' ORDER BY c.rowid DESC LIMIT 1",
        )
        .get() ?? null
    );
  }
  merchantPricingHistory(): { merchant: "rex" | "luna" | "bolt"; item: "crystal" | "wood" | "herb" | "iron"; unitPrice: string; changedAtNs: string }[] {
    const history = new Map<string, ReturnType<LivingTownExecutionStore["merchantPricingHistory"]>[number]>();
    const rows = this.db.prepare(`SELECT i.merchant_id,a.signed_json,a.evidence_json,a.updated_at
      FROM attempts a JOIN intents i ON i.id=a.intent_id
      WHERE i.status='confirmed' AND i.method IN ('set_listing','batch_set_listings') AND i.merchant_id IN ('rex','luna','bolt')
      ORDER BY a.rowid`).all();
    for (const row of rows) {
      const prepared = JSON.parse(String(row["signed_json"])) as PreparedTownCall;
      const call = townCall(prepared.call.method, prepared.call.args, String(row["merchant_id"]) as TownLane);
      const updates = call.method === "batch_set_listings" && "updates" in call.args ? call.args.updates
        : call.method === "set_listing" && "item_id" in call.args ? [call.args] : [];
      for (const args of updates) {
        if (!("unit_price" in args)) continue;
        const item = args.item_id;
        if (item !== "crystal" && item !== "wood" && item !== "herb" && item !== "iron") continue;
        const merchant = String(row["merchant_id"]) as "rex" | "luna" | "bolt";
        const key = `${merchant}:${item}`, previous = history.get(key);
        if (previous?.unitPrice === args.unit_price) continue;
        const evidence = JSON.parse(String(row["evidence_json"])) as {
          result?: { block_timestamp_ns?: string }; command?: { block_timestamp_ns?: string } };
        const changedAtNs = evidence.result?.block_timestamp_ns ?? evidence.command?.block_timestamp_ns ??
          (BigInt(Number(row["updated_at"])) * 1000000n).toString();
        history.set(key, { merchant, item, unitPrice: args.unit_price, changedAtNs });
      }
    }
    return [...history.values()];
  }
  receiptProofs(): {
    transaction_hash: string;
    signer_id: string;
    method: string;
    args: unknown;
    reference_block_height: string;
    gas?: string;
  }[] {
    return this.db
      .prepare(
        "SELECT a.signed_json FROM attempts a JOIN intents i ON i.id=a.intent_id WHERE i.status IN ('submitted','unknown','confirmed','failed') AND coalesce(json_extract(a.evidence_json,'$.kind'),'') NOT IN ('expired_admission_rejection','expired_unapplied_command','expired_unapplied_merchant_batch','expired_unapplied_town_command') ORDER BY a.rowid",
      )
      .all()
      .map((row) => {
        const p = JSON.parse(String(row["signed_json"])) as PreparedTownCall;
        return {
          transaction_hash: p.transactionHash,
          signer_id: p.signerId,
          method: p.call.method,
          args: p.call.args,
          reference_block_height: p.referenceBlockHeight,
          ...(p.gas !== "100000000000000" ? { gas: p.gas } : {}),
        };
      });
  }
  resolveRejectedAdmission(
    actionId: string,
    evidence: ExpiredAdmissionRejection,
  ): void {
    requireStorage(
      isVerifiedAdmissionRejection(evidence),
      "verified expired admission rejection required",
    );
    this.write(() => {
      const row = this.get(actionId);
      requireStorage(
        row?.["status"] === "unknown" &&
          row["tx_hash"] === evidence.transactionHash,
        "original unknown transaction required",
      );
      this.db
        .prepare(
          "UPDATE attempts SET evidence_json=?,updated_at=? WHERE intent_id=?",
        )
        .run(json(evidence), Date.now(), actionId);
      this.db
        .prepare("UPDATE intents SET status='failed',updated_at=? WHERE id=?")
        .run(Date.now(), actionId);
      this.terminal(actionId, "failed");
    });
  }

retireExpiredTownCommand(
  actionId: string,
  evidence: ExpiredTownCommand,
): void {
  requireStorage(
    isVerifiedExpiredTownCommand(evidence),
    "verified town expiration evidence required",
  );

  this.write(() => {
    const row = this.get(actionId);

    requireStorage(
      row?.["status"] === "unknown" &&
        row["lane"] === evidence.lane &&
        row["method"] === evidence.method &&
        row["action_id"] === evidence.sequence &&
        row["tx_hash"] === evidence.transactionHash,
      "matching unknown town transaction required",
    );

    const now = Date.now();

    this.db.prepare(`
      UPDATE attempts
      SET evidence_json = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(
      json(evidence),
      now,
      actionId,
    );

    this.db.prepare(`
      UPDATE intents
      SET status = 'failed', updated_at = ?
      WHERE id = ?
    `).run(
      now,
      actionId,
    );

    this.terminal(actionId, "failed");
  });
}

  retireExpiredMerchantBatch(
  actionId: string,
  evidence: ExpiredMerchantBatchCommand,
): void {
  requireStorage(
    isVerifiedMerchantBatchCommand(evidence),
    "verified merchant expiration evidence required",
  );

  this.write(() => {
    const row = this.get(actionId);

    requireStorage(
      row?.["status"] === "unknown" &&
        row["lane"] === evidence.merchant &&
        row["method"] === "batch_set_listings" &&
        row["action_id"] === evidence.sequence &&
        row["tx_hash"] === evidence.transactionHash,
      "original unknown merchant batch required",
    );

    this.db.prepare(`
      UPDATE attempts
      SET evidence_json = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(
      json(evidence),
      Date.now(),
      actionId,
    );

    this.db.prepare(`
      UPDATE intents
      SET status = 'failed', updated_at = ?
      WHERE id = ?
    `).run(
      Date.now(),
      actionId,
    );

    this.terminal(actionId, "failed");
  });
}
  retireExpiredUnappliedCommand(
  actionId: string,
  evidence: ExpiredUnappliedCommand
): void {
  requireStorage(
    isVerifiedExpiredUnappliedCommand(evidence),
    "verified expiration evidence required"
  );

  this.write(() => {
    const row = this.get(actionId);

    requireStorage(
  row?.["status"] === "unknown" &&
    row["lane"] === "operator" &&
    row["method"] === "allocate_raw_supply" &&
    row["action_id"] === evidence.sequence &&
    row["tx_hash"] === evidence.transactionHash,
  "original unknown operator action required"
);

    this.db.prepare(`
      UPDATE attempts
      SET evidence_json = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(
      json(evidence),
      Date.now(),
      actionId
    );

    this.db.prepare(`
      UPDATE intents
      SET status = 'failed', updated_at = ?
      WHERE id = ?
    `).run(
      Date.now(),
      actionId
    );

    this.terminal(actionId, "failed");
  });
}
  rejectedAdmissions(): string[] {
  return this.db
    .prepare(
      "SELECT tx_hash FROM attempts WHERE json_extract(evidence_json,'$.kind') IN ('expired_admission_rejection','expired_unapplied_command','expired_unapplied_merchant_batch','expired_unapplied_town_command') ORDER BY rowid",
    )
    .all()
    .map((r) => String(r["tx_hash"]));
}
  lastCustomerDecision(): unknown {
    const row = this.db
      .prepare(
        "SELECT c.id,c.tick,c.decision_json FROM customer_actions c WHERE c.arrival IN ('0','1','2','3') ORDER BY c.rowid DESC LIMIT 1",
      )
      .get();
    if (!row) return null;
    const decision = JSON.parse(String(row["decision_json"])) as Record<
      string,
      unknown
    >;
    return {
      action_id: row["id"],
      tick: row["tick"],
      kind: decision["kind"],
      reason: decision["reason"],
      item: decision["itemId"],
    };
  }
  lastCompletedTurnWasCustomer(): boolean {
    const row = this.db.prepare(
      "SELECT c.arrival FROM customer_actions c JOIN jobs j ON j.id=c.id WHERE j.status IN ('completed','failed','expired') ORDER BY c.rowid DESC LIMIT 1",
    ).get();
    return !!row && /^[0-3]$/.test(String(row["arrival"]));
  }
  publicActivity(
    after: string | null = null,
    limit = 100,
  ): {
    schema: string;
    identity: ReturnType<typeof parseLivingTownIdentity>;
    records: ReturnType<typeof townAgentInput>[];
    next_after: string | null;
  } {
    requireStorage(
      !this.stopped && Number.isInteger(limit) && limit >= 1 && limit <= 100,
      "invalid activity export",
    );
    const cursor = after === null ? 0 : Number(parseU64(after));
    requireStorage(
      Number.isSafeInteger(cursor),
      "invalid activity export cursor",
    );
    const rows = this.db
      .prepare(
        "SELECT c.rowid AS n,c.id,c.decision_json,COALESCE(ta.tick_id,rs.id) AS tick_id,c.arrival,t.checkpoint_json,j.status AS job_status,i.status,i.method,i.args_digest,i.offer_id,a.tx_hash FROM customer_actions c LEFT JOIN town_tick_actions ta ON ta.action_id=c.id LEFT JOIN town_ticks t ON t.id=ta.tick_id LEFT JOIN reaction_steps rs ON rs.id=c.id JOIN jobs j ON j.id=c.id LEFT JOIN intents i ON i.id=c.id LEFT JOIN attempts a ON a.intent_id=i.id WHERE c.rowid>? AND c.arrival LIKE 'merchant:%' AND (t.id IS NOT NULL OR json_extract(c.decision_json,'$.checkpoint') IS NOT NULL) ORDER BY c.rowid LIMIT ?",
      )
      .all(cursor, limit + 1);
    const records = rows.slice(0, limit).map((r) => {
      const d = JSON.parse(String(r["decision_json"])) as Record<
          string,
          unknown
        >,
        original = JSON.parse(String(r["checkpoint_json"])) as {
          block: { hash: string; height: string; timestampNs: string };
          town: { market_revision: string; event_sequence: string };
        },
        p = d["proposal"] as
          { action: { type: string }; reason: string } | undefined;
      return townAgentInput({
        transaction_hint: r["tx_hash"] ?? null,
        source:
          d["origin"] === "model_proposal"
            ? "model_proposal"
            : "deterministic_rule",
        checkpoint: d["checkpoint"] ?? {
          block_hash: original.block.hash,
          block_height: original.block.height,
          block_timestamp_ns: original.block.timestampNs,
          market_revision: original.town.market_revision,
          event_sequence: original.town.event_sequence,
        },
        data: {
          action_id: r["id"],
          tick_id: r["tick_id"],
          merchant: String(r["arrival"]).split(":")[1],
          offer_id:
            r["offer_id"] ??
            (
              d["tradeApproval"] as
                { offer?: { offer_id?: string } } | undefined
            )?.offer?.offer_id ??
            null,
          proposal_type: p?.action.type ?? "wait",
          reason: p?.reason ?? String(d["reason"] ?? "deterministic no-op"),
          validation: d["validation"] ?? d["reason"] ?? "no_op",
          outcome:
            r["job_status"] === "expired"
              ? "expired"
              : r["job_status"] === "failed"
                ? "rejected"
                : r["status"] === "unknown"
                  ? "unknown"
                  : r["status"] === "submitted"
                    ? "submitted"
                    : ["prepared", "signed"].includes(String(r["status"]))
                      ? "proposal"
                      : r["status"] !== null
                        ? "awaiting_confirmation"
                        : "local_no_op",
          command_digest:
            r["method"] === "complete_production"
              ? null
              : (r["args_digest"] ?? null),
          inference_ref: d["inferenceRef"] ?? null,
          signals: d["signals"] ?? [],
          transaction_hash: null,
          receipt_id: null,
        },
      });
    });
    if (rows.length <= limit) {
      for (const pending of this.db
        .prepare(
          "SELECT * FROM town_provider_attempts WHERE status='dispatched'",
        )
        .all()) {
        const c = JSON.parse(String(pending.context_json)) as {
          tickId: string;
          merchant: string;
          checkpoint: unknown;
        };
        if (!c.checkpoint) continue;
        records.push(
          townAgentInput({
            source: "model_proposal",
            transaction_hint: null,
            checkpoint: c.checkpoint,
            data: {
              action_id: sha256(String(pending.id) + ":thinking"),
              tick_id: c.tickId,
              merchant: c.merchant,
              proposal_type: "wait",
              reason: "Considering current stock and trade options.",
              validation: "provider_pending",
              outcome: "thinking",
              command_digest: null,
              inference_ref: pending.id,
              signals: [],
              transaction_hash: null,
              receipt_id: null,
            },
          }),
        );
      }
    }
    return {
      schema: "living-town-agent-inbox-v1",
      identity: this.identity,
      records,
      next_after: rows.length > limit ? String(rows[limit - 1]!["n"]) : null,
    };
  }
  get(actionId: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT j.status AS job_status,c.*,i.merchant_id AS lane,i.method,i.args_json,i.args_digest,i.status,i.action_id,i.offer_id,a.tx_hash,a.signed_json FROM customer_actions c JOIN jobs j ON j.id=c.id LEFT JOIN intents i ON i.id=c.id LEFT JOIN attempts a ON a.intent_id=i.id WHERE c.id=?",
      )
      .get(id(actionId));
  }
  /** Private owner audit only; never exported through public merchant activity. */
  assistantAudit(shop: string): Row[] {
    requireStorage(
      /^[1-9][0-9]{0,3}$/.test(shop) &&
        BigInt(shop) >= 4n &&
        BigInt(shop) <= 1003n,
      "invalid assistant shop",
    );
    return this.db
      .prepare(
        "SELECT c.*,j.status AS job_status,j.created_at,max(j.updated_at,coalesce(i.updated_at,0),coalesce(a.updated_at,0)) AS updated_at,i.method,i.status,a.tx_hash,a.evidence_json FROM customer_actions c JOIN jobs j ON j.id=c.id LEFT JOIN intents i ON i.id=c.id LEFT JOIN attempts a ON a.intent_id=i.id WHERE c.arrival=? ORDER BY c.rowid DESC LIMIT 32",
      )
      .all(`assistant:${shop}`);
  }
  unresolved(): Row[] {
    return this.journal.unresolved();
  }
  checkpoint(lane: TownLane): Row {
    requireStorage(townLanes.includes(lane), "unknown runtime lane");
    return this.db
      .prepare("SELECT * FROM merchants WHERE merchant_id=?")
      .get(lane)!;
  }
  recovered(
    checkpoints: Record<TownLane, { sequence: string; digest: string | null }>,
  ): void {
    this.write(() => {
      requireStorage(
        this.unresolved().length === 0,
        "unresolved journal work blocks recovery",
      );
      for (const lane of townLanes) {
        const current = checkpoints[lane],
          old = this.checkpoint(lane);
        parseU64(current.sequence);
        requireStorage(
          old["last_action_id"] === null
            ? current.sequence === "0"
            : current.sequence === old["last_action_id"] &&
                current.digest === old["last_action_digest"],
          "unexplained runtime command high-water",
        );
        this.db
          .prepare(
            "UPDATE merchants SET last_action_id=?,last_action_digest=? WHERE merchant_id=?",
          )
          .run(current.sequence, current.digest, lane);
      }
      this.db.exec("UPDATE deployment SET recovery_required=0");
    });
    this.ready = true;
  }
  /** Shared admission seam for merchant turns and operator actions. */
  claimRuntimeJob(
    jobId: string,
    lanes: readonly TownLane[],
    deadline: number,
  ): void {
    this.gate();
    id(jobId);
    requireStorage(
      !this.ticks.active(),
      "unresolved tick retains scheduler admission",
    );
    requireStorage(
      lanes.length > 0 &&
        lanes.length <= 4 &&
        new Set(lanes).size === lanes.length &&
        lanes.every((l) => townLanes.includes(l)) &&
        Number.isSafeInteger(deadline) &&
        deadline > Date.now(),
      "invalid runtime admission",
    );
    this.write(() => this.claim(jobId, lanes, deadline));
  }
  private claim(
    jobId: string,
    lanes: readonly TownLane[],
    deadline: number,
  ): void {
    requireStorage(
      this.unresolved().length === 0 &&
        !this.db.prepare("SELECT id FROM jobs WHERE status='active'").get() &&
        !this.db.prepare("SELECT job_id FROM merchant_locks LIMIT 1").get(),
      "runtime work retains shared admission/locks",
    );
    this.db
      .prepare(
        "INSERT INTO jobs(id,trigger_key,trigger_ref,status,created_at,updated_at,deadline) VALUES(?,?,?,'active',?,?,?)",
      )
      .run(jobId, jobId, jobId, Date.now(), Date.now(), deadline);
    for (const lane of lanes)
      this.db
        .prepare("INSERT INTO merchant_locks VALUES(?,'controller',?,?)")
        .run(lane, jobId, Date.now());
  }
  prepare(action: CustomerAction, deadline: number): void {
    this.gate();
    id(action.id);
    parseU64(action.tick);
    requireStorage(
      action.arrival === "fund" || /^[0-3]$/.test(action.arrival),
      "invalid customer arrival",
    );
    this.write(() => {
      this.ticks.bind(action);
      const runtime = this.db.prepare("SELECT * FROM town_runtime").get()!;
      requireStorage(
        runtime["epoch"] === null ||
          BigInt(action.tick) >= BigInt(String(runtime["epoch"])),
        "old customer epoch cannot be replayed",
      );
      if (runtime["epoch"] !== action.tick) {
        this.db
          .prepare("UPDATE town_runtime SET epoch=?,next_arrival=0")
          .run(action.tick);
        runtime["next_arrival"] = 0;
      }
      requireStorage(
        action.arrival === "fund" ||
          Number(action.arrival) === runtime["next_arrival"],
        "customer arrivals must execute in order",
      );
      this.claim(action.id, ["operator"], deadline);
      this.db
        .prepare("INSERT INTO customer_actions VALUES(?,?,?,?)")
        .run(action.id, action.tick, action.arrival, json(action.decision));
      if (action.call) {
        const call = customerCall(action.call.method, action.call.args);
        const command = call.args.command;
        requireStorage(
          command.sequence ===
            (
              BigInt(String(this.checkpoint("operator")["last_action_id"])) + 1n
            ).toString() &&
            action.digest &&
            /^[a-f0-9]{64}$/.test(action.digest),
          "next operator command required",
        );
        this.journal.insert(
          {
            id: action.id,
            jobId: action.id,
            lane: "operator",
            method: call.method,
            actionId: command.sequence,
            argsJson: canonicalLivingTownJson(call.args),
            digest: action.digest,
            offerId: null,
          },
          Date.now(),
        );
      } else this.terminal(action.id, "completed");
    });
  }
  prepareTown(
    action: {
      id: string;
      tick: string;
      arrival: string;
      decision: unknown;
      lane: TownLane;
      call: TownCall | null;
      digest: string | null;
    },
    deadline: number,
  ): void {
    this.gate();
    id(action.id);
    parseU64(action.tick);
    requireStorage(
      action.lane ===
        (action.arrival.startsWith("merchant:")
          ? action.arrival.split(":")[1]
          : "operator"),
      "tick action lane mismatch",
    );
    requireStorage(
      (!!this.ticks.active() || !!this.reactions.work(action.id) || !!this.maintenance.get(action.id)) &&
        townLanes.includes(action.lane),
      "persisted tick required for town actions",
    );
    this.write(() => {
      if (this.reactions.work(action.id))
        this.reactions.bind(action, !!action.call);
      else if (this.maintenance.get(action.id)) this.maintenance.bind(action);
      else this.ticks.bind(action);
      this.claim(action.id, [action.lane], deadline);
      this.db
        .prepare("INSERT INTO customer_actions VALUES(?,?,?,?)")
        .run(action.id, action.tick, action.arrival, json(action.decision));
      if (!action.call) {
        this.terminal(action.id, "completed");
        return;
      }
      const call = townCall(action.call.method, action.call.args, action.lane);
      const terms = call.args as Record<string, unknown>;
      requireStorage(
        !action.arrival.startsWith("raw:") ||
          (call.method === "allocate_raw_supply" &&
            terms["item_id"] === action.arrival.slice(4) &&
            terms["epoch"] === action.tick),
        "source item/epoch plan mismatch",
      );
      requireStorage(
        !action.arrival.startsWith("sweep:") ||
          (call.method === "sweep_merchant_treasury" &&
            terms["merchant_id"] === action.arrival.slice(6) &&
            terms["epoch"] === action.tick),
        "treasury plan mismatch",
      );
      const sequence =
        "command" in call.args ? call.args.command.sequence : null;
      requireStorage(
        sequence === null ||
          sequence ===
            (
              BigInt(String(this.checkpoint(action.lane)["last_action_id"])) +
              1n
            ).toString(),
        "next town command required",
      );
      requireStorage(
        action.digest && /^[a-f0-9]{64}$/.test(action.digest),
        "town call digest required",
      );
      this.journal.insert(
        {
          id: action.id,
          jobId: action.id,
          lane: action.lane,
          method: call.method,
          actionId: sequence,
          argsJson: canonicalLivingTownJson(call.args),
          digest: action.digest,
          offerId: "offer_id" in call.args ? String(call.args.offer_id) : null,
        },
        Date.now(),
      );
      this.offers.bind(action.id, call);
    });
  }
  saveTownSigned(actionId: string, value: PreparedTownCall): void {
    const row = this.get(actionId);
    requireStorage(
      row?.["status"] === "prepared" && this.unresolved().length === 1,
      "original prepared town intent required",
    );
    const p = readTownPrepared(
      json(value),
      this.identity,
      String(row["lane"]) as TownLane,
    );
    requireStorage(
      p.call.method === row["method"] &&
        canonicalLivingTownJson(p.call.args) === row["args_json"],
      "town signed terms mismatch",
    );
    this.write(() =>
      this.journal.signed(
        actionId,
        { hash: p.transactionHash, nonce: p.nonce, json: json(p) },
        Date.now(),
      ),
    );
  }
  resolveTown(actionId: string, evidence: unknown, applied: boolean): void {
    this.write(() => {
      const row = this.get(actionId),
        e = evidence as {
          kind: string;
          transactionHash?: string;
          code?: string;
          result?: { data: unknown };
          command?: { data: { effect: unknown } };
        };
      requireStorage(
        row &&
          ["signed", "submitted", "unknown"].includes(String(row["status"])),
        "signed town work required",
      );
      requireStorage(
        e.kind === "command_checkpoint"
          ? applied && row["method"] !== "complete_production"
          : e.transactionHash === row["tx_hash"] &&
              (applied
                ? e.kind === "succeeded"
                : e.kind === "failed" && e.code === "EXECUTION_FAILED"),
        "town outcome evidence mismatch",
      );
      if (applied && row["method"] !== "complete_production") {
        const data =
          e.kind === "command_checkpoint"
            ? e.command?.data.effect
            : e.result?.data;
        const effect = isLivingTownOfferMethod(String(row["method"]))
          ? livingTownOfferEffect(data)
          : ["allocate_raw_supply", "sweep_merchant_treasury"].includes(
                String(row["method"]),
              )
            ? livingTownSourceEffect(data)
            : row["method"] === "start_production"
              ? livingTownProductionEffect(data)
              : row["method"] === "assistant_reprice"
                ? livingTownAssistantRepriceEffect(data)
                : row["method"] === "merchant_purchase"
                  ? livingTownPurchaseEffect(data)
                  : livingTownListingEffect(data);
        const principal =
          row["lane"] === "operator"
            ? `account:${this.identity.operatorId}`
            : `merchant:${String(row["lane"])}`;
        requireStorage(
          effect.principal === principal &&
            effect.command_sequence === row["action_id"] &&
            effect.payload_sha256 === row["args_digest"],
          "town command evidence terms mismatch",
        );
        if (isLivingTownOfferMethod(String(row["method"])))
          this.offers.confirm(actionId, data);
        this.db
          .prepare(
            "UPDATE merchants SET last_action_id=?,last_action_digest=? WHERE merchant_id=?",
          )
          .run(row["action_id"]!, row["args_digest"]!, row["lane"]!);
      }
      if (applied && row["method"] === "complete_production") {
        const data = e.result?.data as {
          principal: unknown;
          command_sequence: unknown;
          payload_sha256: unknown;
          outcome: { kind: string; job: unknown; ledger: unknown };
        };
        requireStorage(
          data &&
            data.principal === null &&
            data.command_sequence === null &&
            data.payload_sha256 === null &&
            data.outcome?.kind === "production_completed",
          "completion evidence shape mismatch",
        );
        const job = livingTownProductionJob(data.outcome.job),
          ledger = livingTownLedger(data.outcome.ledger),
          args = JSON.parse(String(row["args_json"]));
        requireStorage(
          job.status === "completed" &&
            job.job_id === args.job_id &&
            job.owner.kind === "merchant" &&
            job.owner.merchant_id === row["lane"] &&
            ledger.actor.kind === "merchant" &&
            ledger.actor.merchant_id === row["lane"],
          "completion job/lane mismatch",
        );
      }
      this.db
        .prepare(
          "UPDATE attempts SET evidence_json=?,updated_at=? WHERE intent_id=?",
        )
        .run(json(evidence), Date.now(), actionId);
      this.db
        .prepare("UPDATE intents SET status=?,updated_at=? WHERE id=?")
        .run(applied ? "confirmed" : "failed", Date.now(), actionId);
      this.terminal(actionId, applied ? "completed" : "failed");
    });
  }
  saveSigned(
    actionId: string,
    value: PreparedCustomerCall,
    recovering = false,
  ): void {
    if (recovering)
      requireStorage(
        !this.stopped &&
          this.unresolved().length === 1 &&
          this.unresolved()[0]?.["id"] === actionId &&
          this.get(actionId)?.["status"] === "prepared",
        "only the original prepared recovery action may be signed",
      );
    else this.gate();
    const p = readCustomerPrepared(json(value), this.identity),
      row = this.get(actionId);
    requireStorage(
      row?.["status"] === "prepared" &&
        row["method"] === p.call.method &&
        row["args_json"] === canonicalLivingTownJson(p.call.args),
      "signed customer intent mismatch",
    );
    this.write(() =>
      this.journal.signed(
        actionId,
        { hash: p.transactionHash, nonce: p.nonce, json: json(p) },
        Date.now(),
      ),
    );
  }
  markBroadcast(actionId: string, state: "submitted" | "unknown"): void {
    this.write(() => this.journal.broadcast(actionId, state, Date.now()));
  }
  resolve(actionId: string, evidence: unknown, applied: boolean): void {
    this.write(() => {
      const row = this.get(actionId);
      requireStorage(
        row &&
          ["signed", "submitted", "unknown"].includes(String(row["status"])),
        "signed customer work required",
      );
      const result = evidence as {
        kind: string;
        transactionHash?: string;
        code?: string;
        result?: { data: unknown };
        command?: { data: { effect: unknown } };
      };
      if (applied) {
        requireStorage(
          result.kind === "succeeded"
            ? result.transactionHash === row["tx_hash"]
            : result.kind === "command_checkpoint",
          "customer proof kind/hash mismatch",
        );
        const effect = livingTownCustomerEffect(
          result.kind === "succeeded"
            ? result.result?.data
            : result.command?.data.effect,
        );
        requireStorage(
          effect.principal === `account:${this.identity.operatorId}` &&
            effect.command_sequence === row["action_id"] &&
            effect.payload_sha256 === row["args_digest"],
          "customer proof terms mismatch",
        );
      } else
        requireStorage(
          result.kind === "failed" &&
            result.code === "EXECUTION_FAILED" &&
            result.transactionHash === row["tx_hash"],
          "customer failure proof mismatch",
        );
      this.db
        .prepare(
          "UPDATE attempts SET evidence_json=?,updated_at=? WHERE intent_id=?",
        )
        .run(json(evidence), Date.now(), actionId);
      if (applied)
        this.db
          .prepare(
            "UPDATE merchants SET last_action_id=?,last_action_digest=? WHERE merchant_id='operator'",
          )
          .run(row["action_id"]!, row["args_digest"]!);
      this.db
        .prepare("UPDATE intents SET status=?,updated_at=? WHERE id=?")
        .run(applied ? "confirmed" : "failed", Date.now(), actionId);
      this.terminal(actionId, applied ? "completed" : "failed");
    });
  }
  abandon(actionId: string): void {
    this.write(() => {
      const row = this.get(actionId);
      requireStorage(
        row && ["prepared", "signed"].includes(String(row["status"])),
        "broadcast work cannot be abandoned",
      );
      this.db
        .prepare(
          "UPDATE intents SET status='abandoned',updated_at=? WHERE id=?",
        )
        .run(Date.now(), actionId);
      this.terminal(actionId, "expired");
    });
  }
  private terminal(jobId: string, status: string): void {
    requireStorage(
      !this.db
        .prepare(
          `SELECT id FROM intents WHERE job_id=? AND status IN ${unresolvedStatuses}`,
        )
        .get(jobId),
      "unknown work retains controller lock",
    );
    const action = this.db
      .prepare("SELECT tick,arrival FROM customer_actions WHERE id=?")
      .get(jobId);
    if (action && /^[0-3]$/.test(String(action["arrival"])))
      this.db
        .prepare("UPDATE town_runtime SET next_arrival=? WHERE epoch=?")
        .run(Number(action["arrival"]) + 1, action["tick"]!);
    this.db.prepare("DELETE FROM merchant_locks WHERE job_id=?").run(jobId);
    this.db
      .prepare("UPDATE jobs SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), jobId);
    this.ticks.settled(jobId, status);
    this.reactions.settled(jobId, status);
    this.maintenance.settled(jobId, status);
  }
  completeRuntimeJob(jobId: string): void {
    this.gate();
    this.write(() => this.terminal(id(jobId), "completed"));
  }
  operations(): import("./operations.js").RuntimeOperations {
    const tick = (row: Record<string, unknown> | undefined) =>
      row
        ? {
            id: String(row["id"]),
            slot: String(row["slot"]),
            epoch: String(row["epoch"]),
            createdAt: Number(row["created_at"]),
          }
        : null;
    const unresolved = this.db
      .prepare(
        "SELECT count(*) n,min(updated_at) oldest FROM intents WHERE status IN ('prepared','signed','submitted','unknown')",
      )
      .get()!;
    return {
      recoveryRequired: !this.ready,
      unresolved: Number(unresolved["n"]),
      oldestIntentAt:
        unresolved["oldest"] === null ? null : Number(unresolved["oldest"]),
      activeTick: tick(this.ticks.active()),
      lastCompletedTick: tick(
        this.db
          .prepare(
            "SELECT id,slot,epoch,created_at FROM town_ticks WHERE state='completed' ORDER BY sequence DESC LIMIT 1",
          )
          .get(),
      ),
      rejectedActions: Number(
        this.db
          .prepare("SELECT count(*) n FROM intents WHERE status='failed'")
          .get()!["n"],
      ),
    };
  }
  close(): void {
    if (this.stopped) return;
    this.ready = false;
    this.stopped = true;
    this.db.close();
  }
}
