import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
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
import { createHash, randomUUID } from "node:crypto";
import { baseEncode, SignedTransaction } from "near-api-js";
import {
  createMarketCall,
  decodeCallResult,
  merchantActionDigest,
  parseU64,
} from "@bot-bazaar/chain";
import type {
  DeploymentIdentity,
  MerchantId,
  MerchantAction,
  ReceiptStatus,
} from "@bot-bazaar/chain";
import type { MerchantMethod, PreparedMerchantCall } from "../chain-adapter.js";
import { schema, schemaVersion } from "./schema.js";
import {
  digest,
  id,
  identityJson,
  json,
  label,
  merchant,
  requireStorage,
  sanitizedDecision,
  sha256,
  StorageError,
  timestamp,
} from "./validation.js";
import { createBackup } from "./backup.js";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface StoreOptions {
  dataDir: string;
  identity: DeploymentIdentity;
  policyVersion: string;
  create?: boolean;
}
export interface Job {
  id: string;
  triggerKey: string;
  triggerRef: string;
  deadline: number;
}
export interface Intent {
  id: string;
  jobId: string;
  decisionId?: string;
  merchantId: MerchantId;
  method: MerchantMethod;
  args: unknown;
}
const unresolved = "('prepared','signed','submitted','unknown')";
const terminals = "('completed','failed','expired')";

export class WorkerStore {
  private readonly db: DatabaseSync;
  private failed = false;
  private closed = false;
  private backingUp: Promise<string> | undefined;
  readonly dataDir: string;
  readonly path: string;
  readonly identity: DeploymentIdentity;

  constructor(options: StoreOptions) {
    const expected = identityJson(options.identity);
    id(options.policyVersion);
    requireStorage(
      isAbsolute(options.dataDir) &&
        lstatSync(options.dataDir).isDirectory() &&
        !lstatSync(options.dataDir).isSymbolicLink(),
      "existing absolute local data directory required",
    );
    this.dataDir = realpathSync(options.dataDir);
    this.path = join(this.dataDir, "worker.sqlite");
    const identity = JSON.parse(expected) as DeploymentIdentity;
    this.identity = Object.freeze({
      ...identity,
      controllers: Object.freeze({ ...identity.controllers }),
    });
    const fresh = !existsSync(this.path);
    requireStorage(
      !fresh || options.create === true,
      "database missing; explicit initialization required",
    );
    if (fresh) closeSync(openSync(this.path, "wx", 0o600));
    requireStorage(
      lstatSync(this.path).isFile() && !lstatSync(this.path).isSymbolicLink(),
      "regular database file required",
    );
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path, {
      timeout: 1000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      // Held by SQLite's OS locks until close/crash, with no heartbeat takeover.
      this.db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000;");
      if (fresh) this.db.exec("PRAGMA auto_vacuum=INCREMENTAL");
      this.db.exec("BEGIN EXCLUSIVE; COMMIT;");
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
      );
      for (const [setting, expectedValue] of [
        ["locking_mode", "exclusive"],
        ["journal_mode", "wal"],
        ["synchronous", 2],
        ["foreign_keys", 1],
        ["auto_vacuum", 2],
      ] as const)
        requireStorage(
          Object.values(this.db.prepare(`PRAGMA ${setting}`).get()!)[0] ===
            expectedValue,
          "durability setting did not take effect",
        );
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()!["user_version"],
      );
      if (fresh) {
        requireStorage(version === 0, "unexpected initial schema");
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(schema);
          this.db
            .prepare(
              "INSERT INTO deployment(singleton,identity,policy_version,feed_generation,created_at) VALUES(1,?,?,?,?)",
            )
            .run(expected, options.policyVersion, randomUUID(), Date.now());
          for (const name of ["rex", "luna", "bolt"] as const)
            this.db
              .prepare(
                "INSERT INTO merchants(merchant_id,controller_id) VALUES(?,?)",
              )
              .run(name, options.identity.controllers[name]);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      } else
        requireStorage(
          version === schemaVersion,
          "unsupported database schema; do not recreate it",
        );
      requireStorage(
        this.one(
          "SELECT identity,policy_version FROM deployment WHERE singleton=1",
        )?.["identity"] === expected,
        "deployment identity mismatch",
      );
      requireStorage(
        this.one("SELECT policy_version FROM deployment WHERE singleton=1")?.[
          "policy_version"
        ] === options.policyVersion,
        "policy version mismatch; explicit migration required",
      );
      requireStorage(
        this.one("PRAGMA quick_check")?.["quick_check"] === "ok" &&
          this.all("PRAGMA foreign_key_check").length === 0,
        "database integrity check failed",
      );
      // Every startup is a recovery boundary; storage alone never enables signing.
      this.db
        .prepare(
          "UPDATE deployment SET recovery_required=1,feed_generation=? WHERE singleton=1",
        )
        .run(randomUUID());
    } catch (error) {
      this.db.close();
      if (error instanceof StorageError) throw error;
      throw new StorageError("cannot acquire ownership or validate database");
    }
  }
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  private all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args);
  }
  private run(sql: string, ...args: SQLInputValue[]): void {
    this.db.prepare(sql).run(...args);
  }
  private write<T>(operation: () => T, admission = false): T {
    requireStorage(!this.failed && !this.closed, "database unavailable");
    try {
      const usage = this.usage();
      requireStorage(
        usage.freeBytes >= 16 * 1024 * 1024 &&
          (!admission || usage.bytes < 0.9 * 2 ** 31),
        "insufficient storage headroom",
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* SQLITE_FULL may already have rolled back. */
        }
        throw error;
      }
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code !== undefined && [10, 11, 13, 14, 26].includes(code & 255))
        this.failed = true;
      if (error instanceof StorageError) throw error;
      throw new StorageError("write rejected; state was not advanced");
    }
  }
  usage(): { bytes: number; freeBytes: number; warning: boolean } {
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix))
        bytes += statSync(this.path + suffix).size;
    const disk = statfsSync(this.dataDir);
    return {
      bytes,
      freeBytes: disk.bavail * disk.bsize,
      warning: bytes >= 0.75 * 2 ** 31,
    };
  }
  get available(): boolean {
    return !this.closed && !this.failed;
  }
  checkpoint(): Row {
    return this.one("SELECT * FROM deployment WHERE singleton=1")!;
  }
  merchantCheckpoint(name: MerchantId): Row {
    return this.one(
      "SELECT * FROM merchants WHERE merchant_id=?",
      merchant(name),
    )!;
  }
  observe(
    revision: string,
    height: string,
    hash: string,
    now = Date.now(),
  ): void {
    parseU64(revision);
    parseU64(height);
    timestamp(now);
    requireStorage(
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash),
      "invalid observed block",
    );
    this.write(() => {
      const previous = this.checkpoint();
      requireStorage(
        (previous["observed_revision"] === null ||
          BigInt(revision) >= BigInt(String(previous["observed_revision"]))) &&
          (previous["observed_height"] === null ||
            BigInt(height) >= BigInt(String(previous["observed_height"]))),
        "checkpoint regression",
      );
      this.run(
        "UPDATE deployment SET observed_revision=?,observed_height=?,observed_hash=?,observed_at=? WHERE singleton=1",
        revision,
        height,
        hash,
        now,
      );
    });
  }
  recordMerchantCheckpoint(
    name: MerchantId,
    actionId: string,
    actionDigest: string | null,
    shortageMode: boolean,
  ): void {
    merchant(name);
    parseU64(actionId);
    if (actionDigest !== null) digest(actionDigest);
    requireStorage(
      (actionId === "0") === (actionDigest === null),
      "action checkpoint digest required",
    );
    this.write(() => {
      const row = this.merchantCheckpoint(name);
      requireStorage(
        row["last_action_id"] === null ||
          BigInt(actionId) >= BigInt(String(row["last_action_id"])),
        "action checkpoint regression",
      );
      requireStorage(
        row["last_action_id"] !== actionId ||
          row["last_action_digest"] === actionDigest,
        "action checkpoint digest conflict",
      );
      this.run(
        "UPDATE merchants SET last_action_id=?,last_action_digest=?,shortage_mode=? WHERE merchant_id=?",
        actionId,
        actionDigest,
        Number(shortageMode),
        name,
      );
    });
  }
  enqueue(job: Job, now = Date.now()): boolean {
    id(job.id);
    id(job.triggerKey);
    id(job.triggerRef);
    timestamp(now);
    timestamp(job.deadline);
    requireStorage(job.deadline > now, "job deadline has passed");
    return this.write(() => {
      if (this.one("SELECT id FROM jobs WHERE trigger_key=?", job.triggerKey))
        return false;
      this.run(
        "INSERT INTO jobs(id,trigger_key,trigger_ref,status,created_at,updated_at,deadline) VALUES(?,?,?,'queued',?,?,?)",
        job.id,
        job.triggerKey,
        job.triggerRef,
        now,
        now,
        job.deadline,
      );
      return true;
    }, true);
  }
  activateJob(jobId: string, now = Date.now()): void {
    id(jobId);
    timestamp(now);
    this.write(() => {
      const row = this.getJob(jobId);
      requireStorage(
        row?.["status"] === "queued" && Number(row["deadline"]) > now,
        "job not eligible",
      );
      this.run(
        "UPDATE jobs SET status='active',updated_at=? WHERE id=?",
        now,
        jobId,
      );
    }, true);
  }
  getJob(jobId: string): Row | undefined {
    return this.one("SELECT * FROM jobs WHERE id=?", id(jobId));
  }
  jobs(): Row[] {
    return this.all(
      "SELECT * FROM jobs WHERE status IN ('active','queued') ORDER BY created_at,id LIMIT 101",
    );
  }
  claimLocks(
    jobId: string,
    names: readonly MerchantId[],
    kind: "commitment" | "controller",
    now = Date.now(),
  ): void {
    id(jobId);
    timestamp(now);
    requireStorage(
      ["commitment", "controller"].includes(kind) &&
        names.length > 0 &&
        names.length <= 3 &&
        new Set(names).size === names.length,
      "invalid lock request",
    );
    this.write(() => {
      requireStorage(
        this.getJob(jobId)?.["status"] === "active",
        "active job required",
      );
      for (const name of [...names].sort()) {
        merchant(name);
        const row = this.one(
          "SELECT job_id FROM merchant_locks WHERE merchant_id=? AND kind=?",
          name,
          kind,
        );
        requireStorage(
          !row || row["job_id"] === jobId,
          "merchant already reserved",
        );
        this.run(
          "INSERT OR IGNORE INTO merchant_locks VALUES(?,?,?,?)",
          name,
          kind,
          jobId,
          now,
        );
      }
    }, true);
  }
  locks(): Row[] {
    return this.all("SELECT * FROM merchant_locks ORDER BY merchant_id,kind");
  }
  releaseLocks(jobId: string, kind: "commitment" | "controller"): void {
    id(jobId);
    requireStorage(
      ["commitment", "controller"].includes(kind),
      "invalid lock kind",
    );
    this.write(() => {
      requireStorage(
        !this.one(
          `SELECT id FROM intents WHERE job_id=? AND status IN ${unresolved}`,
          jobId,
        ),
        "unresolved transaction retains locks",
      );
      if (kind === "commitment")
        requireStorage(
          !this.one(
            "SELECT offer_id FROM offers WHERE job_id=? AND (status='pending' OR (status IN ('expired','pruned') AND cleanup_ack=0))",
            jobId,
          ),
          "unresolved offer retains commitment",
        );
      this.run(
        "DELETE FROM merchant_locks WHERE job_id=? AND kind=?",
        jobId,
        kind,
      );
    });
  }
  completeJob(
    jobId: string,
    status: "completed" | "failed" | "expired",
    now = Date.now(),
  ): void {
    id(jobId);
    timestamp(now);
    requireStorage(
      ["completed", "failed", "expired"].includes(status),
      "invalid terminal job status",
    );
    this.write(() => {
      requireStorage(
        ["active", "queued"].includes(String(this.getJob(jobId)?.["status"])),
        "job already terminal",
      );
      requireStorage(
        !this.one(
          `SELECT id FROM intents WHERE job_id=? AND status IN ${unresolved}`,
          jobId,
        ) &&
          !this.one(
            "SELECT job_id FROM merchant_locks WHERE job_id=?",
            jobId,
          ) &&
          !this.one(
            "SELECT offer_id FROM offers WHERE job_id=? AND (status='pending' OR (status IN ('expired','pruned') AND cleanup_ack=0))",
            jobId,
          ),
        "job has protected work",
      );
      this.run(
        "UPDATE jobs SET status=?,updated_at=? WHERE id=?",
        status,
        now,
        jobId,
      );
    });
  }
  saveDecision(
    input: {
      id: string;
      jobId: string;
      merchantId: MerchantId;
      provider: string;
      model: string;
      promptVersion: string;
      action: unknown;
      reason: string;
    },
    now = Date.now(),
  ): void {
    [input.id, input.jobId].forEach(id);
    [input.provider, input.model, input.promptVersion].forEach(label);
    merchant(input.merchantId);
    timestamp(now);
    const clean = sanitizedDecision(input.action, input.reason);
    this.write(() => {
      const job = this.getJob(input.jobId);
      requireStorage(
        job?.["status"] === "active" && Number(job["deadline"]) > now,
        "decision job inactive or expired",
      );
      this.run(
        "INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)",
        input.id,
        input.jobId,
        input.merchantId,
        input.provider,
        input.model,
        input.promptVersion,
        clean.actionJson,
        clean.reason,
        now,
      );
    }, true);
  }
  getDecision(decisionId: string): Row | undefined {
    return this.one("SELECT * FROM decisions WHERE id=?", id(decisionId));
  }
  async prepareIntent(input: Intent, now = Date.now()): Promise<void> {
    input = { ...input };
    id(input.id);
    id(input.jobId);
    merchant(input.merchantId);
    timestamp(now);
    requireStorage(
      [
        "set_listing",
        "propose_trade",
        "accept_trade",
        "cancel_trade",
        "expire_offers",
      ].includes(input.method),
      "invalid intent method",
    );
    const call = createMarketCall(input.method, input.args);
    const fields = call.args as Record<string, unknown>;
    const argsJson = json(call.args);
    const argsDigest =
      input.method === "expire_offers"
        ? sha256(argsJson)
        : await merchantActionDigest({
            method: input.method,
            args: call.args,
          } as MerchantAction);
    const actionId =
      input.method === "expire_offers" ? null : String(fields["action_id"]);
    const offerId =
      fields["offer_id"] === undefined ? null : String(fields["offer_id"]);
    const snapshot = { ...input }; // Arguments above have already been detached/validated.
    this.write(
      () => {
        const job = this.getJob(snapshot.jobId);
        requireStorage(
          job?.["status"] === "active" && Number(job["deadline"]) > now,
          "intent job inactive or expired",
        );
        requireStorage(
          this.one(
            "SELECT job_id FROM merchant_locks WHERE merchant_id=? AND kind='controller'",
            snapshot.merchantId,
          )?.["job_id"] === snapshot.jobId,
          "controller lock required",
        );
        if (actionId !== null) {
          const previous = this.merchantCheckpoint(snapshot.merchantId)[
            "last_action_id"
          ];
          requireStorage(
            previous !== null &&
              BigInt(actionId) === BigInt(String(previous)) + 1n,
            "reconciled next action ID required",
          );
        }
        if (snapshot.decisionId !== undefined)
          requireStorage(
            this.getDecision(snapshot.decisionId)?.["job_id"] ===
              snapshot.jobId,
            "decision job mismatch",
          );
        requireStorage(
          input.method !== "set_listing" ||
            fields["merchant_id"] === snapshot.merchantId,
          "listing actor mismatch",
        );
        requireStorage(
          input.method !== "propose_trade" ||
            fields["proposer"] === snapshot.merchantId,
          "proposal actor mismatch",
        );
        this.run(
          "INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)",
          snapshot.id,
          snapshot.jobId,
          snapshot.decisionId ?? null,
          snapshot.merchantId,
          snapshot.method,
          actionId,
          argsJson,
          argsDigest,
          offerId,
          now,
          now,
        );
      },
      input.method !== "cancel_trade" && input.method !== "expire_offers",
    );
  }
  getIntent(intentId: string): Row | undefined {
    return this.one("SELECT * FROM intents WHERE id=?", id(intentId));
  }
  attempt(intentId: string): Row | undefined {
    return this.one("SELECT * FROM attempts WHERE intent_id=?", id(intentId));
  }
  unresolvedIntents(): Row[] {
    return this.all(
      `SELECT intents.*,attempts.tx_hash,attempts.signed_json FROM intents LEFT JOIN attempts ON attempts.intent_id=intents.id WHERE status IN ${unresolved} ORDER BY created_at,id LIMIT 3`,
    );
  }
  saveSigned(
    intentId: string,
    prepared: PreparedMerchantCall,
    now = Date.now(),
  ): void {
    id(intentId);
    timestamp(now);
    prepared = {
      merchantId: prepared.merchantId,
      method: prepared.method,
      args: createMarketCall(prepared.method, prepared.args).args,
      transactionHash: prepared.transactionHash,
      signerId: prepared.signerId,
      publicKey: prepared.publicKey,
      contractId: prepared.contractId,
      nonce: prepared.nonce,
      gas: prepared.gas,
      signedTransactionBase64: prepared.signedTransactionBase64,
    };
    const signedJson = json(prepared);
    const signed = SignedTransaction.decode(
      Buffer.from(prepared.signedTransactionBase64, "base64"),
    );
    const tx = signed.transaction,
      action = tx.actions[0]?.functionCall;
    const args = createMarketCall(prepared.method, prepared.args).args;
    requireStorage(
      prepared.signerId ===
        this.identity.controllers[merchant(prepared.merchantId)] &&
        prepared.contractId === this.identity.contractId &&
        tx.signerId === prepared.signerId &&
        tx.receiverId === prepared.contractId &&
        tx.publicKey.toString() === prepared.publicKey &&
        tx.nonce.toString() === parseU64(prepared.nonce) &&
        baseEncode(createHash("sha256").update(tx.encode()).digest()) ===
          prepared.transactionHash,
      "signed identity mismatch",
    );
    requireStorage(
      tx.actions.length === 1 &&
        action?.methodName === prepared.method &&
        action.deposit === 0n &&
        action.gas.toString() === parseU64(prepared.gas) &&
        json(
          createMarketCall(
            prepared.method,
            JSON.parse(Buffer.from(action.args).toString("utf8")),
          ).args,
        ) === json(args),
      "signed call mismatch",
    );
    this.write(() => {
      const row = this.getIntent(intentId);
      requireStorage(
        row?.["status"] === "prepared" &&
          row["merchant_id"] === prepared.merchantId &&
          row["method"] === prepared.method &&
          row["args_json"] === json(args),
        "signed intent mismatch",
      );
      this.run(
        "INSERT INTO attempts(intent_id,tx_hash,nonce,signed_json,updated_at) VALUES(?,?,?,?,?)",
        intentId,
        prepared.transactionHash,
        prepared.nonce,
        signedJson,
        now,
      );
      this.run(
        "UPDATE intents SET status='signed',updated_at=? WHERE id=?",
        now,
        intentId,
      );
    });
  }
  markBroadcast(
    intentId: string,
    status: "submitted" | "unknown",
    now = Date.now(),
  ): void {
    id(intentId);
    timestamp(now);
    requireStorage(
      ["submitted", "unknown"].includes(status),
      "invalid broadcast state",
    );
    this.write(() => {
      requireStorage(
        ["signed", "submitted", "unknown"].includes(
          String(this.getIntent(intentId)?.["status"]),
        ),
        "signed attempt required",
      );
      this.run(
        "UPDATE intents SET status=?,updated_at=? WHERE id=?",
        status,
        now,
        intentId,
      );
    });
  }
  finishAttempt(
    intentId: string,
    evidence: ReceiptStatus,
    now = Date.now(),
  ): void {
    id(intentId);
    timestamp(now);
    requireStorage(
      evidence.kind === "succeeded" || evidence.kind === "failed",
      "definitive evidence required",
    );
    this.write(() => {
      const row = this.getIntent(intentId),
        attempt = this.attempt(intentId);
      requireStorage(
        row &&
          ["signed", "submitted", "unknown"].includes(String(row["status"])) &&
          attempt?.["tx_hash"] === evidence.transactionHash,
        "attempt evidence mismatch",
      );
      let evidenceJson: string;
      if (evidence.kind === "succeeded") {
        const result = decodeCallResult(
          row["method"] as MerchantMethod,
          evidence.result,
        );
        evidenceJson = json({
          kind: "succeeded",
          transactionHash: evidence.transactionHash,
          result,
        });
        if (row["action_id"] !== null) {
          const action = (
            result.data as {
              action?: {
                action_id: string;
                method: string;
                args_sha256: string;
              };
            }
          ).action;
          const previous = this.merchantCheckpoint(
            row["merchant_id"] as MerchantId,
          );
          requireStorage(
            action &&
              action.action_id === row["action_id"] &&
              action.method === row["method"] &&
              action.args_sha256 === row["args_digest"] &&
              (previous["last_action_id"] === null ||
                BigInt(String(previous["last_action_id"])) <=
                  BigInt(String(row["action_id"]))) &&
              (previous["last_action_id"] !== row["action_id"] ||
                previous["last_action_digest"] === row["args_digest"]),
            "action receipt checkpoint conflict",
          );
          this.run(
            "UPDATE merchants SET last_action_id=?,last_action_digest=?,latest_success=? WHERE merchant_id=?",
            row["action_id"]!,
            row["args_digest"]!,
            evidenceJson,
            row["merchant_id"]!,
          );
        }
        const offer = (
          result.data as {
            offer?: { offer_id: string; status: string; expires_at_ns: string };
          }
        ).offer;
        if (offer) {
          this.run(
            "UPDATE intents SET offer_id=? WHERE id=?",
            offer.offer_id,
            intentId,
          );
          this.run(
            "INSERT INTO offers VALUES(?,?,?,?,?,?) ON CONFLICT(offer_id) DO UPDATE SET status=excluded.status,cleanup_ack=excluded.cleanup_ack,updated_at=excluded.updated_at",
            offer.offer_id,
            row["job_id"]!,
            offer.status,
            offer.expires_at_ns,
            Number(offer.status !== "pending"),
            now,
          );
        }
        if (row["method"] === "expire_offers")
          for (const offerId of (result.data as { expired_offer_ids: string[] })
            .expired_offer_ids)
            this.run(
              "UPDATE offers SET status='expired',cleanup_ack=1,updated_at=? WHERE offer_id=?",
              now,
              offerId,
            );
      } else {
        requireStorage(
          evidence.code === "EXECUTION_FAILED",
          "invalid failure evidence code",
        );
        evidenceJson = json({
          kind: "failed",
          transactionHash: evidence.transactionHash,
          code: "EXECUTION_FAILED",
        });
      }
      this.run(
        "UPDATE attempts SET evidence_json=?,updated_at=? WHERE intent_id=?",
        evidenceJson,
        now,
        intentId,
      );
      this.run(
        "UPDATE intents SET status=?,updated_at=? WHERE id=?",
        evidence.kind === "succeeded" ? "confirmed" : "failed",
        now,
        intentId,
      );
    });
  }
  abandonUnsigned(intentId: string, now = Date.now()): void {
    id(intentId);
    timestamp(now);
    this.write(() => {
      requireStorage(
        this.getIntent(intentId)?.["status"] === "prepared" &&
          !this.attempt(intentId),
        "cannot abandon signed work",
      );
      this.run(
        "UPDATE intents SET status='abandoned',updated_at=? WHERE id=?",
        now,
        intentId,
      );
    });
  }
  putOffer(
    offer: {
      id: string;
      jobId?: string;
      status: "pending" | "accepted" | "cancelled" | "expired" | "pruned";
      expiresAtNs: string;
      cleanupAck: boolean;
    },
    now = Date.now(),
  ): void {
    parseU64(offer.id);
    parseU64(offer.expiresAtNs);
    timestamp(now);
    requireStorage(
      offer.id !== "0" &&
        ["pending", "accepted", "cancelled", "expired", "pruned"].includes(
          offer.status,
        ) &&
        typeof offer.cleanupAck === "boolean" &&
        !(offer.status === "pending" && offer.cleanupAck),
      "invalid offer cache entry",
    );
    this.write(() => {
      const old = this.one("SELECT * FROM offers WHERE offer_id=?", offer.id);
      requireStorage(
        !old ||
          ((old["status"] === "pending" ||
            old["status"] === "expired" ||
            old["status"] === offer.status) &&
            (old["job_id"] === null || old["job_id"] === offer.jobId) &&
            Number(old["cleanup_ack"]) <= Number(offer.cleanupAck)),
        "offer cache regression",
      );
      this.run(
        "INSERT INTO offers VALUES(?,?,?,?,?,?) ON CONFLICT(offer_id) DO UPDATE SET job_id=excluded.job_id,status=excluded.status,expires_at_ns=excluded.expires_at_ns,cleanup_ack=excluded.cleanup_ack,updated_at=excluded.updated_at",
        offer.id,
        offer.jobId ?? null,
        offer.status,
        offer.expiresAtNs,
        Number(offer.cleanupAck),
        now,
      );
    });
  }
  offers(): Row[] {
    return this.all(
      "SELECT * FROM offers ORDER BY length(offer_id),offer_id COLLATE BINARY LIMIT 112",
    );
  }
  forgetTerminalOffer(offerId: string): void {
    parseU64(offerId);
    this.write(() => {
      const row = this.one("SELECT * FROM offers WHERE offer_id=?", offerId);
      requireStorage(
        row &&
          row["status"] !== "pending" &&
          row["cleanup_ack"] === 1 &&
          (row["job_id"] === null ||
            ["completed", "failed", "expired"].includes(
              String(this.getJob(String(row["job_id"]))?.["status"]),
            )) &&
          !this.one(
            `SELECT id FROM intents WHERE offer_id=? AND status IN ${unresolved}`,
            offerId,
          ),
        "offer still protected",
      );
      this.run("DELETE FROM offers WHERE offer_id=?", offerId);
    });
  }
  prune(now = Date.now()): void {
    timestamp(now);
    this.write(() => {
      // Only resolved jobs are eligible. Protect every unresolved intent and lock.
      const eligible = `job_id IN (SELECT id FROM jobs WHERE status IN ${terminals})`;
      this.run(
        `DELETE FROM intents WHERE ${eligible} AND status IN ('confirmed','failed','abandoned') AND (updated_at<? OR id IN (SELECT id FROM intents WHERE ${eligible} AND status IN ('confirmed','failed','abandoned') ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 10000))`,
        now - 30 * 86400000,
      );
      this.run(
        `DELETE FROM decisions WHERE ${eligible} AND NOT EXISTS(SELECT 1 FROM intents WHERE decision_id=decisions.id) AND (created_at<? OR id IN (SELECT id FROM decisions WHERE ${eligible} ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 10000))`,
        now - 7 * 86400000,
      );
      // Keep compact job identity/timestamps as durable dedup tombstones until P3.4's completed stream boundary exists.
      this.run(
        `UPDATE jobs SET trigger_ref='pruned' WHERE status IN ${terminals} AND updated_at<? AND NOT EXISTS(SELECT 1 FROM intents WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM decisions WHERE job_id=jobs.id)`,
        now - 7 * 86400000,
      );
    });
    try {
      this.db.exec(
        "PRAGMA incremental_vacuum(128); PRAGMA wal_checkpoint(TRUNCATE);",
      );
    } catch {
      this.failed = true;
      throw new StorageError("storage maintenance failed; processing stopped");
    }
  }
  backup(destination: string): Promise<string> {
    requireStorage(
      !this.closed && !this.failed && !this.backingUp,
      "backup unavailable or already running",
    );
    requireStorage(
      isAbsolute(destination) && realpathSync(destination) !== this.dataDir,
      "separate backup directory required",
    );
    const task = createBackup(this.db, this.identity, destination);
    this.backingUp = task;
    void task
      .finally(() => {
        this.backingUp = undefined;
      })
      .catch(() => {});
    return task;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.backingUp;
    } finally {
      this.db.close();
      this.closed = true;
    }
  }
}
