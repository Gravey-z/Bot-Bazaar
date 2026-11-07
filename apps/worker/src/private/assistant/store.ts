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
import { canonicalLivingTownJson, parseU64 } from "@bot-bazaar/chain";
import { configureJournal } from "../storage/journal.js";
import { requireStorage } from "../storage/validation.js";
import type { AssistantProposal } from "./proposals.js";
import type { AssistantManualReview } from "@bot-bazaar/chain";
import {
  assistantRestockLimits,
  defaultAssistantRestockLimits,
} from "@bot-bazaar/chain";
import type { AssistantRestockLimits } from "@bot-bazaar/chain";
export interface AssistantSettings {
  mode: string;
  revision: string;
  restock: AssistantRestockLimits;
  paused: boolean;
  pause_policy_revision: string | null;
}
export interface AssistantRecord {
  id: string;
  account: string;
  shop: string;
  context: string;
  revision: string;
  status: "pending" | "proposed" | "rejected" | "expired" | "wait";
  code: string;
  proposals: AssistantProposal[];
  started: number;
  updated: number;
  model_status?: string;
}
export class AssistantStore {
  private readonly db: DatabaseSync;
  private readonly path: string;
  constructor(
    private readonly dir: string,
    readonly identity: string,
    create = false,
  ) {
    requireStorage(
      isAbsolute(dir) &&
        lstatSync(dir).isDirectory() &&
        !lstatSync(dir).isSymbolicLink(),
      "private assistant directory required",
    );
    requireStorage(
      !existsSync(join(dir, "living-town.sqlite")) &&
        !existsSync(join(dir, "worker.sqlite")),
      "dedicated assistant directory required",
    );
    this.path = join(realpathSync(dir), "assistant.sqlite");
    const fresh = !existsSync(this.path);
    requireStorage(
      !fresh || create,
      "explicit assistant initialization required",
    );
    if (fresh) closeSync(openSync(this.path, "wx", 0o600));
    requireStorage(
      lstatSync(this.path).isFile() && !lstatSync(this.path).isSymbolicLink(),
      "regular private journal required",
    );
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path, {
      timeout: 1000,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
    try {
      configureJournal(this.db, fresh);
      if (fresh)
        this.write(() => {
          this.db.exec(`
          CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),identity TEXT NOT NULL,high_water INTEGER NOT NULL) STRICT;
          CREATE TABLE settings(shop TEXT PRIMARY KEY,account TEXT NOT NULL,revision TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('off','recommendations')),restock TEXT NOT NULL CHECK(length(restock)<=1024),paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),pause_policy_revision TEXT) STRICT;
          CREATE TABLE requests(id TEXT PRIMARY KEY,account TEXT NOT NULL,shop TEXT NOT NULL,context TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,code TEXT NOT NULL,proposals TEXT NOT NULL,started INTEGER NOT NULL,updated INTEGER NOT NULL,model_status TEXT NOT NULL DEFAULT 'not_called',payload_hash TEXT) STRICT;
          CREATE INDEX request_scope ON requests(account,shop,started);
          CREATE TABLE decisions(proposal_id TEXT PRIMARY KEY,review_id TEXT UNIQUE,account TEXT NOT NULL,shop TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('reviewed','accepted','dismissed')),review_json TEXT,attempt_id TEXT,call_hash TEXT) STRICT;
          CREATE UNIQUE INDEX decision_attempt ON decisions(attempt_id) WHERE attempt_id IS NOT NULL;
          CREATE TABLE audit_decisions(proposal_id TEXT PRIMARY KEY REFERENCES decisions(proposal_id),reviewed_at INTEGER,accepted_at INTEGER,dismissed_at INTEGER,call_json TEXT,outcome_json TEXT,updated_at INTEGER NOT NULL) STRICT;
          PRAGMA user_version=5005;
        `);
          this.db.prepare("INSERT INTO metadata VALUES(1,?,0)").run(identity);
        });
      requireStorage(
        this.db.prepare("PRAGMA user_version").get()?.["user_version"] ===
          5005 &&
          this.db.prepare("SELECT identity FROM metadata").get()?.[
            "identity"
          ] === identity &&
          Object.values(this.db.prepare("PRAGMA quick_check").get()!)[0] ===
            "ok",
        "assistant identity/schema/integrity mismatch",
      );
      this.write(() =>
        this.db
          .prepare(
            "UPDATE requests SET status='expired',code='restart_unknown',updated=? WHERE status='pending'",
          )
          .run(Date.now()),
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private write<T>(fn: () => T): T {
    const disk = statfsSync(this.dir);
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix))
        bytes += statSync(this.path + suffix).size;
    requireStorage(
      disk.bavail * disk.bsize >= 16 * 1024 * 1024 && bytes < 64 * 1024 * 1024,
      "assistant storage headroom exhausted",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settings(account: string, shop: string): AssistantSettings {
    const r = this.db
      .prepare(
        "SELECT account,mode,revision,restock,paused,pause_policy_revision FROM settings WHERE shop=?",
      )
      .get(shop);
    requireStorage(!r || r["account"] === account, "assistant owner mismatch");
    return r
      ? {
          mode: String(r["mode"]),
          revision: String(r["revision"]),
          restock: assistantRestockLimits(JSON.parse(String(r["restock"]))),
          paused: r["paused"] === 1,
          pause_policy_revision:
            r["pause_policy_revision"] === null
              ? null
              : parseU64(r["pause_policy_revision"]),
        }
      : {
          mode: "off",
          revision: "1",
          restock: defaultAssistantRestockLimits(),
          paused: false,
          pause_policy_revision: null,
        };
  }
  configure(
    account: string,
    shop: string,
    mode: "off" | "recommendations",
  ): AssistantSettings {
    return this.write(() => {
      const old = this.settings(account, shop),
        exists = this.db
          .prepare("SELECT 1 FROM settings WHERE shop=?")
          .get(shop);
      requireStorage(
        mode === "off" || mode === "recommendations",
        "recommendation-only local mode",
      );
      if (old.mode === mode) return old;
      requireStorage(
        exists ||
          Number(
            this.db.prepare("SELECT count(*) AS n FROM settings").get()!["n"],
          ) < 1000,
        "assistant settings full",
      );
      const revision = parseU64((BigInt(old.revision) + 1n).toString());
      this.db
        .prepare(
          "INSERT INTO settings(shop,account,revision,mode,restock) VALUES(?,?,?,?,?) ON CONFLICT(shop) DO UPDATE SET revision=excluded.revision,mode=excluded.mode",
        )
        .run(shop, account, revision, mode, JSON.stringify(old.restock));
      this.db
        .prepare(
          "UPDATE requests SET status='expired',code='settings_changed',updated=? WHERE shop=? AND status IN ('pending','proposed')",
        )
        .run(Date.now(), shop);
      return { ...old, mode, revision };
    });
  }
  configureRestock(
    account: string,
    shop: string,
    expectedRevision: string,
    value: unknown,
  ): AssistantSettings {
    const restock = assistantRestockLimits(value);
    return this.write(() => {
      const old = this.settings(account, shop);
      requireStorage(
        old.revision === parseU64(expectedRevision),
        "assistant configuration changed",
      );
      if (
        canonicalLivingTownJson(old.restock) ===
        canonicalLivingTownJson(restock)
      )
        return old;
      requireStorage(
        this.db.prepare("SELECT 1 FROM settings WHERE shop=?").get(shop) ||
          Number(
            this.db.prepare("SELECT count(*) AS n FROM settings").get()!["n"],
          ) < 1000,
        "assistant settings full",
      );
      const revision = parseU64((BigInt(old.revision) + 1n).toString());
      this.db
        .prepare(
          "INSERT INTO settings(shop,account,revision,mode,restock) VALUES(?,?,?,?,?) ON CONFLICT(shop) DO UPDATE SET revision=excluded.revision,restock=excluded.restock",
        )
        .run(shop, account, revision, old.mode, JSON.stringify(restock));
      this.db
        .prepare(
          "UPDATE requests SET status='expired',code='settings_changed',updated=? WHERE shop=? AND status IN ('pending','proposed')",
        )
        .run(Date.now(), shop);
      return { ...old, revision, restock };
    });
  }
  isPaused(shop: string): boolean {
    return (
      this.db.prepare("SELECT paused FROM settings WHERE shop=?").get(shop)?.[
        "paused"
      ] === 1
    );
  }
  pause(account: string, shop: string): AssistantSettings {
    return this.write(() => {
      const old = this.settings(account, shop);
      requireStorage(
        this.db.prepare("SELECT 1 FROM settings WHERE shop=?").get(shop) ||
          Number(
            this.db.prepare("SELECT count(*) AS n FROM settings").get()!["n"],
          ) < 1000,
        "assistant settings full",
      );
      const revision = parseU64((BigInt(old.revision) + 1n).toString());
      this.db
        .prepare(
          "INSERT INTO settings VALUES(?,?,?,?,?,1,?) ON CONFLICT(shop) DO UPDATE SET revision=excluded.revision,mode='off',paused=1,pause_policy_revision=excluded.pause_policy_revision",
        )
        .run(
          shop,
          account,
          revision,
          "off",
          JSON.stringify(old.restock),
          old.paused ? old.pause_policy_revision : null,
        );
      this.db
        .prepare(
          "UPDATE requests SET status='expired',code='assistant_paused',updated=? WHERE shop=? AND status IN ('pending','proposed')",
        )
        .run(Date.now(), shop);
      return {
        ...old,
        revision,
        mode: "off",
        paused: true,
        pause_policy_revision: old.paused ? old.pause_policy_revision : null,
      };
    });
  }
  capturePausedPolicy(
    account: string,
    shop: string,
    revision: string,
    policyRevision: string,
  ): void {
    this.write(() => {
      const old = this.settings(account, shop);
      if (
        old.paused &&
        old.revision === revision &&
        old.pause_policy_revision === null
      )
        this.db
          .prepare("UPDATE settings SET pause_policy_revision=? WHERE shop=?")
          .run(parseU64(policyRevision), shop);
    });
  }
  resume(
    account: string,
    shop: string,
    revision: string,
    policyRevision: string,
    automatic: boolean,
  ): AssistantSettings {
    return this.write(() => {
      const old = this.settings(account, shop);
      requireStorage(
        old.paused && old.revision === revision,
        "explicit current paused revision required",
      );
      requireStorage(
        !automatic ||
          (old.pause_policy_revision !== null &&
            BigInt(policyRevision) > BigInt(old.pause_policy_revision)),
        "new owner-approved policy required after pause",
      );
      const next = parseU64((BigInt(old.revision) + 1n).toString());
      this.db
        .prepare(
          "UPDATE settings SET revision=?,mode='recommendations',paused=0 WHERE shop=?",
        )
        .run(next, shop);
      return { ...old, revision: next, mode: "recommendations", paused: false };
    });
  }
  get(id: string): AssistantRecord | null {
    const r = this.db.prepare("SELECT * FROM requests WHERE id=?").get(id);
    return r
      ? ({
          ...r,
          proposals: JSON.parse(String(r["proposals"])),
        } as unknown as AssistantRecord)
      : null;
  }
  begin(
    r: AssistantRecord,
    automatic = false,
  ): {
    record: AssistantRecord | null;
    admitted: boolean;
  } {
    return this.write(() => {
      const high = Number(
        this.db.prepare("SELECT high_water FROM metadata").get()!["high_water"],
      );
      requireStorage(
        Number.isSafeInteger(r.started) && r.started >= high,
        "assistant clock rollback",
      );
      const old = this.get(r.id);
      if (old) return { record: old, admitted: false };
      const setting = this.settings(r.account, r.shop);
      requireStorage(
        !setting.paused &&
          (automatic || setting.mode === "recommendations") &&
          setting.revision === r.revision,
        "assistant configuration changed",
      );
      if (
        this.db
          .prepare("SELECT 1 FROM requests WHERE shop=? AND status='pending'")
          .get(r.shop)
      )
        return { record: null, admitted: false };
      const counts = this.db
        .prepare(
          `SELECT count(*) AS global_day,
        sum(CASE WHEN shop=? AND started>? THEN 1 ELSE 0 END) AS shop_hour,
        sum(CASE WHEN shop=? THEN 1 ELSE 0 END) AS shop_day,
        sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        max(CASE WHEN shop=? THEN started ELSE 0 END) AS last
        FROM requests WHERE started>?`,
        )
        .get(
          r.shop,
          r.started - 3600000,
          r.shop,
          r.shop,
          r.started - 86400000,
        )!;
      // Keep rolling quotas even when config/snapshot changes or the process restarts.
      if (
        Number(counts["global_day"]) >= 100 ||
        Number(counts["shop_hour"]) >= 6 ||
        Number(counts["shop_day"]) >= 20 ||
        (Number(counts["last"]) > 0 &&
          r.started - Number(counts["last"]) < 60000) ||
        Number(counts["pending"]) >= 4
      )
        return { record: null, admitted: false };
      requireStorage(
        Number(
          this.db.prepare("SELECT count(*) AS n FROM requests").get()!["n"],
        ) < 10000,
        "assistant audit full",
      );
      this.db
        .prepare(
          "INSERT INTO requests(id,account,shop,context,revision,status,code,proposals,started,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          r.id,
          r.account,
          r.shop,
          r.context,
          r.revision,
          r.status,
          r.code,
          "[]",
          r.started,
          r.updated,
        );
      this.db.prepare("UPDATE metadata SET high_water=?").run(r.started);
      return { record: this.get(r.id), admitted: true };
    });
  }
  finish(
    id: string,
    status: AssistantRecord["status"],
    code: string,
    proposals: AssistantProposal[],
    now: number,
  ): boolean {
    return this.write(() => {
      const r = this.get(id);
      if (!r || r.status !== "pending") return false;
      const encoded = canonicalLivingTownJson(proposals);
      requireStorage(
        Buffer.byteLength(encoded) <= 8192 && /^[a-z_]{1,64}$/.test(code),
        "assistant audit bounds",
      );
      this.db
        .prepare(
          "UPDATE requests SET status=?,code=?,proposals=?,updated=? WHERE id=?",
        )
        .run(status, code, encoded, now, id);
      return true;
    });
  }
  model(
    id: string,
    status: "reserved" | "dispatched" | "proposed" | "rejected",
    code: string,
    payloadHash: string | null = null,
  ): void {
    requireStorage(
      payloadHash === null || /^[a-f0-9]{64}$/.test(payloadHash),
      "invalid inference payload hash",
    );
    this.write(() =>
      this.db
        .prepare(
          "UPDATE requests SET model_status=?,code=?,payload_hash=coalesce(payload_hash,?),updated=? WHERE id=? AND status='pending'",
        )
        .run(status, code, payloadHash, Date.now(), id),
    );
  }
  expire(shop: string, chainNs: string, context: string | null = null): void {
    this.write(() => {
      const rows = this.db
        .prepare("SELECT id FROM requests WHERE shop=? AND status='proposed'")
        .all(shop);
      for (const row of rows) {
        const r = this.get(String(row["id"]))!;
        if (
          (context !== null && r.context !== context) ||
          r.proposals.some((p) => BigInt(p.expires_at_ns) <= BigInt(chainNs))
        )
          this.db
            .prepare(
              "UPDATE requests SET status='expired',code='expired_or_stale',updated=? WHERE id=?",
            )
            .run(Date.now(), r.id);
      }
    });
  }
  history(account: string, shop: string): AssistantRecord[] {
    this.settings(account, shop);
    return this.db
      .prepare(
        "SELECT id FROM requests WHERE account=? AND shop=? ORDER BY started DESC,id DESC LIMIT 4",
      )
      .all(account, shop)
      .map((r) => {
        const record = this.get(String(r["id"]))!;
        return {
          ...record,
          decisions: record.proposals.flatMap((p) => {
            const d = this.decision(account, shop, p.proposal_id);
            return d
              ? [
                  {
                    proposal_id: p.proposal_id,
                    status: d.status,
                    attempt_id: d.attempt_id,
                  },
                ]
              : [];
          }),
        };
      });
  }
  proposal(
    account: string,
    shop: string,
    proposalId: string,
  ): { record: AssistantRecord; proposal: AssistantProposal } {
    for (const record of this.history(account, shop)) {
      const proposal = record.proposals.find(
        (p) => p.proposal_id === proposalId,
      );
      if (proposal) return { record, proposal };
    }
    throw new Error("Assistant proposal unavailable");
  }
  decision(
    account: string,
    shop: string,
    proposalId: string,
  ): {
    status: string;
    attempt_id: string | null;
    call_hash: string | null;
    review: AssistantManualReview | null;
  } | null {
    const r = this.db
      .prepare(
        "SELECT * FROM decisions WHERE proposal_id=? AND account=? AND shop=?",
      )
      .get(proposalId, account, shop);
    return r
      ? {
          status: String(r["status"]),
          attempt_id: r["attempt_id"] as string | null,
          call_hash: r["call_hash"] as string | null,
          review: r["review_json"]
            ? JSON.parse(String(r["review_json"]))
            : null,
        }
      : null;
  }
  saveReview(
    account: string,
    shop: string,
    review: AssistantManualReview,
  ): void {
    this.write(() => {
      const old = this.decision(account, shop, review.proposal.proposal_id);
      requireStorage(
        !old ||
          (old.status === "reviewed" &&
            old.review?.review_id === review.review_id),
        "proposal decision already closed",
      );
      if (old) return;
      requireStorage(
        Number(
          this.db.prepare("SELECT count(*) AS n FROM decisions").get()!["n"],
        ) < 20000,
        "assistant decision audit full",
      );
      this.db
        .prepare(
          "INSERT INTO decisions VALUES(?,?,?,?, 'reviewed',?,NULL,NULL)",
        )
        .run(
          review.proposal.proposal_id,
          review.review_id,
          account,
          shop,
          canonicalLivingTownJson(review),
        );
      this.db
        .prepare(
          "INSERT INTO audit_decisions(proposal_id,reviewed_at,updated_at) VALUES(?,?,?)",
        )
        .run(review.proposal.proposal_id, Date.now(), Date.now());
    });
  }
  claimReview(
    account: string,
    shop: string,
    proposalId: string,
    attemptId: string,
    callHash: string,
    call?: unknown,
  ): void {
    this.write(() => {
      const d = this.decision(account, shop, proposalId);
      const config = this.settings(account, shop);
      requireStorage(
        d &&
          d.review &&
          !config.paused &&
          config.mode === "recommendations" &&
          config.revision === d.review.proposal.config_revision &&
          this.proposal(account, shop, proposalId).record.status ===
            "proposed" &&
          (d.status === "reviewed" ||
            (d.status === "accepted" &&
              d.attempt_id === attemptId &&
              d.call_hash === callHash)),
        "assistant acceptance replay/conflict",
      );
      this.db
        .prepare(
          "UPDATE decisions SET status='accepted',attempt_id=?,call_hash=? WHERE proposal_id=?",
        )
        .run(attemptId, callHash, proposalId);
      this.db
        .prepare(
          "INSERT INTO audit_decisions(proposal_id,accepted_at,call_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET accepted_at=coalesce(accepted_at,excluded.accepted_at),call_json=coalesce(call_json,excluded.call_json),updated_at=excluded.updated_at",
        )
        .run(
          proposalId,
          Date.now(),
          call ? canonicalLivingTownJson(call) : null,
          Date.now(),
        );
    });
  }
  dismiss(account: string, shop: string, proposalId: string): void {
    this.proposal(account, shop, proposalId);
    this.write(() => {
      const d = this.decision(account, shop, proposalId);
      requireStorage(
        !d || d.status !== "accepted",
        "accepted attempt needs original transaction reconciliation",
      );
      requireStorage(
        d ||
          Number(
            this.db.prepare("SELECT count(*) AS n FROM decisions").get()!["n"],
          ) < 20000,
        "assistant decision audit full",
      );
      this.db
        .prepare(
          "INSERT INTO decisions(proposal_id,account,shop,status) VALUES(?,?,?,'dismissed') ON CONFLICT(proposal_id) DO UPDATE SET status='dismissed'",
        )
        .run(proposalId, account, shop);
      this.db
        .prepare(
          "INSERT INTO audit_decisions(proposal_id,dismissed_at,updated_at) VALUES(?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET dismissed_at=coalesce(dismissed_at,excluded.dismissed_at),updated_at=excluded.updated_at",
        )
        .run(proposalId, Date.now(), Date.now());
    });
  }
  /** Owner-scoped retained audit, independent of the four actionable requests. */
  auditRecords(account: string, shop: string): AssistantRecord[] {
    this.settings(account, shop);
    return this.db
      .prepare(
        "SELECT id FROM requests WHERE account=? AND shop=? ORDER BY started DESC,id DESC LIMIT 32",
      )
      .all(account, shop)
      .map((r) => this.get(String(r["id"]))!);
  }
  auditDecision(
    account: string,
    shop: string,
    proposal: string,
  ):
    | (NonNullable<ReturnType<AssistantStore["decision"]>> &
        Record<string, unknown>)
    | null {
    const decision = this.decision(account, shop, proposal);
    if (!decision) return null;
    return {
      ...decision,
      ...this.db
        .prepare("SELECT * FROM audit_decisions WHERE proposal_id=?")
        .get(proposal),
    };
  }
  saveOutcome(
    account: string,
    shop: string,
    proposal: string,
    attempt: string,
    outcome: unknown,
  ): void {
    this.write(() => {
      const d = this.auditDecision(account, shop, proposal);
      requireStorage(
        d?.status === "accepted" && d.attempt_id === attempt,
        "audit acceptance mismatch",
      );
      const old = d["outcome_json"]
        ? (JSON.parse(String(d["outcome_json"])) as { status: string })
        : null;
      if (old && ["confirmed", "rejected"].includes(old.status)) return;
      this.db
        .prepare(
          "UPDATE audit_decisions SET outcome_json=?,updated_at=? WHERE proposal_id=?",
        )
        .run(JSON.stringify(outcome), Date.now(), proposal);
    });
  }
  close(): void {
    this.db.close();
  }
}
