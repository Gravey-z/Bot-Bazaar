import {
  canonicalLivingTownJson,
  livingTownSnapshot,
  livingTownTown,
} from "@bot-bazaar/chain";
import type { BudgetRepository, PreparedInference } from "../policy/budget.js";
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
    private readonly provider: TownProviderConfiguration | null,
    private readonly isCurrent: (
      context: TownProposalContext,
    ) => Promise<boolean>,
    private readonly timeoutMs = 15000,
    private readonly fallbackMode: "policy" | "wait" = "policy",
    clock?: SafetyClock,
    private readonly operations?: TownOperations,
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
  private now(): number {
    try {
      return this.clock.now();
    } catch {
      throw new ProviderUnavailable("clock_unavailable");
    }
  }
  requestId(context: TownProposalContext): string {
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
      wait || this.fallbackMode === "wait",
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
    const next = tick
      ? this.store.ticks
          .actions(String(tick["id"]))
          .find((a) => ["planned", "active"].includes(String(a["state"])))
      : undefined;
    requireStorage(
      context.schemaVersion === "living-town-proposal-v1" &&
        tick?.["id"] === context.tickId &&
        next?.["state"] === "planned" &&
        String(next["arrival"]).startsWith(`merchant:${context.merchant}:`),
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
    const remaining = Number(
      (BigInt(town.data.genesis_time_ns) +
        (BigInt(town.data.epoch) + 1n) * 60000000000n -
        BigInt(town.block_timestamp_ns)) /
        1000000n,
    );
    const deadline = now + Math.max(1, Math.min(this.timeoutMs, remaining));
    // No pending inference takeover, including another runner in this process.
    const busy = this.store.providerAttempts.pending();
    if (busy) throw new ProviderUnavailable("provider_already_pending");
    this.store.providerAttempts.begin({
      id,
      tickId: context.tickId,
      merchant: context.merchant,
      provider: this.provider?.provider ?? "none",
      model: this.provider?.model ?? "none",
      promptVersion: this.provider?.promptVersion ?? "none",
      ledgerId: this.binding?.ledgerId ?? null,
      context: { tickId: context.tickId, merchant: context.merchant, signals },
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
      requireStorage(
        prepared.provider === this.provider.provider &&
          prepared.model === this.provider.model &&
          prepared.verifiedUntil >= deadline,
        "unverified provider/pricing identity",
      );
      // Existing rolling money/token/request caps apply across V1, V2 and rehearsals in this exact ledger.
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
            config_version: "1",
            valid_until_ns: (
              BigInt(town.data.genesis_time_ns) +
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
          } catch {
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
          this.store.gate();
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
      return new TownProposalDelivery(proposal, "model_proposal", id);
    } catch (error) {
      closed = true;
      abort.abort();
      const code =
        error instanceof ProviderUnavailable
          ? error.code
          : error instanceof DefinitiveProviderFailure
            ? "definitive_provider_failure"
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
      return new TownProposalDelivery(p, "rules", id);
    } finally {
      closed = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
}
