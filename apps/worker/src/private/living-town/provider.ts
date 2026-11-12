import {
  canonicalLivingTownJson,
  livingTownSnapshot,
  livingTownTown,
} from "@bot-bazaar/chain";
import type { BudgetRepository, PreparedInference } from "../policy/budget.js";
import { maximumInferenceInputTokens } from "../policy/budget.js";
import { DefinitiveProviderFailure } from "../retries/provider.js";
import type { ProviderInvocation } from "../retries/provider.js";
import { SafetyClock } from "../retries/clock.js";
import { requireStorage, sha256 } from "../storage/validation.js";
import type { LivingTownExecutionStore } from "./execution-store.js";
import type { LivingTownMerchantPolicy } from "./merchant-policy.js";
import {
  parseTownProposal,
  resolveTownProposal,
  rulesTownProposal,
  TownProposalDelivery,
} from "./proposals.js";
import type { TownProposalContext, TownProposal } from "./proposals.js";
import { merchantCharacter } from "./merchant-characters.js";
import { negotiationAvailable } from "./negotiation.js";

export interface TownBudgetBinding {
  projectId: string;
  laneId: string;
  ledgerId: string;
}
export interface TownProviderConfiguration {
  provider: string;
  model: string;
  promptVersion: string;
  prepare: (context: TownProposalContext) => PreparedInference;
  invoke: ProviderInvocation;
}
class ProviderUnavailable extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** One shared budget authority supplied by the owner, never a fresh allowance per V2 deployment. */
import type { TownOperations } from "./operations.js";
export class LivingTownProviderRunner {
  private readonly clock: SafetyClock;
  private readonly pending = new Map<string, Promise<TownProposalDelivery>>();
  constructor(
    private readonly store: LivingTownExecutionStore,
    private readonly policy: LivingTownMerchantPolicy,
    private readonly budget: BudgetRepository | null,
    private readonly binding: TownBudgetBinding | null,
    private provider: TownProviderConfiguration | null,
    private readonly isCurrent: (
      context: TownProposalContext,
    ) => Promise<boolean>,
    private readonly timeoutMs = 15000,
    private readonly fallbackMode: "policy" | "wait" = "policy",
    clock?: SafetyClock,
    private readonly operations?: TownOperations,
    private readonly publishPending?: () => Promise<void>,
  ) {
    requireStorage(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 15000,
      "provider timeout must be 1-15000 milliseconds",
    );
    this.binding = binding ? Object.freeze({ ...binding }) : null;
    this.provider = provider ? Object.freeze({ ...provider }) : null;
    this.clock =
      clock ?? new SafetyClock(() => budget?.invalidate("town:clock-drift"));
  }
  replaceProvider(provider: TownProviderConfiguration): boolean {
    if (this.pending.size !== 0) return false;
    requireStorage(!this.provider || (provider.provider === this.provider.provider && provider.model === this.provider.model &&
      provider.promptVersion === this.provider.promptVersion), "provider refresh must preserve reviewed model identity");
    this.provider = Object.freeze({ ...provider });
    return true;
  }
  private now(): number {
    try {
      return this.clock.now();
    } catch {
      throw new ProviderUnavailable("clock_unavailable");
    }
  }
  /** Shared ledger limits survive refreshes/restarts and cover all merchants. */
  canInvoke(currentRequestId?: string, merchant?: string): boolean {
    if (!this.provider || !this.budget) return false;
    if (merchant
      ? !this.store.providerAttempts.capacityAvailable(merchant, currentRequestId)
      : this.pending.size >= 3) return false;
    try {
      const status = this.budget.status(this.now());
      return !status.blocked && (status.totalLimit === undefined ||
        (status.totalMicro ?? 0) + 1000 <= status.totalLimit);
    } catch { return false; }
  }
  requestId(context: TownProposalContext): string {
    if (context.reaction)
      return `town-provider:${sha256(canonicalLivingTownJson([this.store.identity, this.store.seed, context.reaction, context.merchant]))}`;
    return `town-provider:${sha256(canonicalLivingTownJson([this.store.identity, this.store.seed, context.tickId, context.merchant]))}`;
  }
  /** Rebase only after the shared accounting authority and economic journal have been reconciled. */
  resumeClock(): void {
    this.store.gate();
    requireStorage(
      this.budget && !this.budget.status().blocked,
      "shared usage recovery required",
    );
    this.clock.rebase();
  }
  propose(
    context: TownProposalContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<TownProposalDelivery> {
    const detached = structuredClone(context),
      id = this.requestId(detached),
      old = this.pending.get(id);
    if (old) return old;
    const request = this.run(id, detached, options).finally(() => {
      this.pending.delete(id);
      if (this.operations) {
        try {
          const row = this.store.providerAttempts.get(id);
          this.operations.observeProvider(
            !this.provider
              ? "disabled"
              : row?.status === "accepted"
                ? "available"
                : "unavailable",
            this.budget?.status(this.now()) ?? null,
            Number(row?.finished_at ?? row?.started_at ?? Date.now()),
          );
        } catch {
          this.operations.observeProvider("unavailable", null);
        }
      }
    });
    this.pending.set(id, request);
    return request;
  }
  private fallback(
    context: TownProposalContext,
    code: string,
    wait = false,
  ): TownProposal {
    return rulesTownProposal(
      context,
      this.policy,
      `rules fallback: ${code}`,
      wait ||
        this.fallbackMode === "wait" ||
        context.facts.negotiatedTrading === true,
    );
  }
  private async run(
    id: string,
    context: TownProposalContext,
    options: { signal?: AbortSignal },
  ): Promise<TownProposalDelivery> {
    this.store.gate();
    const signals = this.policy.evaluate(context.facts),
      town = livingTownSnapshot(livingTownTown)(context.facts.town),
      tick = this.store.ticks.active();
    requireStorage(
      !negotiationAvailable(context.facts) || this.store.negotiatedTrading,
      "negotiation requires the offer execution journal",
    );
    const next = tick
      ? this.store.ticks
          .actions(String(tick["id"]))
          .find((a) => ["planned", "active"].includes(String(a["state"])))
      : undefined;
    requireStorage(
      context.schemaVersion === "living-town-proposal-v1" &&
        (context.reaction
          ? this.store.reactions.modelContext(
              context.reaction.rootId,
              context.reaction.stepId,
              context.merchant,
            ) && context.tickId === context.reaction.stepId
          : tick?.["id"] === context.tickId &&
            next?.["state"] === "planned" &&
            String(next["arrival"]).startsWith(
              `merchant:${context.merchant}:`,
            )),
      "provider requires the current planned merchant opportunity",
    );
    const saved = this.store.providerAttempts.get(id);
    if (saved) {
      const raw = saved["fallback_json"] ?? saved["proposal_json"];
      if (raw !== null) {
        const p = parseTownProposal(JSON.parse(String(raw)));
        if (
          p.tick_id === context.tickId &&
          p.merchant_id === context.merchant &&
          p.market_revision === town.market_revision
        )
          return new TownProposalDelivery(
            p,
            saved["fallback_json"] !== null ? "rules" : "model_proposal",
            id,
          );
      }
      const code =
          ["prepared", "reserved", "dispatched"].includes(
            String(saved["status"]),
          ) || saved["code"] === "restart_unknown"
            ? "recovered_unknown_attempt"
            : "cached_context_changed",
        p = this.fallback(context, code, true);
      if (
        !this.store.providerAttempts.finish(id, "fallback", code, p, Date.now())
      )
        this.store.providerAttempts.fallbackRecord(id, code, p);
      return new TownProposalDelivery(p, "rules", id);
    }
    let now: number,
      clockUnavailable = false;
    try {
      now = this.now();
    } catch {
      now = Date.now();
      clockUnavailable = true;
    }
    requireStorage(
      Number.isSafeInteger(now) && now >= 0,
      "audit clock unavailable",
    );
    const cutoff = context.reaction
      ? BigInt(this.store.reactions.work(context.reaction.stepId)!.deadlineNs)
      : BigInt(town.data.genesis_time_ns) +
        (BigInt(town.data.epoch) + 1n) * 60000000000n;
    const remaining = Number(
      (cutoff - BigInt(town.block_timestamp_ns)) / 1000000n,
    );
    const deadline = now + Math.max(1, Math.min(this.timeoutMs, remaining));
    // Merchant-scoped capacity, without allowing duplicate provider requests.
    if (!this.store.providerAttempts.capacityAvailable(context.merchant))
      throw new ProviderUnavailable("provider_capacity_exhausted");
    this.store.providerAttempts.begin({
      id,
      tickId: context.tickId,
      merchant: context.merchant,
      provider: this.provider?.provider ?? "none",
      model: this.provider?.model ?? "none",
      promptVersion: this.provider?.promptVersion ?? "none",
      ledgerId: this.binding?.ledgerId ?? null,
      context: {
        tickId: context.tickId,
        merchant: context.merchant,
        signals,
        character: merchantCharacter(context.merchant),
        character_sha256: sha256(
          JSON.stringify(merchantCharacter(context.merchant)),
        ),
        negotiation_available: negotiationAvailable(context.facts),
        reaction: context.facts.stockSharingReaction ?? null,
        checkpoint: context.facts.activityCheckpoint ?? null,
        incoming_offers: (context.facts.pendingOffers ?? []).filter(
          (o) => (o as { seller?: string }).seller === context.merchant,
        ),
      },
      now,
      deadline,
    });
    let closed = false,
      identitySeen = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt: ((error: Error) => void) | undefined;
    const cancel = () => {
      abort.abort();
      interrupt?.(new ProviderUnavailable("request_cancelled"));
    };
    const late = () => {
      try {
        this.store.providerAttempts.late(id);
      } catch {
        /* A closed journal cannot authorize a late result. */
      }
    };
    try {
      if (clockUnavailable) throw new ProviderUnavailable("clock_unavailable");
      if (!this.provider || !this.budget || !this.binding)
        throw new ProviderUnavailable("provider_not_configured");
      if (options.signal?.aborted)
        throw new ProviderUnavailable("request_cancelled");
      const interrupted = new Promise<never>((_resolve, reject) => {
        interrupt = reject;
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(
        () => {
          abort.abort();
          interrupt?.(new ProviderUnavailable("request_timeout"));
        },
        Math.max(1, deadline - this.now()),
      );
      const config = this.budget.history().config,
        ledger = this.budget.context();
      if (
        config.projectId !== this.binding.projectId ||
        config.laneId !== this.binding.laneId ||
        ledger.ledgerId !== this.binding.ledgerId
      )
        throw new ProviderUnavailable("budget_binding_mismatch");
      if (this.budget.status(now).blocked)
        throw new ProviderUnavailable("budget_history_unverified");
      if (
        !context.facts.fresh ||
        !context.facts.historyComplete ||
        !(await Promise.race([this.isCurrent(context), interrupted]))
      )
        throw new ProviderUnavailable("stale_context");
      const prepared = Object.freeze({
        ...this.provider.prepare(structuredClone(context)),
      });
      if (prepared.countTokens(prepared.payload) > maximumInferenceInputTokens)
        throw new ProviderUnavailable("prompt_too_large");
      requireStorage(
        prepared.provider === this.provider.provider &&
          prepared.model === this.provider.model &&
          prepared.verifiedUntil >= deadline,
        "unverified provider/pricing identity",
      );
      // The shared authority reserves the full bounded call against the
      // original lifetime budget, including unresolved billing reservations.
      if (!this.canInvoke(id, context.merchant)) throw new ProviderUnavailable("provider_busy_or_total_budget_exhausted");
      try {
        this.budget.reserve(id, prepared, now);
      } catch {
        throw new ProviderUnavailable("budget_admission_rejected");
      }
      this.store.providerAttempts.transition(
        id,
        "reserved",
        sha256(prepared.payload),
      );
      if (this.now() >= deadline)
        throw new ProviderUnavailable("request_timeout");
      this.store.providerAttempts.transition(id, "dispatched");
      await this.publishPending?.();
      const response = Promise.resolve()
        .then(() => {
          if (closed || abort.signal.aborted)
            throw new ProviderUnavailable("request_cancelled");
          return this.provider!.invoke({
            signal: abort.signal,
            requestId: id,
            payload: prepared.payload,
            maxOutputTokens: 512,
            reportIdentity: (actual) => {
              if (closed) {
                late();
                if (
                  actual.provider !== prepared.provider ||
                  actual.model !== prepared.model
                )
                  try {
                    this.budget!.invalidate("town:late-identity-mismatch");
                  } catch {
                    /* A closed budget cannot authorize further inference. */
                  }
                return;
              }
              if (
                actual.provider !== prepared.provider ||
                actual.model !== prepared.model
              ) {
                this.budget!.invalidate("town:model-identity-mismatch");
                throw new ProviderUnavailable("model_identity_mismatch");
              }
              if (closed) {
                late();
                return;
              }
              identitySeen = true;
            },
          });
        })
        .then(async (value) => {
          if (closed || abort.signal.aborted || this.now() >= deadline) {
            late();
            throw new ProviderUnavailable("late_response");
          }
          if (!identitySeen) {
            this.budget!.invalidate("town:model-identity-unverified");
            throw new ProviderUnavailable("model_identity_unverified");
          }
          let proposal: TownProposal;
          try {
            proposal = parseTownProposal(value);
          } catch {
            throw new ProviderUnavailable("schema_invalid");
          }
          const command = {
            sequence: (
              BigInt(
                String(
                  this.store.checkpoint(context.merchant)["last_action_id"],
                ),
              ) + 1n
            ).toString(),
            config_version: town.deployment.config_version,
            valid_until_ns: (context.reaction
              ? BigInt(town.block_timestamp_ns) + 60000000000n
              : BigInt(town.data.genesis_time_ns) +
                (BigInt(town.data.epoch) + 1n) * 60000000000n
            ).toString(),
          };
          try {
            resolveTownProposal(
              proposal,
              context.facts,
              context.tickId,
              context.merchant,
              this.policy,
              this.store.identity,
              command,
            );
          
            } catch (error) {
              console.error(JSON.stringify({
                role: "economic_runtime",
                event: "merchant_policy_rejection",
                merchant: context.merchant,
                request_id: id,
                proposed_action: proposal.action,
                rejection_reason:
                  error instanceof Error
                    ? error.message
                    : "unknown_validation_error",
              }));

              throw new ProviderUnavailable("policy_rejected");
            }

          if (
            !(await this.isCurrent(context)) ||
            closed ||
            abort.signal.aborted ||
            this.now() >= deadline
          ) {
            late();
            throw new ProviderUnavailable("stale_response");
          }
          // This reply belongs to an already admitted, accounted attempt.
          // A simultaneous transaction may temporarily close NEW-work admission.
          if (!context.reaction) this.store.gate();
          if (
            !this.store.providerAttempts.finish(
              id,
              "accepted",
              "validated_model_proposal",
              proposal,
              this.now(),
            )
          ) {
            late();
            throw new ProviderUnavailable("attempt_closed");
          }
          return proposal;
        });
      
      const proposal = await Promise.race([response, interrupted]);

      console.log(
        JSON.stringify({
          role: "economic_runtime",
          event: "merchant_ai_decision",
          merchant: context.merchant,
          request_id: id,
          reaction: context.reaction ?? null,
          status: "accepted",
          model: this.provider?.model ?? null,
          action: proposal.action,
          reason: proposal.reason,
          validation: "validated_model_proposal",
        }),
      );

      return new TownProposalDelivery(proposal, "model_proposal", id);

    } catch (error) {
      closed = true;
      abort.abort();
      if (
        error instanceof Error &&
        error.name === "NearAiHttpError"
      ) {
        const failure = error as Error & {
          status: number;
          detail?: string;
          parameter?: string;
        };

        console.error(
          JSON.stringify({
            role: "economic_runtime",
            event: "near_ai_request_failed",
            merchant: context.merchant,
            status: failure.status,
            message: failure.detail ?? "No error details returned",
            parameter: failure.parameter ?? null,
          }),
        );
      }
      const httpStatus =
        error instanceof Error &&
        error.name === "NearAiHttpError" &&
        "status" in error &&
        Number.isInteger(error.status)
          ? Number(error.status)
          : 0;
      const code =
        error instanceof ProviderUnavailable
          ? error.code
          : error instanceof DefinitiveProviderFailure
            ? "definitive_provider_failure"
            : httpStatus >= 400 && httpStatus <= 599
              ? `near_ai_http_${httpStatus}`
              : "provider_or_admission_unavailable";
      const p = this.fallback(
        context,
        code,
        [
          "clock_unavailable",
          "stale_context",
          "stale_response",
          "request_cancelled",
        ].includes(code),
      );
      
      if (
        !this.store.providerAttempts.finish(id, "fallback", code, p, Date.now())
      )
        this.store.providerAttempts.fallbackRecord(id, code, p);

      console.error(
        canonicalLivingTownJson({
          role: "economic_runtime",
          event: "merchant_ai_decision",
          merchant: context.merchant,
          request_id: id,
          reaction: context.reaction ?? null,
          status: "fallback",
          model: this.provider?.model ?? null,
          failure_code: code,
          action: p.action,
          reason: p.reason,
        }),
      );

      return new TownProposalDelivery(p, "rules", id);

    } finally {
      closed = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
}
