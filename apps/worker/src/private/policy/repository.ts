import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createMarketCall } from "@bot-bazaar/chain";
import type {
  MerchantId,
  Resource,
  FinalizedMarketReader,
  MarketState,
  Snapshot,
  Offer,
} from "@bot-bazaar/chain";
import type { WorkerStore, Intent } from "../storage/database.js";
import type { DiscoveryState } from "../discovery/types.js";
import { json, sha256, requireStorage } from "../storage/validation.js";
import { parseDecisionAction } from "../decisions/schema.js";
import { evaluateDecision } from "./evaluate.js";
import type { PolicyContext, TradeTerms, EconomicAction } from "./evaluate.js";
type Row = Record<string, string | number | bigint | Uint8Array | null>;
type Step = { intent: Intent; purpose: "model" | "prerequisite" };
function offerDigest(offer: Offer): string {
  return sha256(
    json({
      offer_id: offer.offer_id,
      proposer: offer.proposer,
      buyer: offer.buyer,
      seller: offer.seller,
      counterparty: offer.counterparty,
      resource: offer.resource,
      quantity: offer.quantity,
      unit_price: offer.unit_price,
      total_price: offer.total_price,
      created_at_ns: offer.created_at_ns,
      expires_at_ns: offer.expires_at_ns,
      proposal_action: offer.proposal_action,
    }),
  );
}
export class PolicyRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: WorkerStore,
    private readonly write: <T>(fn: () => T) => T,
  ) {}
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  refresh(): void {
    this.write(() => this.sync());
  }
  commitments(): TradeTerms[] {
    return this.db
      .prepare("SELECT terms_json FROM policy_commitments GROUP BY trade_key")
      .all()
      .map((row) => JSON.parse(String(row["terms_json"])) as TradeTerms);
  }
  rejections(merchantId: MerchantId): string[] {
    return this.db
      .prepare("SELECT offer_id FROM policy_rejections WHERE merchant_id=?")
      .all(merchantId)
      .map((row) => String(row["offer_id"]));
  }
  pruneInTransaction(now: number): void {
    const eligible =
      "SELECT decision_id FROM policy_plans WHERE created_at<? AND job_id IN (SELECT id FROM jobs WHERE status IN ('completed','failed','expired')) AND NOT EXISTS(SELECT 1 FROM policy_commitments c WHERE c.job_id=policy_plans.job_id) AND NOT EXISTS(SELECT 1 FROM intents i WHERE i.job_id=policy_plans.job_id AND i.status IN ('prepared','signed','submitted','unknown'))";
    this.db
      .prepare(`DELETE FROM policy_steps WHERE decision_id IN (${eligible})`)
      .run(now - 30 * 86400000);
    this.db
      .prepare(`DELETE FROM policy_plans WHERE decision_id IN (${eligible})`)
      .run(now - 30 * 86400000);
    this.db
      .prepare(
        "DELETE FROM policy_rejections WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM offers WHERE offers.offer_id=policy_rejections.offer_id AND status='pending')",
      )
      .run(now - 30 * 86400000);
  }
  private sync(): void {
    for (const row of this.db
      .prepare("SELECT * FROM policy_commitments")
      .all()) {
      const origin = String(row["origin_decision"]),
        proposal = this.one(
          "SELECT offer_id,status FROM intents WHERE decision_id=? AND method='propose_trade'",
          origin,
        );
      let terms = JSON.parse(String(row["terms_json"])) as TradeTerms;
      if (proposal?.["status"] === "confirmed" && proposal["offer_id"]) {
        terms = { ...terms, offerId: String(proposal["offer_id"]) };
        this.db
          .prepare(
            "UPDATE policy_commitments SET trade_key=?,terms_json=? WHERE origin_decision=?",
          )
          .run(`offer:${terms.offerId}`, json(terms), origin);
        this.db
          .prepare("UPDATE policy_plans SET trade_key=? WHERE decision_id=?")
          .run(`offer:${terms.offerId}`, origin);
      }
      const offer = terms.offerId
        ? this.one("SELECT status FROM offers WHERE offer_id=?", terms.offerId)
        : undefined;
      const failure = this.one(
        "SELECT id FROM intents WHERE decision_id=? AND status IN ('failed','abandoned')",
        origin,
      );
      if (
        (offer &&
          ["accepted", "cancelled", "expired"].includes(
            String(offer["status"]),
          )) ||
        failure
      ) {
        this.db
          .prepare("DELETE FROM policy_commitments WHERE origin_decision=?")
          .run(origin);
        this.db
          .prepare(
            "UPDATE policy_plans SET slots_remaining=0 WHERE decision_id=?",
          )
          .run(origin);
      }
    }
  }
  private context(
    decisionId: string,
    state: DiscoveryState,
    now: number,
  ): PolicyContext {
    const decision = this.store.getDecision(decisionId);
    requireStorage(decision, "recorded decision required");
    const turn = this.one(
      "SELECT * FROM scheduler_turns WHERE job_id=? AND merchant_id=? AND status='running'",
      decision["job_id"]!,
      decision["merchant_id"]!,
    );
    const job = this.store.getJob(String(decision["job_id"]));
    requireStorage(
      turn &&
        job?.["status"] === "active" &&
        this.store.checkpoint()["recovery_required"] === 0,
      "active reconciled model turn required",
    );
    if (this.store.retry.attempt(decisionId))
      this.store.retry.assertDecisionCurrent(decisionId, now);
    const reserved = Number(
        this.one(
          "SELECT coalesce(sum(slots_remaining),0) AS n FROM policy_plans WHERE job_id=?",
          decision["job_id"]!,
        )!["n"],
      ),
      root = this.one(
        "SELECT mutations FROM scheduler_roots WHERE job_id=?",
        decision["job_id"]!,
      )!;
    const changed = new Set<Resource>();
    for (const input of this.db
      .prepare(
        "SELECT payload_json FROM scheduler_inputs WHERE job_id=? AND payload_json IS NOT NULL",
      )
      .all(decision["job_id"]!)) {
      const payload = JSON.parse(String(input["payload_json"]));
      const t = payload.trade;
      if (
        t &&
        (t.seller?.merchant_id === decision["merchant_id"] ||
          t.buyer?.merchant_id === decision["merchant_id"])
      )
        changed.add(t.resource);
    }
    return {
      state,
      merchantId: decision["merchant_id"] as MerchantId,
      phase: turn["phase"] as "decision" | "followup",
      rootDeadline: Number(job["deadline"]),
      rexShortageMode:
        this.store.merchantCheckpoint("rex")["shortage_mode"] !== 0,
      mutationsRemaining: 8 - Number(root["mutations"]) - reserved,
      commitments: this.db
        .prepare("SELECT terms_json FROM policy_commitments GROUP BY trade_key")
        .all()
        .map((row) => JSON.parse(String(row["terms_json"])) as TradeTerms),
      rejectedOfferIds: this.db
        .prepare("SELECT offer_id FROM policy_rejections WHERE merchant_id=?")
        .all(decision["merchant_id"]!)
        .map((row) => String(row["offer_id"])),
      changedResources: [...changed],
    };
  }
  authorize(
    decisionId: string,
    now = Date.now(),
  ): { kind: "offchain" | "planned" } {
    return this.write(() => {
      this.sync();
      requireStorage(
        !this.one(
          "SELECT decision_id FROM policy_plans WHERE decision_id=?",
          decisionId,
        ),
        "decision already planned",
      );
      const state = this.store.discoveryState();
      requireStorage(state, "complete discovery required");
      const context = this.context(decisionId, state, now),
        decision = this.store.getDecision(decisionId)!,
        original = parseDecisionAction(
          JSON.parse(String(decision["action_json"])),
        );
      // An acceptance adopts the capacity already reserved by its proposal's plan.
      let inherited = 0;
      if (original.method === "accept_trade") {
        for (const row of this.db
          .prepare(
            "SELECT decision_id,slots_remaining FROM policy_plans WHERE job_id=? AND trade_key=?",
          )
          .all(decision["job_id"]!, `offer:${original.args.offer_id}`)) {
          inherited += Number(row["slots_remaining"]);
          this.db
            .prepare(
              "UPDATE policy_plans SET slots_remaining=0 WHERE decision_id=?",
            )
            .run(row["decision_id"]!);
        }
      }
      context.mutationsRemaining += inherited;
      const result = evaluateDecision(original, context, now);
      if (
        result.action.method === "hold" ||
        result.action.method === "reject_trade"
      ) {
        if (result.action.method === "reject_trade")
          this.db
            .prepare("INSERT INTO policy_rejections VALUES(?,?,?)")
            .run(context.merchantId, result.action.offer_id, now);
        this.db
          .prepare("INSERT INTO policy_plans VALUES(?,?,?,'[]',0,NULL,NULL,?)")
          .run(decisionId, decision["job_id"]!, context.merchantId, now);
        return { kind: "offchain" };
      }
      const sequence = [...result.preparations, result.action];
      const first =
        BigInt(
          state.market.data.merchants.find(
            (m) => m.merchant_id === context.merchantId,
          )!.last_action_id,
        ) + 1n;
      const steps: Step[] = sequence.map((action, index) => ({
        purpose: index < result.preparations.length ? "prerequisite" : "model",
        intent: {
          id: `policy:${sha256(decisionId).slice(0, 32)}:${index}`,
          jobId: String(decision["job_id"]),
          decisionId,
          merchantId: context.merchantId,
          method: action.method,
          args: createMarketCall(action.method, {
            ...action.args,
            action_id: String(first + BigInt(index)),
          }).args,
        },
      }));
      const tradeKey = result.trade
        ? result.trade.offerId
          ? `offer:${result.trade.offerId}`
          : `decision:${decisionId}`
        : null;
      this.db.prepare("INSERT INTO policy_plans VALUES(?,?,?,?,?,?,?,?)").run(
        decisionId,
        decision["job_id"]!,
        context.merchantId,
        json(steps),
        result.requiredSlots,
        tradeKey,
        result.trade
          ? json({
              ...result.trade,
              ...(original.method === "accept_trade"
                ? {
                    offerDigest: offerDigest(
                      state.offers.find(
                        (o) => o.offer_id === original.args.offer_id,
                      )!,
                    ),
                  }
                : {}),
            })
          : null,
        now,
      );
      steps.forEach((step, index) =>
        this.db
          .prepare(
            "INSERT INTO policy_steps(intent_id,decision_id,step_index,purpose) VALUES(?,?,?,?)",
          )
          .run(step.intent.id, decisionId, index, step.purpose),
      );
      if (result.trade)
        for (const name of [result.trade.buyer, result.trade.seller]) {
          const existing = this.one(
            "SELECT trade_key FROM policy_commitments WHERE merchant_id=?",
            name,
          );
          requireStorage(
            !existing || existing["trade_key"] === tradeKey,
            "merchant commitment conflict",
          );
          if (!existing)
            this.db
              .prepare("INSERT INTO policy_commitments VALUES(?,?,?,?,?)")
              .run(
                name,
                decision["job_id"]!,
                decisionId,
                tradeKey!,
                json(result.trade),
              );
          const lock = this.one(
            "SELECT job_id FROM merchant_locks WHERE merchant_id=? AND kind='commitment'",
            name,
          );
          requireStorage(
            !lock || lock["job_id"] === decision["job_id"],
            "merchant commitment lock conflict",
          );
          this.db
            .prepare(
              "INSERT OR IGNORE INTO merchant_locks VALUES(?,'commitment',?,?)",
            )
            .run(name, decision["job_id"]!, now);
        }
      return { kind: "planned" };
    });
  }
  next(decisionId: string, now = Date.now()): Intent | undefined {
    const plan = this.one(
      "SELECT * FROM policy_plans WHERE decision_id=?",
      decisionId,
    );
    requireStorage(plan, "authorized policy plan required");
    const steps = JSON.parse(String(plan["steps_json"])) as Step[];
    for (const step of steps) {
      const old = this.store.getIntent(step.intent.id);
      if (old?.["status"] === "confirmed") continue;
      requireStorage(
        !old,
        "policy step already attempted; reconcile instead of replay",
      );
      this.assertIntent(step.intent, this.store.discoveryState()!, now);
      const reservation = this.one(
        "SELECT reserved FROM policy_steps WHERE intent_id=?",
        step.intent.id,
      )!;
      if (reservation["reserved"] === 0) {
        const turn = this.one(
          "SELECT id FROM scheduler_turns WHERE job_id=? AND merchant_id=? AND status='running'",
          plan["job_id"]!,
          plan["merchant_id"]!,
        )!;
        this.store.scheduler.reserveMutation(
          String(turn["id"]),
          step.intent,
          now,
        );
      }
      return structuredClone(step.intent);
    }
    return undefined;
  }
  assertIntent(intent: Intent, state: DiscoveryState, now = Date.now()): void {
    if (!intent.decisionId) {
      return;
    }
    const plan = this.one(
        "SELECT * FROM policy_plans WHERE decision_id=?",
        intent.decisionId,
      ),
      step = this.one(
        "SELECT * FROM policy_steps WHERE intent_id=?",
        intent.id,
      );
    requireStorage(
      plan && step && step["decision_id"] === intent.decisionId,
      "policy approval required",
    );
    const steps = JSON.parse(String(plan["steps_json"])) as Step[],
      index = Number(step["step_index"]),
      expected = steps[index]!;
    requireStorage(
      expected.intent.id === intent.id &&
        expected.intent.jobId === intent.jobId &&
        expected.intent.decisionId === intent.decisionId &&
        expected.intent.merchantId === intent.merchantId &&
        expected.intent.method === intent.method &&
        json(expected.intent.args) ===
          json(createMarketCall(intent.method, intent.args).args),
      "policy intent identity mismatch",
    );
    for (const earlier of steps.slice(0, index))
      requireStorage(
        this.store.getIntent(earlier.intent.id)?.["status"] === "confirmed",
        "policy prerequisite not confirmed",
      );
    const context = this.context(intent.decisionId, state, now);
    context.continuation = true;
    context.mutationsRemaining = 8;
    // The plan's own asset reservation is not a competing trade.
    const ownTrades = this.db
      .prepare(
        "SELECT terms_json FROM policy_commitments WHERE origin_decision=? OR trade_key=?",
      )
      .all(intent.decisionId, plan["trade_key"] ?? "")
      .map((row) => String(row["terms_json"]));
    context.commitments = context.commitments.filter(
      (t) => !ownTrades.includes(json(t)),
    );
    const original = parseDecisionAction(
      JSON.parse(
        String(this.store.getDecision(intent.decisionId)!["action_json"]),
      ),
    );
    let result;
    if (expected.purpose === "prerequisite") {
      result = evaluateDecision(original, context, now);
      requireStorage(
        result.preparations.some(
          (p) =>
            p.method === intent.method && json(p.args) === json(intent.args),
        ),
        "safety prerequisite changed",
      );
    } else {
      const action = { method: intent.method, args: intent.args };
      result = evaluateDecision(action, context, now);
      requireStorage(
        result.preparations.length === 0,
        "policy preparation required before economic action",
      );
      // Economic terms remain identical; only the worker's sequential action ID may advance after preparation.
      const strip = (value: EconomicAction) => {
        const copy = { ...value.args } as Record<string, unknown>;
        delete copy["action_id"];
        return json({ method: value.method, args: copy });
      };
      requireStorage(
        "args" in original &&
          strip(original) ===
            strip(parseDecisionAction(action) as EconomicAction),
        "model terms changed",
      );
    }
    if (plan["terms_json"] && result.trade) {
      const previous = JSON.parse(String(plan["terms_json"])) as TradeTerms & {
        offerDigest?: string;
      };
      if (previous.offerDigest) {
        const offer = state.offers.find((o) => o.offer_id === previous.offerId);
        requireStorage(
          offer && offerDigest(offer) === previous.offerDigest,
          "stored offer terms changed",
        );
      }
      const economic = (t: TradeTerms) =>
        json({
          buyer: t.buyer,
          seller: t.seller,
          resource: t.resource,
          quantity: t.quantity,
          total_price: t.total_price,
        });
      requireStorage(
        economic(previous) === economic(result.trade),
        "stored offer terms changed",
      );
    }
  }
  async verifyLive(
    intent: Intent,
    reader: FinalizedMarketReader,
    market: Snapshot<MarketState>,
    now = Date.now(),
  ): Promise<DiscoveryState | undefined> {
    if (!intent.decisionId) {
      requireStorage(
        !this.one(
          "SELECT job_id FROM scheduler_roots WHERE job_id=?",
          intent.jobId,
        ) || ["cancel_trade", "expire_offers"].includes(intent.method),
        "model mutation requires policy decision",
      );
      return;
    }
    const offers = new Map<string, Offer>();
    for (const name of ["rex", "luna", "bolt"] as const) {
      const page = await reader.getOffersForMerchant(name, "pending", {
        after_id: null,
        limit: "50",
        expected_revision: market.market_revision,
      });
      requireStorage(!page.data.has_more, "pending policy scan incomplete");
      for (const offer of page.data.items) {
        const old = offers.get(offer.offer_id);
        requireStorage(
          !old || json(old) === json(offer),
          "pending offer mismatch",
        );
        offers.set(offer.offer_id, offer);
      }
    }
    const previous = this.store.discoveryState();
    requireStorage(previous, "policy discovery unavailable");
    now = Math.max(now, Date.now());
    const state: DiscoveryState = {
      ...previous,
      block: reader.block,
      market,
      offers: [...offers.values()],
      observedAt: now,
    };
    this.assertIntent(intent, state, now);
    return state;
  }
}
