import {
  canonicalLivingTownJson,
  createLivingTownCall,
  livingTownSourceState,
  livingTownListing,
} from "@bot-bazaar/chain";
import type { FinalizedLivingTownReader } from "@bot-bazaar/chain";
import type { ContinuityVerifier } from "../recovery/types.js";
import { requireStorage, sha256 } from "../storage/validation.js";
import type { TownOperations } from "./operations.js";
import { LivingTownExecutionStore } from "./execution-store.js";
import type { TownLane } from "./execution-store.js";
import { LivingTownTickScheduler } from "./ticks.js";
import { LivingTownTickRunner } from "./tick-runner.js";
import type { DurableCustomerExecutor } from "./customer-executor.js";
import { DurableTownExecutor } from "./town-executor.js";
import type { TownSubmission } from "./town-executor.js";
import type { TownChainAdapter, TownCall } from "./town-chain.js";
import { LivingTownMerchantPolicy } from "./merchant-policy.js";
import type { MerchantPolicyInput } from "./merchant-policy.js";
import {
  parseTownProposal,
  resolveTownProposal,
  isTownProposalDelivery,
} from "./proposals.js";
import type { TownProposal, ProposalMerchant } from "./proposals.js";
import { compileSellerTradeApproval } from "./negotiation.js";
import type { SellerTradeApproval, SellerTradeStep } from "./negotiation.js";
import type { ReactionWork } from "./reactions.js";
import { resolveAssistantReprice } from "../assistant/automatic.js";
import type { AutomaticAssistant } from "../assistant/automatic.js";

type Decision =
  | { kind: "reaction_cleanup"; offerId: string; method: "expire_offers" }
  | { kind: "assistant"; shop: string; proposal: unknown }
  | { kind: "raw"; item: string }
  | { kind: "sweep"; merchant: string }
  | { kind: "no_op"; reason: string }
  | {
      kind: "proposal";
      reactionStepId?: string;
      offerExpiryNs?: string;
      merchant: ProposalMerchant;
      tickId: string;
      proposal: TownProposal;
      origin: "rules" | "model_proposal";
      validation: string;
      inferenceRef?: string;
      tradeApproval?: SellerTradeApproval;
      tradePhase?: SellerTradeStep["phase"];
      signals?: {
        item_id: string;
        held: string;
        reserved: string;
        scarcity_bps: string;
        confirmed_demand: string | null;
        suggested_price: string | null;
      }[];
      checkpoint?: {
        block_hash: string;
        block_height: string;
        block_timestamp_ns: string;
        market_revision: string;
        event_sequence: string;
      };
    };
export type SimulationPoll = {
  kind: "advanced" | "blocked" | "idle" | "deferred";
  action?: TownSubmission;
  reasons?: string[];
};
/** Bounded private orchestration; inference is an optional, separately budgeted caller capability. */
export class LivingTownSimulationAdapter {
  private busy = false;
  readonly runtime: DurableTownExecutor;
  constructor(
    private readonly store: LivingTownExecutionStore,
    private readonly scheduler: LivingTownTickScheduler,
    private readonly customers: DurableCustomerExecutor,
    private readonly customerRunner: LivingTownTickRunner,
    private readonly adapters: Record<TownLane, TownChainAdapter>,
    private readonly policy: LivingTownMerchantPolicy,
    private readonly collect: (
      reader: FinalizedLivingTownReader,
    ) => Promise<MerchantPolicyInput>,
    continuity: ContinuityVerifier,
    private readonly propose?: (context: {
      tickId: string;
      merchant: ProposalMerchant;
      facts: MerchantPolicyInput;
      schemaVersion: "living-town-proposal-v1";
      reaction?: { rootId: string; stepId: string };
    }) => Promise<unknown>,
    private readonly assistant?: AutomaticAssistant,
    private readonly operations?: TownOperations,
    private readonly options: {
      skipEmptySources?: boolean;
      skipIdleMerchantTurns?: boolean;
      minimumTickWindowMs?: number;
      admission?: () => boolean;
      modelReady?: () => boolean;
      merchantOpportunities?: boolean;
      independentSupply?: boolean;
    } = {},
  ) {
    requireStorage(
      !assistant ||
        (typeof assistant.canDispatch === "function" &&
          assistant.shopIds.length > 0 &&
          assistant.shopIds.length <= 16 &&
          new Set(assistant.shopIds).size === assistant.shopIds.length &&
          assistant.shopIds.every(
            (s) =>
              /^[1-9][0-9]{0,3}$/.test(s) &&
              BigInt(s) >= 4n &&
              BigInt(s) <= 1003n,
          ) &&
          adapters.operator.operatorScope === "town_operator"),
      "bounded assistant shops and reviewed operator key scope required",
    );
    this.runtime = new DurableTownExecutor(
      store,
      adapters,
      continuity,
      (decision, lane, reader, command) =>
        this.refresh(decision as Decision, lane, reader, command),
    );
  }
  private shelfUpdates(input: MerchantPolicyInput): Set<string> {
    const listings = input.merchants.flatMap(m => m.listings.map(livingTownListing));
    return new Set(this.policy.evaluate(input).decisions.filter(d => {
      if (d.action.kind !== "set_listing") return false;
      const action = d.action;
      const listing = listings.find(l => l.owner.kind === "merchant" &&
        l.owner.merchant_id === d.merchant && l.item_id === action.item);
      return !listing || listing.remaining_quantity !== action.quantity ||
        listing.unit_price !== action.price;
    }).map(d => d.merchant));
  }
  private supplyDue(
    town: Awaited<ReturnType<FinalizedLivingTownReader["getTown"]>>,
    markers: ReturnType<typeof livingTownSourceState>,
    item: "crystal" | "wood" | "herb" | "iron",
  ): boolean {
    const epoch = BigInt(town.data.epoch);
    if (town.data.paused || epoch === 0n || BigInt(markers.raw_epochs[item]) >= epoch)
      return false;
    if (!this.options.skipEmptySources) return true;
    // The deployed contract admits supply on five-minute boundaries. Choose
    // at most one of those opportunities per twenty-minute period, with no
    // accumulated issuance after downtime. Supply belongs only to specialists.
    if (epoch % 5n !== 0n || BigInt(markers.raw_epochs[item]) / 20n >= epoch / 20n)
      return false;
    const supplier = { crystal: "rex", wood: "bolt", herb: "luna", iron: "bolt" }[item];
    return town.data.npc_ledgers.some(l => l.actor.kind === "merchant" &&
      l.actor.merchant_id === supplier && BigInt(l.inventory.held[item]) +
      BigInt(l.inventory.production_output_reserved[item]) +
      BigInt(l.inventory.trade_inbound_reserved[item]) < 12n);
  }
  private async facts(
    reader: FinalizedLivingTownReader,
    reaction?: ReactionWork,
  ): Promise<MerchantPolicyInput> {
    const raw = await this.collect(reader);
    const collected = reaction
      ? this.store.reactions.attach(raw, reaction)
      : raw;
    const input = {
      ...collected,
      pricingHistory: this.store.merchantPricingHistory(),
      merchantTrading:
        collected.merchantTrading === true && this.store.merchantTrading,
    };
    requireStorage(
      canonicalLivingTownJson(input.town) ===
        canonicalLivingTownJson(await reader.getTown()),
      "merchant collection checkpoint mismatch",
    );
    if (
      input.negotiatedTrading &&
      input.stockSharingReaction &&
      this.store.negotiatedTrading
    ) {
      this.store.gate();
      const scopes = await Promise.allSettled((["rex", "luna", "bolt"] as const)
        .map(merchant => this.adapters[merchant].verifyNegotiationScope(reader)));
      const scopeFailure = scopes.find(r => r.status === "rejected");
      if (scopeFailure?.status === "rejected") throw scopeFailure.reason;
      input.negotiationAuthority = {
        journal: "ready",
        signerScopes: {
          rex: "town_negotiating_merchant",
          luna: "town_negotiating_merchant",
          bolt: "town_negotiating_merchant",
        },
      };
    } else delete input.negotiationAuthority;
    this.policy.evaluate(input);
    input.activityCheckpoint = {
      block_hash: reader.block.hash,
      block_height: reader.block.height,
      block_timestamp_ns: reader.block.timestampNs,
      market_revision: (input.town as { market_revision: string })
        .market_revision,
      event_sequence: (input.town as { event_sequence: string }).event_sequence,
    };
    return input;
  }
  private async refresh(
    decision: Decision,
    lane: TownLane,
    reader: FinalizedLivingTownReader,
    command: unknown,
  ): Promise<TownCall | null> {
    if (
      (this.operations && this.operations.mode !== "active") ||
      (this.options.admission && !this.options.admission())
    )
      return null;
    if (decision.kind === "reaction_cleanup") {
      const snapshot = await reader.getOffer(decision.offerId);
      if (
        snapshot.data.kind !== "found" ||
        snapshot.data.offer.status !== "pending"
      )
        return null;
      const offer = snapshot.data.offer;
      requireStorage(
        lane === offer.buyer,
        "cleanup requires original buyer lane",
      );
      if (BigInt(snapshot.block_timestamp_ns) < BigInt(offer.expires_at_ns))
        return null;
      return createLivingTownCall("expire_offers", {
        merchant_id: lane,
        offer_ids: [offer.offer_id],
        command,
      });
    }
    if (decision.kind === "assistant") {
      requireStorage(
        lane === "operator" && this.assistant?.shopIds.includes(decision.shop),
        "assistant outside reviewed operator scope",
      );
      if (!this.assistant!.canDispatch(decision.shop)) return null;
      return resolveAssistantReprice(
        decision.proposal,
        reader,
        command,
        decision.shop,
      );
    }
    if (decision.kind === "no_op") return null;
    const town = await reader.getTown();
    if (decision.kind === "raw" || decision.kind === "sweep") {
      requireStorage(lane === "operator", "source requires operator lane");
      if (town.data.paused || town.data.epoch === "0") return null;
      const state = livingTownSourceState((await reader.getSourceState()).data);
      if (decision.kind === "raw") {
        requireStorage(
          ["crystal", "wood", "herb", "iron"].includes(decision.item),
          "invalid fixed source item",
        );
        if (!this.supplyDue(town, state, decision.item as keyof typeof state.raw_epochs))
          return null;
        return createLivingTownCall("allocate_raw_supply", {
          item_id: decision.item,
          epoch: town.data.epoch,
          command,
          all_eligible: true,
        });
      }
      requireStorage(
        ["rex", "luna", "bolt"].includes(decision.merchant),
        "invalid fixed treasury",
      );
      if (
        BigInt(
          state.treasury_epochs[
            decision.merchant as keyof typeof state.treasury_epochs
          ],
        ) >= BigInt(town.data.epoch)
      )
        return null;
      return createLivingTownCall("sweep_merchant_treasury", {
        merchant_id: decision.merchant,
        epoch: town.data.epoch,
        command,
      });
    }
    requireStorage(
      decision.kind === "proposal" && lane === decision.merchant,
      "proposal merchant lane mismatch",
    );
    const input = await this.facts(
      reader,
      decision.reactionStepId
        ? (this.store.reactions.work(decision.reactionStepId) ?? undefined)
        : undefined,
    );
    requireStorage(
      input.fresh && input.historyComplete,
      "confirmed merchant facts incomplete",
    );
    try {
      if (decision.tradeApproval) {
        requireStorage(
          decision.origin === "model_proposal" && !!decision.inferenceRef,
          "seller preparation needs recorded model consent",
        );
        requireStorage(
          canonicalLivingTownJson(decision.tradeApproval.proposal) ===
            canonicalLivingTownJson(decision.proposal),
          "seller decision approval mismatch",
        );
        const step = compileSellerTradeApproval(
          input,
          decision.tradeApproval,
          this.policy,
          this.store.identity,
          command,
        );
        // A second mutation needs its own durable work item in Phase 5.
        return step.phase === decision.tradePhase ? step.call : null;
      }
      return resolveTownProposal(
        decision.proposal,
        input,
        decision.tickId,
        decision.merchant,
        this.policy,
        this.store.identity,
        command,
        decision.offerExpiryNs,
      ).call;
    } catch {
      return null;
    }
  }
  private async react(
    work: ReactionWork,
    reader: FinalizedLivingTownReader,
  ): Promise<SimulationPoll> {
    if (
      (this.operations && this.operations.mode !== "active") ||
      (this.options.admission && !this.options.admission())
    )
      return { kind: "blocked", reasons: ["operator_admission_stopped"] };
    const input = await this.facts(reader, work),
      town = await reader.getTown();
    if (!input.fresh || !input.historyComplete) return { kind: "deferred" };
    if (!work.decision) {
      if (this.options.modelReady && !this.options.modelReady())
        return { kind: "deferred", reasons: ["ai_provider_busy_or_budget_unavailable"] };
      let decision: Record<string, unknown>;
      let failureReason = "reaction_admission_unavailable";
      try {
        const admitted = this.store.reactions.admitModel(work, town.block_timestamp_ns);
        if (!admitted) {
          failureReason = BigInt(town.block_timestamp_ns) >= BigInt(work.deadlineNs)
            ? "reaction_window_expired" : "reaction_window_or_work_limit";
        }
        requireStorage(
          admitted,
          "root inference/work budget exhausted",
        );
        failureReason = "reaction_provider_unavailable";
        const delivery = await this.propose!({
          tickId: work.id,
          merchant: work.merchant,
          facts: structuredClone(input),
          schemaVersion: "living-town-proposal-v1",
          reaction: { rootId: work.rootId, stepId: work.id },
        });
        failureReason = "reaction_decision_invalid";
        requireStorage(
          isTownProposalDelivery(delivery),
          "reaction requires audited provider delivery",
        );
        const proposal = parseTownProposal(delivery.proposal);
        requireStorage(
          delivery.origin === "model_proposal" ||
            proposal.action.type === "wait",
          "reaction rules fallback must wait",
        );
        const command = {
          sequence: String(
            BigInt(
              String(this.store.checkpoint(work.merchant)["last_action_id"]),
            ) + 1n,
          ),
          config_version: town.deployment.config_version,
          valid_until_ns: String(
            BigInt(town.block_timestamp_ns) + 60000000000n,
          ),
        };
        const resolved = resolveTownProposal(
          proposal,
          input,
          work.id,
          work.merchant,
          this.policy,
          this.store.identity,
          command,
        );
        decision = {
          kind: "proposal",
          reactionStepId: work.id,
          tickId: work.id,
          merchant: work.merchant,
          proposal,
          origin: delivery.origin,
          inferenceRef: delivery.inferenceRef,
          validation: resolved.reason,
          ...(resolved.call?.method === "propose_trade" &&
          "expires_at_ns" in resolved.call.args
            ? { offerExpiryNs: resolved.call.args.expires_at_ns }
            : {}),
          ...(resolved.tradeApproval
            ? {
                tradeApproval: resolved.tradeApproval,
                tradePhase: resolved.tradePhase,
              }
            : {}),
        };
      } catch {
        decision = {
          kind: "no_op",
          reason: failureReason,
        };
      }
      if (
        (this.operations && this.operations.mode !== "active") ||
        (this.options.admission && !this.options.admission())
      )
        return { kind: "blocked", reasons: ["operator_admission_stopped"] };
      decision.checkpoint = input.activityCheckpoint;
      this.store.reactions.decide(work, decision);
      work = this.store.reactions.work(work.id)!;
    }
    return {
      kind: "advanced",
      action: await this.runtime.execute({
        id: work.id,
        tick: town.data.epoch,
        arrival: `merchant:${work.merchant}:reaction:${work.id}`,
        lane: work.merchant,
        decision: work.decision,
      }),
    };
  }
  private housekeepingDeferrals = 0;
  async poll(): Promise<SimulationPoll> {
    requireStorage(!this.busy, "simulation adapter already running");
    this.busy = true;
    const started = performance.now();
    let failed = false;
    try {
      this.operations?.observeDisk(this.store.dataDir);
      this.operations?.observeRuntime(this.store.operations());
      if (this.operations?.mode === "paused")
        return { kind: "blocked", reasons: ["operator_paused"] };
      let report = await this.runtime.recover();
      if (this.operations?.getMode() === "paused")
        return { kind: "blocked", reasons: ["operator_paused"] };
      if (this.operations?.mode === "recovery_only") {
        if (report.kind === "customer")
          await this.customers.recover({ preservePrepared: true });
        return {
          kind: "blocked",
          reasons: ["operator_recovery_only", ...report.reasons],
        };
      }
      if (report.kind === "customer") {
        const r = await this.customers.recover({ preservePrepared: true });
        if (this.operations && this.operations.mode !== "active")
          return { kind: "blocked", reasons: ["operator_admission_stopped"] };
        if (r.kind === "blocked") {
          const pending = this.store.unresolved();
          if (
            pending.length === 1 &&
            r.reasons.length > 0 &&
            r.reasons.every((x) =>
              [
                "prepared_customer_action",
                "signed_unsubmitted_customer_action",
              ].includes(x),
            )
          ) {
            await this.customers.resumePending(String(pending[0]!["id"]));
            return { kind: "advanced" };
          }
          return { kind: "blocked", reasons: r.reasons };
        }
        report = await this.runtime.recover();
      }
      if (report.kind !== "ready") {
        if (this.operations && this.operations.mode !== "active")
          return { kind: "blocked", reasons: ["operator_admission_stopped"] };
        const pending = this.store.unresolved();
        if (
          pending.length === 1 &&
          report.reasons.length > 0 &&
          report.reasons.every((r) => r === "unsent_town_action")
        )
          return {
            kind: "advanced",
            action: await this.runtime.resume(String(pending[0]!["id"])),
          };
        return { kind: "blocked", reasons: report.reasons };
      }
      const reader = await this.adapters.operator.client.finalized(),
        town = await reader.getTown();
      this.operations?.observeSnapshot(Date.now(), town.block_timestamp_ns);
      this.store.ticks.reconcile({
        town,
        block: reader.block,
        codeHash: reader.identity.codeHash,
      });
      // Always retire exhausted or terminal offer reactions, even while a
      // customer tick is queued or the AI provider is unavailable.
      if (this.store.negotiatedTrading &&
          this.store.reactions.advanceExpired(town.block_timestamp_ns))
        return { kind: "advanced" };
      let maintenanceInput: MerchantPolicyInput | undefined;
      let sourceMarkers: ReturnType<typeof livingTownSourceState> | undefined;
      let sourceTurn = false;
      if (this.options.independentSupply) {
        const active = this.store.ticks.active();
        sourceTurn = !!active && String(this.store.ticks.actions(String(active["id"]))
          .find(action => ["planned", "active"].includes(String(action["state"])))?.["arrival"] ?? "").startsWith("raw:");
        const root = this.store.negotiatedTrading ? this.store.reactions.active() : null;
        const savedDecision = root && BigInt(String(root["deadline_ns"])) > BigInt(town.block_timestamp_ns) &&
          this.store.reactions.steps(String(root["id"])).some(step => step["state"] === "decided");
        if (!active && !savedDecision && !town.data.paused && town.data.epoch !== "0" &&
          (!this.options.skipEmptySources || BigInt(town.data.epoch) % 5n === 0n)) {
          sourceMarkers = (await reader.getSourceState()).data;
          sourceTurn = (["crystal", "wood", "herb", "iron"] as const)
            .some(item => this.supplyDue(town, sourceMarkers!, item));
        }
      }
      const activeTick = this.store.ticks.active();
      const nextArrival = activeTick ? String(this.store.ticks.actions(String(activeTick["id"]))
        .find(action => ["planned", "active"].includes(String(action["state"])))?.["arrival"] ?? "") : "";
      const queuedCustomer = nextArrival === "fund" || /^[0-3]$/.test(nextArrival);
      // Cooperative independent housekeeping lane: while customers are queued,
      // permit an expired-offer cleanup after at most three customer polls.
      // All actual transactions still pass through the exclusive town executor.
      // Do not advance AI decisions here or consume customer opportunities.
      if (queuedCustomer && this.store.negotiatedTrading && this.propose && !sourceTurn &&
          this.store.reactions.needsCleanup(town.block_timestamp_ns)) {
        this.housekeepingDeferrals++;
        if (this.housekeepingDeferrals >= 4) {
          this.housekeepingDeferrals = 0;
          const input = await this.facts(reader);
          if (input.fresh && input.historyComplete) {
            this.store.reactions.observe(input);
            const priorRoot = this.store.reactions.active();
            const work = this.store.reactions.next(input, this.store.offers);
            if (work?.role === "cleanup") return this.react(work, reader);
            if (priorRoot && this.store.reactions.root(String(priorRoot.id))?.state === "closed")
              return { kind: "advanced" };
          }
        }
      } else this.housekeepingDeferrals = 0;
      // Recover signed work first (above), then service this epoch's customers
      // before collecting merchant policy or starting another AI reaction.
      if (queuedCustomer || (!activeTick && !sourceTurn && this.scheduler.hasPendingCustomers(town))) {
        // Fair turns: a completed customer opportunity yields once to queued
        // merchant work. Reaction execution uses the same journal/recovery lane,
        // so no transaction or signer runs concurrently with a customer sale.
        if (this.propose && this.store.negotiatedTrading && this.store.lastCompletedTurnWasCustomer() &&
          this.store.reactions.hasPending() &&
          (!this.options.modelReady || this.options.modelReady())) {
          const input = await this.facts(reader);
          if (input.fresh && input.historyComplete) {
            this.store.reactions.observe(input);
            const work = this.store.reactions.next(input, this.store.offers);
            if (work) return this.react(work, reader);
          }
        }
        const remaining = BigInt(town.data.genesis_time_ns) +
          (BigInt(town.data.epoch) + 1n) * 60000000000n - BigInt(town.block_timestamp_ns);
        if (!activeTick && remaining < 10000000000n)
          return { kind: "deferred", reasons: ["customer_window_too_short"] };
        const result = await this.customerRunner.poll();
        return { kind: result.kind, ...(result.reasons ? { reasons: result.reasons } : {}) };
      }
      // Supply has a narrow on-chain execution window and uses only operator
      // state. A stale display projection or unavailable AI cannot block it.
      if (!sourceTurn) this.store.marketEvents.observe(
        town, await reader.getMarketEvents(), reader.block, reader.identity.codeHash,
      );
      if (!sourceTurn && this.store.negotiatedTrading && this.propose) {
        const input = await this.facts(reader);
        maintenanceInput = input;
        if (!input.fresh || !input.historyComplete) return { kind: "deferred" };
        this.store.reactions.observe(input);
        if (this.options.merchantOpportunities)
          this.store.reactions.observeOpportunities(input, this.policy.evaluate(input).stockSharing?.candidates ?? []);
        if (!this.store.ticks.active()) {
          const active = this.store.reactions.active();
          const work = this.store.reactions.next(input, this.store.offers);
          // Keep deterministic listings AND production eligible even when an
          // expired offer is waiting for housekeeping. Every third epoch may
          // service cleanup to avoid starving it under constant stock demand.
          const maintenanceDue = this.policy.evaluate(input).decisions.some(d =>
            d.action.kind === "set_listing" ||
            d.action.kind === "start_production" ||
            d.action.kind === "complete_production");
          sourceMarkers = (await reader.getSourceState()).data;
          const supply = (["crystal", "wood", "herb", "iron"] as const)
            .some(item => this.supplyDue(town, sourceMarkers!, item));
          const cleanupTurn = BigInt(town.data.epoch) % 3n === 0n;
          if (work && ((work.decision && work.role !== "cleanup") ||
              (!supply && (!maintenanceDue || cleanupTurn))))
            return this.react(work, reader);
          if (
            active &&
            this.store.reactions.root(String(active.id))?.state === "closed"
          )
            return { kind: "advanced" };
        }
      }
      const prefix: { id: string; arrival: string }[] = [];
      if (!this.store.ticks.active()) {
        // Do not pay for a proposal when this pinned epoch cannot fit inference
        // and the repeated pre-sign checks. Expiry/recovery and quotas stay unchanged.
        if (
          BigInt(town.data.genesis_time_ns) +
            (BigInt(town.data.epoch) + 1n) * 60000000000n -
            BigInt(town.block_timestamp_ns) <
          BigInt(sourceTurn ? 10000 : (this.options.minimumTickWindowMs ?? 0)) * 1000000n
        )
          return { kind: "deferred" };
        const markers = sourceMarkers ?? (await reader.getSourceState()).data;
        const add = (arrival: string, parts: unknown[]) => {
          const id = sha256(
            canonicalLivingTownJson([
              "living-town-adapter-v1",
              this.store.identity,
              this.store.seed,
              ...parts,
            ]),
          );
          if (!this.store.get(id)) prefix.push({ id, arrival });
        };
        if (!town.data.paused && town.data.epoch !== "0") {
          for (const item of ["crystal", "wood", "herb", "iron"] as const)
            if (this.supplyDue(town, markers, item)) {
              add(`raw:${item}`, ["raw", item, town.data.epoch]);
              // One operator transaction replenishes every eligible material.
              break;
            }
          for (const name of ["rex", "luna", "bolt"] as const)
            if (!sourceTurn && BigInt(markers.treasury_epochs[name]) < BigInt(town.data.epoch))
              if (
                !this.options.skipEmptySources ||
                town.data.npc_ledgers.some(
                  (l) =>
                    l.actor.kind === "merchant" &&
                    l.actor.merchant_id === name &&
                    BigInt(l.gold.available) > 200n,
                )
              )
                add(`sweep:${name}`, ["sweep", name, town.data.epoch]);
        }
        const slot = (
          (BigInt(town.block_timestamp_ns) -
            BigInt(town.data.genesis_time_ns)) /
          (BigInt(this.scheduler.cadenceMs) * 1000000n)
        ).toString();
        let required: Set<string> | undefined;
        let shelves = new Set<string>();
        if (!sourceTurn && this.options.skipIdleMerchantTurns) {
          const input = maintenanceInput ?? await this.facts(reader);
          if (!input.fresh || !input.historyComplete)
            return { kind: "deferred" };
          required = new Set(
            this.policy
              .evaluate(input)
              .decisions.filter((d) => d.action.kind !== "wait")
              .map((d) => d.merchant),
          );
          shelves = this.shelfUpdates(input);
        }
        for (const name of ["rex", "luna", "bolt"] as const)
          if (!sourceTurn && (!required || required.has(name)))
            add(`merchant:${name}:${shelves.has(name) ? "shelf:" : ""}${slot}`,
              ["merchant", name, slot, ...(shelves.has(name) ? ["shelf"] : [])]);
        if (!sourceTurn && this.assistant && !town.data.paused) {
          // One shared automatic opportunity per chain epoch, including no-ops.
          // Round robin is deterministic; policy changes cannot reset this allowance.
          const shop =
            this.assistant.shopIds[
              Number(
                BigInt(town.data.epoch) % BigInt(this.assistant.shopIds.length),
              )
            ]!;
          add(`assistant:${shop}`, ["assistant", town.data.epoch]);
        }
      }
      const tick =
          this.store.ticks.active() ??
          (await this.scheduler.prepare(reader, prefix)),
        tickId = String(tick["id"]);
      const next = this.store.ticks
        .actions(tickId)
        .find((a) => ["planned", "active"].includes(String(a["state"])));
      if (!next) return { kind: "idle" };
      const arrival = String(next["arrival"]);
      if (arrival === "fund" || /^[0-3]$/.test(arrival)) {
        if (this.operations && this.operations.mode !== "active")
          return { kind: "blocked", reasons: ["operator_admission_stopped"] };
        const result = await this.customerRunner.poll();
        return {
          kind: result.kind,
          ...(result.reasons ? { reasons: result.reasons } : {}),
        };
      }
      requireStorage(next["state"] === "planned", "unresolved adapter action");
      let decision: Decision,
        lane: TownLane = "operator";
      if (arrival.startsWith("raw:"))
        decision = { kind: "raw", item: arrival.slice(4) };
      else if (arrival.startsWith("sweep:"))
        decision = { kind: "sweep", merchant: arrival.slice(6) };
      else if (arrival.startsWith("assistant:")) {
        const shop = arrival.slice(10);
        let proposal: unknown = null;
        try {
          proposal = await this.assistant?.propose(shop, reader);
        } catch {
          /* durable no-op */
        }
        decision = proposal
          ? { kind: "assistant", shop, proposal }
          : { kind: "no_op", reason: "assistant_unavailable_or_invalid" };
      } else {
        lane = arrival.split(":")[1] as ProposalMerchant;
        const input = maintenanceInput ?? await this.facts(reader);
        if (!input.fresh || !input.historyComplete) return { kind: "deferred" };
        const step = this.policy
          .evaluate(input)
          .decisions.find((d) => d.merchant === lane)!.action;
        const command = {
          sequence: (
            BigInt(String(this.store.checkpoint(lane)["last_action_id"])) + 1n
          ).toString(),
          config_version: town.deployment.config_version,
          valid_until_ns: (
            BigInt(town.data.genesis_time_ns) +
            (BigInt(town.data.epoch) + 1n) * 60000000000n
          ).toString(),
        };
        try {
          const model = this.propose && !this.store.negotiatedTrading &&
            (!this.options.modelReady || this.options.modelReady());
          const value = model
            ? await this.propose!({
                tickId,
                merchant: lane as ProposalMerchant,
                facts: structuredClone(input),
                schemaVersion: "living-town-proposal-v1",
              })
            : {
                schema: "living-town-proposal-v1",
                tick_id: tickId,
                market_revision: town.market_revision,
                merchant_id: lane,
                reason: "deterministic merchant policy",
                action:
                  step.kind === "wait"
                    ? { type: "wait" }
                    : {
                        type: "restock",
                        item_id:
                          step.kind === "set_listing" ||
                          step.kind === "merchant_purchase"
                            ? step.item
                            : "iron_tool",
                      },
              };
          const delivery = isTownProposalDelivery(value) ? value : null;
          const proposal = parseTownProposal(
              delivery ? delivery.proposal : value,
            ),
            resolution = resolveTownProposal(
              proposal,
              input,
              tickId,
              lane as ProposalMerchant,
              this.policy,
              this.store.identity,
              command,
            );
          if (
            ["propose_trade", "accept_trade", "reject_trade"].includes(
              proposal.action.type,
            )
          )
            requireStorage(
              delivery?.origin === "model_proposal",
              "negotiation requires an audited model delivery",
            );
          decision = {
            kind: "proposal",
            merchant: lane as ProposalMerchant,
            tickId,
            proposal,
            origin: delivery?.origin ?? (model ? "model_proposal" : "rules"),
            ...(delivery ? { inferenceRef: delivery.inferenceRef } : {}),
            validation: resolution.reason,
            ...(resolution.tradeApproval
              ? {
                  tradeApproval: resolution.tradeApproval,
                  tradePhase: resolution.tradePhase,
                }
              : {}),
            checkpoint: {
              block_hash: reader.block.hash,
              block_height: town.block_height,
              block_timestamp_ns: town.block_timestamp_ns,
              market_revision: town.market_revision,
              event_sequence: town.event_sequence,
            },
            signals: this.policy
              .evaluate(input)
              .scarcity.filter((s) => s.supplier === lane)
              .map((s) => ({
                item_id: s.item,
                held: s.held,
                reserved: s.reserved,
                scarcity_bps: s.scarcityBps,
                confirmed_demand: s.confirmedDemand,
                suggested_price: s.suggestedPrice,
              })),
          };
        } catch {
          decision = {
            kind: "no_op",
            reason: "invalid_or_unavailable_proposal",
          };
        }
      }
      if (this.operations && this.operations.mode !== "active")
        return { kind: "blocked", reasons: ["operator_admission_stopped"] };
      return {
        kind: "advanced",
        action: await this.runtime.execute({
          id: String(next["action_id"]),
          tick: String(tick["epoch"]),
          arrival,
          lane,
          decision,
        }),
      };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.busy = false;
      this.operations?.record("poll", performance.now() - started, failed);
      try {
        this.operations?.observeRuntime(this.store.operations());
      } catch {
        this.operations?.setMode("recovery_only");
      }
    }
  }
}
