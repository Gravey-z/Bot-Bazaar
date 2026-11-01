import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  PublicDeployment,
  PublicChainObservation,
  ActivityPage,
} from "@bot-bazaar/shared";
import type { DeploymentIdentity } from "@bot-bazaar/chain";
import { parseU64, ChainValidationError } from "@bot-bazaar/chain";
import type { DiscoveryState } from "../discovery/types.js";
import { DecisionValidationError } from "../decisions/schema.js";
import {
  identityJson,
  json,
  sha256,
  requireStorage,
  StorageError,
} from "../storage/validation.js";
import {
  draft,
  projectDecision,
  projectIntent,
  publicTrade,
  publicEntry,
  safeId,
  merchant,
  hash,
} from "./projection.js";
import type { Draft, Row } from "./projection.js";
export class ReadApiError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    readonly code:
      | "invalid_query"
      | "invalid_cursor"
      | "cursor_deployment_mismatch"
      | "feed_generation_mismatch"
      | "read_unavailable",
  ) {
    super(code);
  }
}
const maxSequence = 9223372036854775807n;
export class ActivityRepository {
  readonly deployment: PublicDeployment;
  constructor(
    private readonly db: DatabaseSync,
    identity: DeploymentIdentity,
  ) {
    this.deployment = Object.freeze({
      id: sha256(identityJson(identity)),
      network_id: "testnet",
      contract_id: identity.contractId,
      expected_code_hash: identity.codeHash,
      identity_kind: "configured",
    });
  }
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  generation(): string {
    return String(
      this.one("SELECT feed_generation FROM deployment")!["feed_generation"],
    );
  }
  state(): {
    high_water_sequence: string;
    pruned_through: string;
    initial_gap: boolean;
  } {
    const row = this.one(
      "SELECT CAST(last_sequence AS TEXT) AS last,CAST(pruned_through AS TEXT) AS pruned,initial_gap FROM activity_state",
    )!;
    return {
      high_water_sequence: String(row["last"]),
      pruned_through: String(row["pruned"]),
      initial_gap: row["initial_gap"] === 1,
    };
  }
  chain(now: number): PublicChainObservation {
    const row = this.one(
        "SELECT observed_height,observed_hash,observed_revision,observed_at FROM deployment",
      )!,
      state = this.one(
        "SELECT json_extract(state_json,'$.market.data.paused') AS paused FROM discovery_state",
      );
    const time =
        typeof row["observed_at"] === "number" ? row["observed_at"] : null,
      age = time === null ? null : now - time;
    return {
      block_height:
        row["observed_height"] === null
          ? null
          : parseU64(row["observed_height"]),
      block_hash: hash(row["observed_hash"]),
      market_revision:
        row["observed_revision"] === null
          ? null
          : parseU64(row["observed_revision"]),
      observed_at: time,
      age_ms: age,
      stale: age === null || age < 0 || age > 15000,
      paused: state ? state["paused"] === 1 : null,
    };
  }
  private append(key: string, event: Draft): void {
    if (this.one("SELECT event_key FROM activity_keys WHERE event_key=?", key))
      return;
    json(
      {
        ...event,
        sequence: String(maxSequence),
        id: sha256(this.deployment.id + ":" + key),
      },
      4096,
    );
    this.db
      .prepare(
        "INSERT INTO activity_events(event_key,observed_at,entry_json) VALUES(?,?,?)",
      )
      .run(key, event.observed_at, json(event, 4096));
    this.db.prepare("INSERT INTO activity_keys VALUES(?)").run(key);
  }
  private inference(row: Row): void {
    const id = String(row["request_id"]),
      at = Number(row["updated_at"]),
      base = {
        merchant_id: merchant(row["merchant_id"]),
        root_id: safeId(row["job_id"]),
        decision_id: safeId(id),
        late_ignored: row["late_ignored"] === 1,
      };
    if (row["dispatched_at"] !== null)
      this.append(`inference:${id}:thinking`, {
        ...draft(
          "decision",
          id,
          "system",
          "thinking",
          "inference",
          Number(row["dispatched_at"]),
        ),
        ...base,
        code: "inference_dispatched",
      });
    if (row["schema_outcome"] === "invalid")
      this.append(`inference:${id}:invalid`, {
        ...draft("decision", id, "system", "rejected", "validation", at),
        ...base,
        code: "schema_invalid",
        reason: "AI validation error",
        reason_kind: "status",
      });
    const outcome = String(row["outcome"]);
    if (["failed", "unknown", "revoked"].includes(outcome))
      this.append(`inference:${id}:${outcome}`, {
        ...draft(
          "decision",
          id,
          "system",
          outcome === "failed" ? "failed" : "unknown",
          "inference",
          at,
        ),
        ...base,
        code: outcome === "revoked" ? "response_revoked" : "ai_unavailable",
        reason: "AI unavailable",
        reason_kind: "status",
      });
    const policy = String(row["policy_outcome"]);
    if (policy !== "not_evaluated") {
      const decision = this.one(
        "SELECT action_json FROM decisions WHERE id=?",
        id,
      );
      const method = decision
        ? JSON.parse(String(decision["action_json"])).method
        : null;
      const status =
        policy === "approved"
          ? "proposed"
          : policy === "offchain"
            ? method === "hold"
              ? "held"
              : "rejected"
            : policy === "rejected"
              ? "rejected"
              : "unknown";
      this.append(`inference:${id}:policy:${policy}`, {
        ...draft(
          "decision",
          id,
          "policy",
          status,
          "validation",
          Number(row["policy_at"] ?? at),
        ),
        ...base,
        code:
          policy === "approved"
            ? "policy_approved"
            : policy === "offchain"
              ? "offchain_decision"
              : policy === "rejected"
                ? "policy_rejected"
                : "policy_unavailable",
        reason: policy === "rejected" ? "AI validation error" : null,
        reason_kind: policy === "rejected" ? "status" : null,
      });
    }
  }
  private gap(): void {
    const key = `projection-gap:${this.state().high_water_sequence}:${Date.now()}`;
    this.append(key, {
      ...draft(
        "system",
        "projection-gap",
        "system",
        "unknown",
        "inference",
        Date.now(),
      ),
      code: null,
    });
    this.db.prepare("DELETE FROM activity_events WHERE event_key=?").run(key);
    this.db.exec("UPDATE activity_state SET initial_gap=1");
  }
  flushInTransaction(): void {
    const queued = this.db
      .prepare("SELECT kind,entity_id FROM activity_queue LIMIT 257")
      .all();
    requireStorage(queued.length <= 256, "activity change queue exceeds bound");
    for (const item of queued) {
      const kind = String(item["kind"]),
        id = String(item["entity_id"]);
      try {
        if (kind === "inference") {
          const row = this.one(
            "SELECT * FROM inference_records WHERE request_id=?",
            id,
          );
          if (row) this.inference(row);
        } else if (kind === "decision") {
          const row = this.one("SELECT * FROM decisions WHERE id=?", id);
          if (row)
            this.append(`decision:${id}:selection`, projectDecision(row));
        } else if (kind === "intent") {
          const row = this.one("SELECT * FROM intents WHERE id=?", id);
          if (!row) continue;
          const attempt = this.one(
              "SELECT tx_hash,evidence_json FROM attempts WHERE intent_id=?",
              id,
            ),
            purpose = this.one(
              "SELECT purpose FROM policy_steps WHERE intent_id=?",
              id,
            )?.["purpose"];
          const event = projectIntent(row, attempt, purpose),
            fingerprint = sha256(json({ ...event, observed_at: 0 })),
            key = `intent:${id}`,
            previous = this.one(
              "SELECT fingerprint,CAST(version AS TEXT) AS version FROM activity_projection WHERE entity_key=?",
              key,
            );
          if (previous?.["fingerprint"] === fingerprint) continue;
          const version = String(
            BigInt(String(previous?.["version"] ?? "0")) + 1n,
          );
          this.append(`${key}:${version}:${fingerprint}`, event);
          this.db
            .prepare(
              "INSERT INTO activity_projection VALUES(?,?,?) ON CONFLICT(entity_key) DO UPDATE SET fingerprint=excluded.fingerprint,version=excluded.version",
            )
            .run(key, fingerprint, version);
        } else this.gap();
      } catch (error) {
        // SQLite failures must roll the writer back. Invalid historical projection
        // data is an explicit feed gap rather than a raw private record export.
        if (!(
          error instanceof ChainValidationError ||
          error instanceof DecisionValidationError ||
          error instanceof SyntaxError ||
          error instanceof StorageError
        ))
          throw error;
        this.gap();
      }
    }
    this.db.exec("DELETE FROM activity_queue");
  }
  observeChainInTransaction(state: DiscoveryState): void {
    const block = {
      height: state.block.height,
      hash: state.block.hash,
      timestamp_ns: state.block.timestampNs,
      market_revision: state.market.market_revision,
    };
    for (const row of state.trades) {
      const trade = publicTrade(row);
      this.append(`chain:trade:${trade.trade_id}`, {
        ...draft(
          "trade",
          trade.trade_id,
          "chain",
          "confirmed",
          "trade",
          state.observedAt,
        ),
        merchant_id: trade.seller,
        trade_id: trade.trade_id,
        offer_id: row.offer_id,
        trade,
        block,
        code: "finalized_trade_view",
      });
    }
    for (const row of state.offers) {
      this.append(`chain:offer:${row.offer_id}:${row.status}`, {
        ...draft(
          "offer",
          row.offer_id,
          "chain",
          row.status === "pending"
            ? "proposed"
            : row.status === "accepted"
              ? "confirmed"
              : row.status === "expired"
                ? "expired"
                : "rejected",
          "offer",
          state.observedAt,
        ),
        merchant_id: row.counterparty,
        offer_id: row.offer_id,
        trade_id: row.settled_trade_id,
        block,
        code:
          row.status === "pending"
            ? "offer_pending"
            : row.status === "accepted"
              ? "offer_accepted"
              : row.status === "expired"
                ? "offer_expired"
                : "offer_cancelled",
      });
    }
    const previous = this.one(
        "SELECT fingerprint FROM activity_projection WHERE entity_key='market'",
      ),
      paused = state.market.data.paused;
    if (previous?.["fingerprint"] !== String(paused)) {
      this.append(`chain:market:${state.market.market_revision}:${paused}`, {
        ...draft(
          "market",
          this.deployment.id,
          "chain",
          paused ? "paused" : previous ? "resumed" : "observed",
          "market",
          state.observedAt,
        ),
        block,
        code: paused ? "market_paused" : "market_open",
      });
      this.db
        .prepare(
          "INSERT INTO activity_projection VALUES('market',?,0) ON CONFLICT(entity_key) DO UPDATE SET fingerprint=excluded.fingerprint",
        )
        .run(String(paused));
    }
  }
  pruneInTransaction(now: number): void {
    this.db
      .prepare(
        "DELETE FROM activity_events WHERE observed_at<? OR sequence IN (SELECT sequence FROM activity_events ORDER BY sequence DESC LIMIT -1 OFFSET 10000)",
      )
      .run(now - 7 * 86400000);
  }
  private cursor(sequence: string): string {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        deployment: this.deployment.id,
        generation: this.generation(),
        sequence,
      }),
    ).toString("base64url");
  }
  private after(value: string): string {
    try {
      if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
        throw new Error();
      const text = Buffer.from(value, "base64url").toString("utf8"),
        parsed = JSON.parse(text);
      if (
        Buffer.from(text).toString("base64url") !== value ||
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !==
          "deployment,generation,sequence,v" ||
        parsed.v !== 1 ||
        typeof parsed.deployment !== "string" ||
        typeof parsed.generation !== "string" ||
        typeof parsed.sequence !== "string"
      )
        throw new Error();
      const sequence = parseU64(parsed.sequence);
      if (
        !/^[a-f0-9]{64}$/.test(parsed.deployment) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          parsed.generation,
        ) ||
        text !==
          JSON.stringify({
            v: 1,
            deployment: parsed.deployment,
            generation: parsed.generation,
            sequence,
          })
      )
        throw new Error();
      if (BigInt(sequence) > maxSequence) throw new Error();
      if (parsed.deployment !== this.deployment.id)
        throw new ReadApiError(400, "cursor_deployment_mismatch");
      if (parsed.generation !== this.generation())
        throw new ReadApiError(409, "feed_generation_mismatch");
      return sequence;
    } catch (error) {
      if (error instanceof ReadApiError) throw error;
      throw new ReadApiError(400, "invalid_cursor");
    }
  }
  page(
    after: string | undefined,
    limit: number,
    explorerUrl: string,
    now = Date.now(),
  ): ActivityPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ReadApiError(400, "invalid_query");
    const sequence = after === undefined ? "0" : this.after(after),
      state = this.state();
    if (BigInt(sequence) > BigInt(state.high_water_sequence))
      throw new ReadApiError(400, "invalid_cursor");
    const rows = this.db
        .prepare(
          "SELECT CAST(sequence AS TEXT) AS sequence,event_key,entry_json FROM activity_events WHERE activity_events.sequence>CAST(? AS INTEGER) ORDER BY activity_events.sequence LIMIT ?",
        )
        .all(sequence, limit + 1),
      more = rows.length > limit;
    const entries = rows.slice(0, limit).map((row) => {
      const event = publicEntry(JSON.parse(String(row["entry_json"])));
      if (event.transaction) {
        const tx =
          event.transaction.receipt_hash ??
          (["submitted", "unknown"].includes(event.status)
            ? event.transaction.signed_hash
            : null);
        if (
          tx &&
          hash(tx) &&
          event.transaction.evidence !== "action_checkpoint"
        )
          event.transaction.explorer_url = new URL(
            `txns/${encodeURIComponent(tx)}`,
            explorerUrl.replace(/\/$/, "") + "/",
          ).href;
      }
      const result = {
        ...event,
        sequence: String(row["sequence"]),
        id: sha256(this.deployment.id + ":" + String(row["event_key"])),
      };
      json(result, 4096);
      return result;
    });
    const next = entries.at(-1)?.sequence ?? state.high_water_sequence;
    const page: ActivityPage = {
      api_version: "1",
      deployment: this.deployment,
      feed_generation: this.generation(),
      captured_at: now,
      heartbeat_at: now,
      chain: this.chain(now),
      entries,
      next_after: this.cursor(next),
      has_more: more,
      history_gap:
        BigInt(sequence) < BigInt(state.pruned_through) ||
        (after === undefined && state.initial_gap),
      high_water_sequence: state.high_water_sequence,
      pruned_through: state.pruned_through,
    };
    json(page, 262144);
    return page;
  }
}
