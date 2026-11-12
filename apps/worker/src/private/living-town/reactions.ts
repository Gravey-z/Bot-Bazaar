import type { DatabaseSync } from "node:sqlite";
import {
  canonicalLivingTownJson,
  livingTownRawTrade,
  livingTownSnapshot,
  livingTownTown,
  livingTownOffer,
} from "@bot-bazaar/chain";
import type { MerchantPolicyInput } from "./merchant-policy.js";
import type { ProposalMerchant } from "./proposals.js";
import type { StockSharingCandidate } from "./stock-sharing.js";
import { requireStorage, sha256 } from "../storage/validation.js";

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const names = ["rex", "luna", "bolt"] as const;
export const reactionSchema = `
CREATE TABLE reaction_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),trade_id TEXT NOT NULL) STRICT;
INSERT INTO reaction_cursor VALUES(1,'0');
CREATE TABLE reaction_roots(id TEXT PRIMARY KEY,merchant TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('purchase','cleanup')),state TEXT NOT NULL CHECK(state IN ('queued','active','closed')),created_ns TEXT NOT NULL,deadline_ns TEXT NOT NULL,model_calls INTEGER NOT NULL DEFAULT 0 CHECK(model_calls BETWEEN 0 AND 6),mutations INTEGER NOT NULL DEFAULT 0 CHECK(mutations BETWEEN 0 AND 8),proposals INTEGER NOT NULL DEFAULT 0 CHECK(proposals BETWEEN 0 AND 1),used_json TEXT NOT NULL DEFAULT '[]',offer_id TEXT,trade_id TEXT,offer_json TEXT,close_reason TEXT) STRICT;
CREATE UNIQUE INDEX one_active_reaction ON reaction_roots((1)) WHERE state='active';
CREATE TABLE reaction_purchases(trade_id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES reaction_roots(id),body TEXT NOT NULL) STRICT;
CREATE TABLE reaction_steps(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES reaction_roots(id),ordinal INTEGER NOT NULL,merchant TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('buyer','seller','acceptance','followup','cleanup')),state TEXT NOT NULL CHECK(state IN ('planned','decided','executing','completed')),model_reserved INTEGER NOT NULL DEFAULT 0 CHECK(model_reserved IN (0,1)),decision_json TEXT,UNIQUE(root_id,ordinal)) STRICT;
CREATE TRIGGER bound_reaction_roots BEFORE INSERT ON reaction_roots WHEN (SELECT count(*) FROM reaction_roots)>=10000 BEGIN SELECT RAISE(ABORT,'reaction journal full'); END;
CREATE TRIGGER bound_reaction_purchases BEFORE INSERT ON reaction_purchases WHEN (SELECT count(*) FROM reaction_purchases)>=10000 BEGIN SELECT RAISE(ABORT,'reaction purchase history full'); END;
`;
export interface ReactionWork {
  id: string;
  rootId: string;
  merchant: ProposalMerchant;
  role: "buyer" | "seller" | "acceptance" | "followup" | "cleanup";
  deadlineNs: string;
  decision: Record<string, unknown> | null;
}
/** All state lives in the witnessed execution DB. Calls into bind/settled run inside
 * the original intent/terminal transaction, so wake-up cannot be lost after a receipt. */
export class TownReactionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(fn: () => T) => T,
    private readonly gate: () => void,
    private readonly deployment: unknown,
  ) {}
  cursor(): string {
    return String(
      this.db.prepare("SELECT trade_id FROM reaction_cursor").get()![
        "trade_id"
      ],
    );
  }
  roots(): Row[] {
    return this.db.prepare("SELECT * FROM reaction_roots ORDER BY rowid").all();
  }
  active(): Row | undefined {
    return this.db
      .prepare("SELECT * FROM reaction_roots WHERE state='active'")
      .get();
  }
  hasPending(): boolean {
    return !!this.db.prepare("SELECT id FROM reaction_roots WHERE state!='closed' LIMIT 1").get();
  }
  /** Housekeeping can progress without AI admission or a customer turn.
   * Only journal-terminal steps may be retired; pending chain offers stay pending.
   */
  advanceExpired(nowNs: string): boolean {
    this.gate();
    return this.write(() => {
      const active = this.active();
      if (!active || active.offer_id == null) return false;
      const id = String(active.id);
      if (this.steps(id).some(s => s.state !== "completed")) return false;
      const row = this.db.prepare(
        "SELECT body FROM town_offer_commitments WHERE offer_id=?",
      ).get(active.offer_id);
      if (!row) return false;
      const offer = livingTownOffer(JSON.parse(String(row.body)));
      if (offer.status !== "pending") {
        this.close(id, offer.status);
        return true;
      }
      if (BigInt(offer.expires_at_ns) > BigInt(nowNs)) return false;
      if (this.steps(id).filter(s => s.role === "cleanup").length < 3) return false;
      this.close(id, "cleanup_retry_limit_reached");
      return true;
    });
  }
  /** Only consider finalized, mirrored expired offers; a housekeeping turn
   * remains subject to fresh chain facts and the single durable executor.
   */
  needsCleanup(nowNs: string): boolean {
    const rows = this.db.prepare(
      "SELECT body FROM town_offer_commitments WHERE status='pending'",
    ).all();
    return rows.some(row => {
      const offer = livingTownOffer(JSON.parse(String(row.body)));
      return BigInt(offer.expires_at_ns) <= BigInt(nowNs);
    });
  }
  steps(rootId: string): Row[] {
    return this.db
      .prepare("SELECT * FROM reaction_steps WHERE root_id=? ORDER BY ordinal")
      .all(rootId);
  }
  root(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM reaction_roots WHERE id=?").get(id);
  }
  /** Persisted expiry attempts across both purchase and housekeeping roots.
   * Read-only audit: never infer transaction success from an abandoned intent.
   */
  cleanupHistory(offerId: string): Row[] {
    return this.db.prepare(
      "SELECT id,status,args_json,args_digest FROM intents " +
      "WHERE method='expire_offers' AND status IN ('abandoned','failed','confirmed') " +
      "AND json_extract(args_json,'$.offer_ids[0]')=? ORDER BY rowid DESC LIMIT 12",
    ).all(offerId);
  }
  work(id: string): ReactionWork | null {
    const row = this.db
      .prepare(
        "SELECT s.*,r.deadline_ns FROM reaction_steps s JOIN reaction_roots r ON r.id=s.root_id WHERE s.id=?",
      )
      .get(id);
    return row
      ? {
          id: String(row.id),
          rootId: String(row.root_id),
          merchant: row.merchant as ProposalMerchant,
          role: row.role as ReactionWork["role"],
          deadlineNs: String(row.deadline_ns),
          decision:
            row.decision_json === null
              ? null
              : JSON.parse(String(row.decision_json)),
        }
      : null;
  }
  private add(
    root: string,
    merchant: string,
    role: ReactionWork["role"],
    decision: unknown = null,
  ): void {
    const ordinal = Number(
      this.db
        .prepare("SELECT count(*) n FROM reaction_steps WHERE root_id=?")
        .get(root)!["n"],
    );
    requireStorage(ordinal < 12, "reaction step bound");
    const id = sha256(
      canonicalLivingTownJson([
        this.deployment,
        root,
        String(ordinal),
        merchant,
        role,
      ]),
    );
    this.db
      .prepare(
        "INSERT INTO reaction_steps(id,root_id,ordinal,merchant,role,state,decision_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        root,
        ordinal,
        merchant,
        role,
        decision === null ? "planned" : "decided",
        decision === null
          ? null
          : canonicalLivingTownJson({
              ...(decision as Record<string, unknown>),
              reactionStepId: id,
            }),
      );
  }
  observe(input: MerchantPolicyInput): void {
    this.gate();
    const town = livingTownSnapshot(livingTownTown)(input.town);
    requireStorage(
      input.fresh && input.historyComplete,
      "reaction observation requires complete fresh facts",
    );
    this.write(() => {
      for (const value of input.externalPurchases ?? []) {
        const t = livingTownRawTrade(value);
        requireStorage(
          t.kind === "raw_purchase" &&
            t.buyer.kind === "player" &&
            t.seller.kind === "merchant" &&
            BigInt(t.event_sequence) <= BigInt(town.event_sequence) &&
            BigInt(t.settled_at_ns) <= BigInt(town.block_timestamp_ns),
          "invalid external purchase signal",
        );
        const prior = this.db
          .prepare("SELECT body FROM reaction_purchases WHERE trade_id=?")
          .get(t.trade_id);
        if (prior) {
          requireStorage(
            prior.body === canonicalLivingTownJson(t),
            "purchase replay terms changed",
          );
          continue;
        }
        requireStorage(
          BigInt(t.trade_id) > BigInt(this.cursor()),
          "purchase cursor regressed",
        );
        const merchant = t.seller.merchant_id;
        let root = this.db
          .prepare(
            "SELECT id,deadline_ns,state,offer_id FROM reaction_roots WHERE merchant=? AND kind='purchase' AND state!='closed' ORDER BY rowid",
          )
          .all(merchant)
          .find((r) => {
            if (
              BigInt(String(r.deadline_ns)) <= BigInt(town.block_timestamp_ns)
            )
              return false;
            if (r.state === "queued") return true;
            if (
              r.offer_id !== null &&
              this.db
                .prepare(
                  "SELECT status FROM town_offer_commitments WHERE offer_id=?",
                )
                .get(r.offer_id!)?.["status"] === "pending"
            )
              return true;
            return this.steps(String(r.id)).some(
              (s) => s.role === "buyer" && s.state !== "completed",
            );
          })?.["id"] as string | undefined;
        if (!root) {
          root = sha256(
            canonicalLivingTownJson([this.deployment, "purchase", t.trade_id]),
          );
          this.db
            .prepare(
              "INSERT INTO reaction_roots(id,merchant,kind,state,created_ns,deadline_ns) VALUES(?,?,'purchase','queued',?,?)",
            )
            .run(
              root,
              merchant,
              t.settled_at_ns,
              String(BigInt(t.settled_at_ns) + 600000000000n),
            );
        }
        this.db
          .prepare("INSERT INTO reaction_purchases VALUES(?,?,?)")
          .run(t.trade_id, root, canonicalLivingTownJson(t));
        this.db
          .prepare("UPDATE reaction_cursor SET trade_id=?")
          .run(t.trade_id);
      }
    });
  }
  /** Run autonomous inventory-driven AI reviews at most once every 30 minutes
 * of merchant inactivity. Purchase-triggered reactions remain immediate.
 * All timestamps and review roots are durable in the existing execution journal.
 */
  observeOpportunities(input: MerchantPolicyInput, candidates: readonly StockSharingCandidate[]): void {
    this.gate();
    if (!input.fresh || !input.historyComplete || !input.negotiatedTrading || !candidates.length) return;
    const town = livingTownSnapshot(livingTownTown)(input.town);
    if (town.data.paused) return;
    const now = BigInt(town.block_timestamp_ns);
    const reviewIntervalNs = 500_000_000_000n;
    this.write(() => {
      for (const merchant of names) {
        // Stock-sharing candidates already account for target stock, reservations,
        // peer supply and affordability. No candidate means no paid AI request.
        const eligible = candidates.filter(c => c.buyer === merchant).map(c => c.id).sort();
        if (!eligible.length) continue;
        if (this.db.prepare("SELECT id FROM reaction_roots WHERE merchant=? AND state!='closed'").get(merchant))
          continue;

        // Read the latest confirmed player purchase from the durable inbox.
        // Compare decimal nanoseconds as strings: SQLite INTEGER cannot hold them.
        const latestPurchase = this.db.prepare(
          "SELECT json_extract(body,'$.settled_at_ns') AS settled_at_ns FROM reaction_purchases " +
          "WHERE json_extract(body,'$.seller.merchant_id')=? " +
          "ORDER BY length(json_extract(body,'$.settled_at_ns')) DESC, " +
          "json_extract(body,'$.settled_at_ns') DESC LIMIT 1",
        ).get(merchant)?.["settled_at_ns"];
        // Existing purchase/review roots also provide a durable cooldown.
        const latestRoot = this.db.prepare(
          "SELECT created_ns FROM reaction_roots WHERE merchant=? AND kind='purchase' " +
          "ORDER BY length(created_ns) DESC, created_ns DESC LIMIT 1",
        ).get(merchant)?.["created_ns"];
        let lastActivity = BigInt(town.data.genesis_time_ns);
        for (const timestamp of [latestPurchase, latestRoot]) {
          if (timestamp !== undefined && timestamp !== null) {
            const observed = BigInt(String(timestamp));
            if (observed > lastActivity) lastActivity = observed;
          }
        }
        // Recent confirmed merchant-to-merchant purchases also reset inactivity.
        // Older activity is covered by the durable 30-minute review cadence.
        for (const value of input.trades) {
          const trade = value as {
            kind?: string;
            settled_at_ns?: string;
            seller?: { kind?: string; merchant_id?: string };
          };
          if (trade.kind !== "raw_purchase" && trade.kind !== "merchant_trade") continue;
          if (trade.seller?.merchant_id !== merchant ||
              typeof trade.settled_at_ns !== "string" ||
              !/^[0-9]+$/.test(trade.settled_at_ns)) continue;
          const settledAt = BigInt(trade.settled_at_ns);
          if (settledAt <= now && settledAt > lastActivity) lastActivity = settledAt;
        }
        if (now - lastActivity < reviewIntervalNs) continue;

        // A unique root is admitted only after the previous root's cooldown;
        // the existing seller negotiation, AI budget and transaction journal remain authoritative.
        const id = sha256(canonicalLivingTownJson([
          this.deployment, "merchant-inventory-review-v1", merchant, town.block_timestamp_ns, eligible,
        ]));
        this.db.prepare(
          "INSERT INTO reaction_roots(id,merchant,kind,state,created_ns,deadline_ns) VALUES(?,?,'purchase','queued',?,?)",
        ).run(id, merchant, town.block_timestamp_ns, String(now + 600_000_000_000n));
      }
    });
  }
  /** No timers/model calls. Unknown intents retain their exact step and original budget. */
  next(
    input: MerchantPolicyInput,
    offers: { get(id: string): ReturnType<typeof livingTownOffer> | null },
    origin?: ProposalMerchant,
  ): ReactionWork | null {
    this.gate();
    const town = livingTownSnapshot(livingTownTown)(input.town),
      now = BigInt(town.block_timestamp_ns);
    this.write(() => {
      // Explicit housekeeping obligations are not paid purchase reactions.
      for (const value of input.pendingOffers ?? []) {
        const o = livingTownOffer(value);
        if (
          BigInt(o.expires_at_ns) > now ||
          this.db
            .prepare(
              "SELECT id FROM reaction_roots WHERE offer_id=? AND state!='closed'",
            )
            .get(o.offer_id)
        )
          continue;
        const root = sha256(
          canonicalLivingTownJson([this.deployment, "cleanup", o.offer_id]),
        );
        if (!this.root(root)) {
          this.db
            .prepare(
              "INSERT INTO reaction_roots(id,merchant,kind,state,created_ns,deadline_ns,offer_id) VALUES(?,?,'cleanup','queued',?,?,?)",
            )
            .run(root, o.buyer, o.created_at_ns, o.expires_at_ns, o.offer_id);
        }
      }
      let root = this.db
        .prepare("SELECT * FROM reaction_roots WHERE state='active' AND (? IS NULL OR merchant=?) ORDER BY rowid LIMIT 1")
        .get(origin ?? null, origin ?? null);
      if (!root) {
        root = this.db
          .prepare(
            "SELECT * FROM reaction_roots q WHERE state='queued' AND (? IS NULL OR merchant=?) AND NOT EXISTS(SELECT 1 FROM reaction_roots a WHERE a.state='active' AND a.merchant=q.merchant) ORDER BY CASE kind WHEN 'cleanup' THEN 0 ELSE 1 END,rowid LIMIT 1",
          )
          .get(origin ?? null, origin ?? null);
        if (!root) return;
        this.db
          .prepare("UPDATE reaction_roots SET state='active' WHERE id=?")
          .run(root.id!);
      }
      const id = String(root.id),
        active = this.db
          .prepare(
            "SELECT * FROM reaction_steps WHERE root_id=? AND state!='completed' ORDER BY ordinal LIMIT 1",
          )
          .get(id);
      if (active) return;
      const offer =
        root.offer_id === null
          ? null
          : (offers.get(String(root.offer_id)) ??
            (root.offer_json
              ? livingTownOffer(JSON.parse(String(root.offer_json)))
              : null));
      if (root.offer_id !== null) {
        requireStorage(
          offer,
          "root offer requires authoritative reconciliation",
        );
        if (offer.status === "pending") {
          if (BigInt(offer.expires_at_ns) <= now) {
            // An expired trade is no longer AI negotiation work. After the
            // first attempted cleanup, release the purchase root and hand off
            // to the offer's stable housekeeping root. Existing completed
            // attempts remain immutable in the original execution journal.
            const cleanupAttempts = this.steps(id).filter(s => s.role === "cleanup").length;
            if (root.kind === "purchase" && cleanupAttempts > 0) {
              this.close(id, "cleanup_handed_off");
              return;
            }
            // Existing installations may already have several purchase-root
            // attempts. The housekeeping root still has an independent cap.
            if (cleanupAttempts >= 3) {
              this.close(id, "cleanup_retry_limit_reached");
              return;
            }
            this.add(id, offer.buyer, "cleanup", {
              kind: "reaction_cleanup",
              offerId: offer.offer_id,
              method: "expire_offers",
            });
            return;
          }
          const sellerSeen = this.steps(id).some((s) => s.role === "seller");
          if (
            !sellerSeen &&
            BigInt(root.deadline_ns as string) - now >= 45000000000n &&
            Number(root.model_calls) < 6
          ) {
            this.add(id, offer.seller, "seller");
            return;
          }
          return; // recipient wait/failure: retain promises until explicit expiry cleanup
        }
        this.db
          .prepare(
            "UPDATE reaction_roots SET trade_id=?,offer_json=? WHERE id=?",
          )
          .run(offer.trade_id, canonicalLivingTownJson(offer), id);
      }
      if (root.kind === "cleanup" || now >= BigInt(String(root.deadline_ns))) {
        this.close(id, offer?.status ?? "deadline");
        return;
      }

        const steps = this.steps(id);

        // Do not generate additional AI follow-ups when the initial
        // buyer turn has completed without creating an on-chain offer.
        // Never close an unfinished step or an existing pending offer.
        if (
          root.kind === "purchase" &&
          root.offer_id === null &&
          steps.some((s) => s.role === "buyer")
        ) {
          this.close(id, "buyer_declined_or_no_offer");
          return;
        }

        if (steps.length === 0) {

        if (BigInt(String(root.deadline_ns)) - now < 90000000000n) {
          this.close(id, "insufficient_root_window");
          return;
        }
        this.add(id, String(root.merchant), "buyer");
        return;
      }
      if (
        steps.some((s) => s.role === "buyer") &&
        (!offer || offer.status !== "pending")
      ) {
        const done = new Set(
          steps
            .filter((s) => s.role === "followup")
            .map((s) => String(s.merchant)),
        );
        const merchant = names.find((m) => !done.has(m));
        if (
          merchant &&
          Number(root.model_calls) < 6 &&
          Number(root.mutations) < 7 &&
          BigInt(String(root.deadline_ns)) - now >= 20000000000n
        ) {
          this.add(id, merchant, "followup");
          return;
        }
      }
      this.close(id, offer?.status ?? "finished");
    });
    const row = this.db
      .prepare(
        "SELECT s.id FROM reaction_steps s JOIN reaction_roots r ON r.id=s.root_id WHERE r.state='active' AND s.state!='completed' AND (? IS NULL OR r.merchant=?) ORDER BY CASE s.state WHEN 'decided' THEN 0 ELSE 1 END,s.rowid LIMIT 1",
      )
      .get(origin ?? null, origin ?? null);
    return row ? this.work(String(row.id)) : null;
  }
  decided(): ReactionWork | null {
    const row = this.db.prepare("SELECT s.id FROM reaction_steps s JOIN reaction_roots r ON r.id=s.root_id WHERE s.state='decided' AND r.state='active' ORDER BY s.rowid LIMIT 1").get();
    return row ? this.work(String(row["id"])) : null;
  }
  private close(root: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE reaction_roots SET state='closed',close_reason=? WHERE id=?",
      )
      .run(reason, root);
  }
  attach(input: MerchantPolicyInput, work: ReactionWork): MerchantPolicyInput {
    const root = this.root(work.rootId);
    requireStorage(root?.state === "active", "active root required");
    return {
      ...input,
      stockSharingReaction: {
        id: work.rootId,
        usedMerchants: JSON.parse(String(root.used_json)),
        followUpOnly: work.role !== "buyer",
      },
    };
  }
  admitModel(work: ReactionWork, nowNs: string): boolean {
    this.gate();
    return this.write(() => {
      const row = this.db
          .prepare("SELECT * FROM reaction_steps WHERE id=?")
          .get(work.id),
        root = this.root(work.rootId);
      requireStorage(
        root?.state === "active" &&
          row?.state === "planned" &&
          ["buyer", "seller", "followup"].includes(work.role),
        "planned reaction model turn required",
      );
      const reserve =
        work.role === "buyer"
          ? 90000000000n
          : work.role === "seller"
            ? 45000000000n
            : 20000000000n;
      if (!(
        (Number(root.model_calls) < 6 || row.model_reserved === 1) &&
        (work.role !== "buyer" ||
          Number(root.model_calls) <= (row.model_reserved === 1 ? 5 : 4)) &&
        Number(root.mutations) <=
          (work.role === "buyer" ? 3 : work.role === "seller" ? 5 : 6) &&
        BigInt(String(root.deadline_ns)) - BigInt(nowNs) >= reserve
      ))
        return false;
      if (row.model_reserved === 1) return true;
      this.db
        .prepare(
          "UPDATE reaction_roots SET model_calls=model_calls+1 WHERE id=?",
        )
        .run(work.rootId);
      this.db
        .prepare("UPDATE reaction_steps SET model_reserved=1 WHERE id=?")
        .run(work.id);
      return true;
    });
  }
  modelContext(rootId: string, stepId: string, merchant: string): boolean {
    const work = this.work(stepId),
      root = this.root(rootId),
      row = this.db
        .prepare("SELECT state,model_reserved FROM reaction_steps WHERE id=?")
        .get(stepId);
    return (
      !!work &&
      work.rootId === rootId &&
      work.merchant === merchant &&
      root?.state === "active" &&
      row?.state === "planned" &&
      row.model_reserved === 1
    );
  }
  decide(work: ReactionWork, decision: Record<string, unknown>): void {
    this.gate();
    this.write(() => {
      const row = this.db
        .prepare("SELECT state,decision_json FROM reaction_steps WHERE id=?")
        .get(work.id);
      requireStorage(
        row?.state === "planned",
        "reaction decision already persisted",
      );
      const action = (
        decision.proposal as { action?: { type?: string } } | undefined
      )?.action;
      if (action?.type === "propose_trade") {
        requireStorage(
          work.role === "buyer" &&
            Number(this.root(work.rootId)!.proposals) === 0,
          "one proposal per root",
        );
        this.db
          .prepare("UPDATE reaction_roots SET proposals=proposals+1 WHERE id=?")
          .run(work.rootId);
      }
      this.db
        .prepare(
          "UPDATE reaction_steps SET state='decided',decision_json=? WHERE id=?",
        )
        .run(canonicalLivingTownJson(decision), work.id);
    });
  }
  /** Atomic with intent creation; reserves all attempts, including deterministic prerequisites. */
  bind(
    action: { id: string; lane: string; decision: unknown },
    hasCall: boolean,
  ): void {
    const w = this.work(action.id),
      row = this.db
        .prepare("SELECT state,decision_json FROM reaction_steps WHERE id=?")
        .get(action.id);
    requireStorage(
      w &&
        w.merchant === action.lane &&
        row?.state === "decided" &&
        row.decision_json === canonicalLivingTownJson(action.decision),
      "original persisted reaction decision required",
    );
    if (hasCall) {
      const root = this.root(w.rootId)!;
      requireStorage(
        Number(root.mutations) < (w.role === "cleanup" ? 8 : 7),
        "root mutation budget exhausted",
      );
      this.db
        .prepare("UPDATE reaction_roots SET mutations=mutations+1 WHERE id=?")
        .run(w.rootId);
    }
    this.db
      .prepare("UPDATE reaction_steps SET state='executing' WHERE id=?")
      .run(w.id);
  }
  /** Atomic with journal terminal transition, so confirmation and recipient wake are recoverable. */
  settled(actionId: string, status: string): void {
    const w = this.work(actionId);
    if (!w) return;
    const row = this.db
      .prepare(
        "SELECT i.method,i.offer_id,i.status FROM intents i WHERE i.id=?",
      )
      .get(actionId);
    this.db
      .prepare("UPDATE reaction_steps SET state='completed' WHERE id=?")
      .run(actionId);
    if (row?.status === "confirmed" && row.method === "propose_trade") {
      requireStorage(row.offer_id, "confirmed proposal must bind offer ID");
      const offer = this.db
        .prepare("SELECT body FROM town_offer_commitments WHERE offer_id=?")
        .get(row.offer_id);
      requireStorage(offer, "confirmed offer body required");
      const o = livingTownOffer(JSON.parse(String(offer.body)));
      this.db
        .prepare("UPDATE reaction_roots SET offer_id=?,used_json=? WHERE id=?")
        .run(o.offer_id, JSON.stringify([o.buyer, o.seller]), w.rootId);
    }
    const decision = w.decision;
    if (
      status === "completed" &&
      row?.status === "confirmed" &&
      decision?.tradePhase === "seller_listing_release"
    ) {
      this.add(w.rootId, w.merchant, "acceptance", {
        ...decision,
        tradePhase: "seller_acceptance",
      });
    }
  }
}
