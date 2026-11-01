import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createMarketCall, parseU64 } from "@bot-bazaar/chain";
import type { MerchantId } from "@bot-bazaar/chain";
import type { DiscoverySignal, DiscoveryState } from "../discovery/types.js";
import {
  id,
  json,
  merchant,
  requireStorage,
  sha256,
  timestamp,
} from "../storage/validation.js";
import type { Intent } from "../storage/database.js";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Write = <T>(operation: () => T) => T;
const names = ["rex", "luna", "bolt"] as const;
const pending = "('prepared','signed','submitted','unknown')";

export class SchedulerRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly namespace: string,
    private readonly write: Write,
  ) {}
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  private all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args);
  }
  private run(sql: string, ...args: SQLInputValue[]): void {
    this.db.prepare(sql).run(...args);
  }
  private rootId(key: string): string {
    return `root:${sha256(this.namespace + ":" + key)}`;
  }
  private turn(
    job: string,
    name: MerchantId,
    phase: "decision" | "followup",
    source: string,
  ): void {
    this.run(
      "INSERT OR IGNORE INTO scheduler_turns VALUES(?,?,?,?,?,'queued')",
      `turn:${sha256(json([job, name, phase, source]))}`,
      job,
      name,
      phase,
      source,
    );
  }
  private canonical(signal: DiscoverySignal): {
    key: string;
    fingerprint: string;
  } {
    if (signal.kind === "player_purchase") {
      parseU64(signal.trade.trade_id);
      requireStorage(
        signal.trade.kind === "player_purchase" &&
          signal.trade.seller.kind === "merchant" &&
          signal.trade.seller.merchant_id === signal.merchantId,
        "invalid purchase trigger",
      );
      return {
        key: `purchase:${signal.trade.trade_id}`,
        fingerprint: sha256(json(signal.trade)),
      };
    }
    if (signal.kind === "offer_pending") {
      parseU64(signal.offer.offer_id);
      requireStorage(
        signal.offer.status === "pending" &&
          signal.offer.counterparty === signal.merchantId,
        "invalid offer wake",
      );
      return {
        key: `offer:${signal.offer.offer_id}`,
        fingerprint: sha256(json(signal.offer)),
      };
    }
    [signal.after ?? "0", signal.prunedThrough, signal.upperBound].forEach(
      parseU64,
    );
    requireStorage(
      ["offers", "trades"].includes(signal.stream) &&
        BigInt(signal.after ?? "0") < BigInt(signal.prunedThrough) &&
        BigInt(signal.prunedThrough) <= BigInt(signal.upperBound),
      "invalid gap interval",
    );
    const key = `gap:${signal.stream}:${signal.after ?? "0"}:${signal.prunedThrough}:${signal.upperBound}`;
    return { key, fingerprint: sha256(key) };
  }
  private expireQueued(now: number): void {
    this.run(
      "UPDATE jobs SET status='expired',updated_at=? WHERE status='queued' AND deadline<=? AND id IN (SELECT job_id FROM scheduler_roots) AND NOT EXISTS(SELECT 1 FROM intents WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM merchant_locks WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM offers WHERE job_id=jobs.id AND (status='pending' OR (status IN ('expired','pruned') AND cleanup_ack=0)))",
      now,
      now,
    );
    this.run(
      "UPDATE scheduler_turns SET status='skipped' WHERE status='queued' AND job_id IN (SELECT id FROM jobs WHERE status IN ('expired','failed','completed') OR deadline<=?)",
      now,
    );
  }
  private coalesce(now: number): string {
    let row = this.one(
      "SELECT jobs.id FROM jobs JOIN scheduler_roots r ON r.job_id=jobs.id WHERE jobs.status='queued' AND jobs.deadline>? AND r.kind='catchup' AND NOT EXISTS(SELECT 1 FROM intents WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM merchant_locks WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM offers WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM scheduler_turns WHERE job_id=jobs.id AND (status='running' OR source_key LIKE 'offer:%')) ORDER BY jobs.created_at,jobs.id LIMIT 1",
      now,
    );
    if (!row)
      row = this.one(
        "SELECT jobs.id FROM jobs JOIN scheduler_roots r ON r.job_id=jobs.id WHERE jobs.status='queued' AND jobs.deadline>? AND NOT EXISTS(SELECT 1 FROM intents WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM merchant_locks WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM offers WHERE job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM scheduler_turns WHERE job_id=jobs.id AND (status='running' OR source_key LIKE 'offer:%')) ORDER BY jobs.created_at DESC,jobs.id DESC LIMIT 1",
        now,
      );
    requireStorage(row, "queue full; no safe queued catch-up root");
    const job = String(row["id"]);
    this.run("UPDATE scheduler_roots SET kind='catchup' WHERE job_id=?", job);
    for (const name of names) this.turn(job, name, "decision", "initial");
    return job;
  }
  private ingest(
    signal: DiscoverySignal,
    source: string,
    now: number,
  ): string | null {
    const { key, fingerprint } = this.canonical(signal);
    id(source);
    const sourceRow = this.one(
      "SELECT business_key FROM scheduler_sources WHERE source_key=?",
      source,
    );
    requireStorage(
      !sourceRow || sourceRow["business_key"] === key,
      "observation source identity conflict",
    );
    const existing = this.one(
      "SELECT * FROM scheduler_inputs WHERE business_key=?",
      key,
    );
    if (existing) {
      requireStorage(
        existing["fingerprint"] === fingerprint,
        "business trigger evidence conflict",
      );
      this.run(
        "INSERT OR IGNORE INTO scheduler_sources VALUES(?,?)",
        source,
        key,
      );
      return existing["job_id"] === null ? null : String(existing["job_id"]);
    }
    let job: string | null,
      disposition = "assigned";
    if (signal.kind === "offer_pending") {
      job =
        (this.one(
          "SELECT offers.job_id FROM offers JOIN scheduler_roots r ON r.job_id=offers.job_id WHERE offer_id=?",
          signal.offer.offer_id,
        )?.["job_id"] as string | undefined) ?? null;
      if (job) this.attachOffer(job, signal);
      else disposition = "quarantined";
    } else {
      const created =
        signal.kind === "player_purchase"
          ? Math.min(now, Number(BigInt(signal.trade.settled_at_ns) / 1000000n))
          : now;
      const deadline = created + 120000;
      const count = Number(
        this.one("SELECT count(*) AS n FROM jobs WHERE status='queued'")!["n"],
      );
      if (count >= 100 && deadline > now) job = this.coalesce(now);
      else {
        job = this.rootId(key);
        this.run(
          "INSERT INTO jobs(id,trigger_key,trigger_ref,status,created_at,updated_at,deadline) VALUES(?,?,?,?,?,?,?)",
          job,
          key,
          key,
          deadline > now ? "queued" : "expired",
          created,
          now,
          deadline,
        );
        this.run(
          "INSERT INTO scheduler_roots(job_id,kind,has_gap) VALUES(?,?,?)",
          job,
          signal.kind === "player_purchase" ? "purchase" : "gap",
          Number(signal.kind === "history_gap"),
        );
        if (deadline > now)
          for (const name of signal.kind === "player_purchase"
            ? [signal.merchantId]
            : names)
            this.turn(job, name, "decision", "initial");
      }
    }
    this.run(
      "INSERT INTO scheduler_inputs(business_key,fingerprint,payload_json,job_id,disposition,observed_at) VALUES(?,?,?,?,?,?)",
      key,
      fingerprint,
      json(signal),
      job,
      disposition,
      now,
    );
    const seq = Number(
      this.one("SELECT seq FROM scheduler_inputs WHERE business_key=?", key)![
        "seq"
      ],
    );
    requireStorage(Number.isSafeInteger(seq), "scheduler sequence overflow");
    if (job)
      this.run(
        "UPDATE scheduler_roots SET first_seq=min(coalesce(first_seq,?),?),last_seq=max(coalesce(last_seq,?),?),has_gap=max(has_gap,?) WHERE job_id=?",
        seq,
        seq,
        seq,
        seq,
        Number(signal.kind === "history_gap"),
        job,
      );
    this.run("INSERT INTO scheduler_sources VALUES(?,?)", source, key);
    return job;
  }
  private attachOffer(
    job: string,
    signal: Extract<DiscoverySignal, { kind: "offer_pending" }>,
  ): void {
    const row = this.one("SELECT status,deadline FROM jobs WHERE id=?", job);
    if (row && ["queued", "active"].includes(String(row["status"])))
      this.turn(
        job,
        signal.merchantId,
        "decision",
        `offer:${signal.offer.offer_id}`,
      );
  }
  private advanceBoundary(): void {
    const blocked = this.one(
      "SELECT min(i.seq) AS n FROM scheduler_inputs i LEFT JOIN jobs j ON j.id=i.job_id WHERE i.disposition='quarantined' OR (i.disposition='assigned' AND j.status IN ('active','queued'))",
    )!["n"];
    const boundary =
      blocked === null
        ? Number(
            this.one("SELECT coalesce(max(seq),0) AS n FROM scheduler_inputs")![
              "n"
            ],
          )
        : Number(blocked) - 1;
    this.run(
      "UPDATE scheduler_state SET completed_seq=max(completed_seq,?) WHERE singleton=1",
      boundary,
    );
  }
  drainInbox(now = Date.now()): void {
    timestamp(now);
    this.write(() => {
      this.expireQueued(now);
      for (const row of this.all(
        "SELECT signal_key,payload_json FROM discovery_signals WHERE handled=0 ORDER BY observed_at,signal_key LIMIT 256",
      )) {
        const signal = JSON.parse(
          String(row["payload_json"]),
        ) as DiscoverySignal;
        this.ingest(signal, `view:${String(row["signal_key"])}`, now);
        this.run(
          "DELETE FROM discovery_signals WHERE signal_key=?",
          row["signal_key"]!,
        );
      }
      for (const row of this.all(
        "SELECT business_key,payload_json FROM scheduler_inputs WHERE disposition='quarantined' LIMIT 256",
      )) {
        const signal = JSON.parse(
          String(row["payload_json"]),
        ) as DiscoverySignal;
        if (signal.kind !== "offer_pending") continue;
        const linked = this.one(
          "SELECT offers.job_id FROM offers JOIN scheduler_roots r ON r.job_id=offers.job_id WHERE offer_id=?",
          signal.offer.offer_id,
        );
        if (linked?.["job_id"]) {
          this.attachOffer(String(linked["job_id"]), signal);
          this.run(
            "UPDATE scheduler_inputs SET job_id=?,disposition='assigned' WHERE business_key=?",
            linked["job_id"]!,
            row["business_key"]!,
          );
          const seq = this.one(
            "SELECT seq FROM scheduler_inputs WHERE business_key=?",
            row["business_key"]!,
          )!["seq"]!;
          this.run(
            "UPDATE scheduler_roots SET first_seq=min(coalesce(first_seq,?),?),last_seq=max(coalesce(last_seq,?),?) WHERE job_id=?",
            seq,
            seq,
            seq,
            seq,
            linked["job_id"]!,
          );
        }
      }
      this.advanceBoundary();
    });
  }
  observeVerifiedPurchase(
    signal: Extract<DiscoverySignal, { kind: "player_purchase" }>,
    transactionHash: string,
    now = Date.now(),
  ): string | null {
    timestamp(now);
    requireStorage(
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(transactionHash),
      "invalid transaction identity",
    );
    return this.write(() => {
      this.expireQueued(now);
      const job = this.ingest(signal, `receipt:${transactionHash}`, now);
      this.advanceBoundary();
      return job;
    });
  }
  inputs(): Row[] {
    return this.all("SELECT * FROM scheduler_inputs ORDER BY seq");
  }
  roots(): Row[] {
    return this.all(
      "SELECT r.*,j.status,j.deadline FROM scheduler_roots r JOIN jobs j ON j.id=r.job_id ORDER BY r.first_seq,r.job_id",
    );
  }
  turns(job: string): Row[] {
    return this.all(
      "SELECT * FROM scheduler_turns WHERE job_id=? ORDER BY phase,merchant_id,id",
      id(job),
    );
  }
  nextTurn(): Row | undefined {
    // A candidate is not authorization. claimTurn rechecks all gates atomically.
    const active = this.one(
      "SELECT j.id FROM jobs j JOIN scheduler_roots r ON r.job_id=j.id WHERE j.status='active'",
    );
    const root =
      active ??
      this.one(
        "SELECT j.id FROM jobs j JOIN scheduler_roots r ON r.job_id=j.id WHERE j.status='queued' ORDER BY j.created_at,r.first_seq,j.id LIMIT 1",
      );
    if (!root) return undefined;
    return this.one(
      "SELECT * FROM scheduler_turns WHERE job_id=? AND status='queued' ORDER BY CASE WHEN source_key LIKE 'offer:%' THEN 0 WHEN phase='followup' THEN 2 ELSE 1 END,merchant_id,id LIMIT 1",
      root["id"]!,
    );
  }
  state(): Row {
    return this.one("SELECT * FROM scheduler_state WHERE singleton=1")!;
  }
  private eligible(job: string, now: number): void {
    const row = this.one("SELECT status,deadline FROM jobs WHERE id=?", job);
    requireStorage(
      row &&
        ["queued", "active"].includes(String(row["status"])) &&
        Number(row["deadline"]) > now,
      "root inactive or expired",
    );
    requireStorage(
      this.one("SELECT recovery_required FROM deployment")![
        "recovery_required"
      ] === 0,
      "reconciliation required before turns",
    );
    const discovery = this.one(
      "SELECT state_json FROM discovery_state WHERE singleton=1",
    );
    requireStorage(discovery, "authoritative snapshot required");
    const state = JSON.parse(String(discovery["state_json"])) as DiscoveryState;
    requireStorage(
      !state.market.data.paused &&
        now - state.observedAt <= 15000 &&
        state.observedAt <= now + 5000,
      "market paused or snapshot stale",
    );
  }
  claimTurn(turnId: string, now = Date.now()): Row {
    id(turnId);
    timestamp(now);
    return this.write(() => {
      const turn = this.one("SELECT * FROM scheduler_turns WHERE id=?", turnId);
      requireStorage(
        turn?.["status"] === "queued",
        "turn already claimed or closed",
      );
      const job = String(turn["job_id"]);
      this.eligible(job, now);
      requireStorage(
        !this.one(
          "SELECT business_key FROM scheduler_inputs WHERE disposition='quarantined' AND (json_extract(payload_json,'$.offer.buyer')=? OR json_extract(payload_json,'$.offer.seller')=?)",
          turn["merchant_id"]!,
          turn["merchant_id"]!,
        ),
        "merchant has quarantined controller activity",
      );
      if (String(turn["source_key"]).startsWith("offer:")) {
        const state = JSON.parse(
          String(
            this.one(
              "SELECT state_json FROM discovery_state WHERE singleton=1",
            )!["state_json"],
          ),
        ) as DiscoveryState;
        const offer = state.offers.find(
          (row) => row.offer_id === String(turn["source_key"]).slice(6),
        );
        requireStorage(
          offer?.status === "pending" &&
            offer.counterparty === turn["merchant_id"] &&
            BigInt(offer.expires_at_ns) > BigInt(state.block.timestampNs),
          "offer is no longer live for counterparty",
        );
      }
      const root = this.one(
        "SELECT model_calls FROM scheduler_roots WHERE job_id=?",
        job,
      )!;
      requireStorage(
        Number(root["model_calls"]) < 6,
        "root model-call budget exhausted",
      );
      const lock = this.one(
        "SELECT job_id FROM merchant_locks WHERE merchant_id=? AND kind='commitment'",
        turn["merchant_id"]!,
      );
      requireStorage(
        !lock || lock["job_id"] === job,
        "merchant has another commitment",
      );
      requireStorage(
        !this.one(
          `SELECT id FROM intents WHERE merchant_id=? AND status IN ${pending}`,
          turn["merchant_id"]!,
        ),
        "merchant mutation unresolved",
      );
      this.run(
        "UPDATE jobs SET status='active',updated_at=? WHERE id=?",
        now,
        job,
      );
      this.run(
        "INSERT INTO merchant_locks VALUES(?,'controller',?,?) ON CONFLICT(merchant_id,kind) DO UPDATE SET acquired_at=excluded.acquired_at WHERE merchant_locks.job_id=excluded.job_id",
        turn["merchant_id"]!,
        job,
        now,
      );
      requireStorage(
        this.one(
          "SELECT job_id FROM merchant_locks WHERE merchant_id=? AND kind='controller'",
          turn["merchant_id"]!,
        )?.["job_id"] === job,
        "merchant controller is busy",
      );
      this.run(
        "UPDATE scheduler_turns SET status='running' WHERE id=?",
        turnId,
      );
      this.run(
        "UPDATE scheduler_roots SET model_calls=model_calls+1 WHERE job_id=?",
        job,
      );
      return this.one("SELECT * FROM scheduler_turns WHERE id=?", turnId)!;
    });
  }
  finishTurn(turnId: string): void {
    this.write(() => {
      const turn = this.one(
        "SELECT * FROM scheduler_turns WHERE id=?",
        id(turnId),
      );
      requireStorage(turn?.["status"] === "running", "turn is not running");
      requireStorage(
        !this.one(
          `SELECT id FROM intents WHERE merchant_id=? AND status IN ${pending}`,
          turn["merchant_id"]!,
        ),
        "unresolved mutation retains turn",
      );
      this.run(
        "UPDATE scheduler_turns SET status='completed' WHERE id=?",
        turnId,
      );
      this.run(
        "DELETE FROM merchant_locks WHERE merchant_id=? AND kind='controller' AND job_id=?",
        turn["merchant_id"]!,
        turn["job_id"]!,
      );
    });
  }
  reserveMutation(turnId: string, intent: Intent, now = Date.now()): void {
    id(intent.id);
    id(turnId);
    merchant(intent.merchantId);
    timestamp(now);
    const args = json(createMarketCall(intent.method, intent.args).args);
    this.write(() => {
      this.eligible(intent.jobId, now);
      const turn = this.one("SELECT * FROM scheduler_turns WHERE id=?", turnId);
      requireStorage(
        turn?.["status"] === "running" &&
          turn["job_id"] === intent.jobId &&
          turn["merchant_id"] === intent.merchantId,
        "mutation turn identity mismatch",
      );
      requireStorage(
        turn["phase"] !== "followup" || intent.method === "set_listing",
        "follow-up permits listing only",
      );
      requireStorage(
        !this.one(
          `SELECT id FROM intents WHERE merchant_id=? AND status IN ${pending}`,
          intent.merchantId,
        ),
        "merchant mutation unresolved",
      );
      requireStorage(
        Number(
          this.one(
            "SELECT mutations FROM scheduler_roots WHERE job_id=?",
            intent.jobId,
          )!["mutations"],
        ) < 8,
        "root mutation budget exhausted",
      );
      const policyStep = this.one(
        "SELECT * FROM policy_steps WHERE intent_id=?",
        intent.id,
      );
      const held = Number(
        this.one(
          "SELECT coalesce(sum(slots_remaining),0) AS n FROM policy_plans WHERE job_id=?",
          intent.jobId,
        )!["n"],
      );
      const spent = Number(
        this.one(
          "SELECT mutations FROM scheduler_roots WHERE job_id=?",
          intent.jobId,
        )!["mutations"],
      );
      requireStorage(
        spent + held + (policyStep ? 0 : 1) <= 8,
        "mutation capacity reserved by policy",
      );
      if (policyStep) {
        requireStorage(
          policyStep["reserved"] === 0,
          "policy step already reserved",
        );
        const changed = this.db
          .prepare(
            "UPDATE policy_plans SET slots_remaining=slots_remaining-1 WHERE decision_id=? AND slots_remaining>0",
          )
          .run(policyStep["decision_id"]!);
        requireStorage(changed.changes === 1, "policy capacity exhausted");
        this.run(
          "UPDATE policy_steps SET reserved=1 WHERE intent_id=?",
          intent.id,
        );
      }
      this.run(
        "INSERT INTO scheduler_mutations(intent_id,turn_id,method,args_json,merchant_id,job_id,purpose) VALUES(?,?,?,?,?,?,?)",
        intent.id,
        turnId,
        intent.method,
        args,
        intent.merchantId,
        intent.jobId,
        policyStep?.["purpose"] ?? "model",
      );
      this.run(
        "UPDATE scheduler_roots SET mutations=mutations+1 WHERE job_id=?",
        intent.jobId,
      );
    });
  }
  // Called inside WorkerStore's existing mutation transaction, never nested.
  assertIntent(intent: Intent, argsJson: string, now: number): void {
    if (
      !this.one(
        "SELECT job_id FROM scheduler_roots WHERE job_id=?",
        intent.jobId,
      )
    )
      return;
    this.eligible(intent.jobId, now);
    const row = this.one(
      "SELECT m.*,t.status AS turn_status FROM scheduler_mutations m JOIN scheduler_turns t ON t.id=m.turn_id WHERE intent_id=?",
      intent.id,
    );
    requireStorage(
      row?.["job_id"] === intent.jobId &&
        row["merchant_id"] === intent.merchantId &&
        row["method"] === intent.method &&
        row["args_json"] === argsJson &&
        row["turn_status"] === "running",
      "persisted mutation reservation required",
    );
  }
  settlement(
    job: string,
    offerId: string,
    participants: readonly MerchantId[],
  ): void {
    requireStorage(
      participants.length === 2 && new Set(participants).size === 2,
      "settlement requires two participants",
    );
    if (!this.one("SELECT job_id FROM scheduler_roots WHERE job_id=?", job))
      return;
    for (const name of participants)
      this.turn(job, merchant(name), "followup", `settled:${offerId}`);
  }
  finishRoot(job: string, now = Date.now()): void {
    id(job);
    timestamp(now);
    this.write(() => {
      const row = this.one("SELECT * FROM jobs WHERE id=?", job);
      requireStorage(
        row &&
          ["active", "queued"].includes(String(row["status"])) &&
          this.one("SELECT job_id FROM scheduler_roots WHERE job_id=?", job),
        "root already closed or missing",
      );
      if (
        Number(row["deadline"]) <= now ||
        Number(
          this.one(
            "SELECT model_calls FROM scheduler_roots WHERE job_id=?",
            job,
          )!["model_calls"],
        ) >= 6
      )
        this.run(
          "UPDATE scheduler_turns SET status='skipped' WHERE job_id=? AND status='queued'",
          job,
        );
      requireStorage(
        !this.one(
          "SELECT id FROM scheduler_turns WHERE job_id=? AND status IN ('queued','running')",
          job,
        ) &&
          !this.one(
            `SELECT id FROM intents WHERE job_id=? AND status IN ${pending}`,
            job,
          ) &&
          !this.one("SELECT job_id FROM merchant_locks WHERE job_id=?", job) &&
          !this.one(
            "SELECT offer_id FROM offers WHERE job_id=? AND (status='pending' OR (status IN ('expired','pruned') AND cleanup_ack=0))",
            job,
          ),
        "root retains pending work",
      );
      this.run(
        "UPDATE jobs SET status=?,updated_at=? WHERE id=?",
        Number(row["deadline"]) <= now ? "expired" : "completed",
        now,
        job,
      );
      this.advanceBoundary();
    });
  }
  compact(now = Date.now()): void {
    timestamp(now);
    this.write(() => {
      this.advanceBoundary();
      this.run(
        "UPDATE scheduler_inputs SET payload_json=NULL WHERE payload_json IS NOT NULL AND seq<=(SELECT completed_seq FROM scheduler_state) AND disposition!='quarantined' AND (observed_at<? OR seq IN (SELECT seq FROM scheduler_inputs WHERE payload_json IS NOT NULL ORDER BY seq DESC LIMIT -1 OFFSET 10000))",
        now - 7 * 86400000,
      );
    });
  }
}
