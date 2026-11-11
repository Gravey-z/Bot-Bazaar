import { canonicalLivingTownJson } from "@bot-bazaar/chain";
import type {
  FinalizedLivingTownReader,
  LivingTownClient,
} from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";
import type { TownOperations } from "./operations.js";
import type { CustomerDemandInput } from "./customers.js";
import { sameCustomerCheckpointState } from "./customers.js";
import type {
  DurableCustomerExecutor,
  CustomerExecutionResult,
} from "./customer-executor.js";
import type { LivingTownExecutionStore } from "./execution-store.js";
import type { LivingTownTickScheduler } from "./ticks.js";

export type TickRunResult = {
  kind: "blocked" | "idle" | "deferred" | "advanced";
  tickId?: string;
  reasons?: string[];
  action?: CustomerExecutionResult | { kind: "skipped"; actionId: string };
};
/** Latest-slot catch-up only. One poll resumes/dispatches at most one original economic action. */
export class LivingTownTickRunner {
  private busy = false;
  constructor(
    private readonly store: LivingTownExecutionStore,
    private readonly scheduler: LivingTownTickScheduler,
    private readonly executor: DurableCustomerExecutor,
    private readonly client: LivingTownClient,
    private readonly collect: (
      reader: FinalizedLivingTownReader,
    ) => Promise<Omit<CustomerDemandInput, "seed" | "tick" | "arrivalIndex">>,
    private readonly operations?: TownOperations,
  ) {
    requireStorage(
      canonicalLivingTownJson(client.identity) ===
        canonicalLivingTownJson(store.identity),
      "tick runner client identity mismatch",
    );
  }
  async poll(): Promise<TickRunResult> {
    requireStorage(!this.busy, "tick runner already in progress");
    this.busy = true;
    try {
      if (this.operations?.mode === "paused")
        return { kind: "blocked", reasons: ["operator_paused"] };
      const recovered = await this.executor.recover({ preservePrepared: true });
      if (this.operations && this.operations.mode !== "active")
        return { kind: "blocked", reasons: ["operator_recovery_only"] };
      if (recovered.kind === "blocked") {
        const pending = this.store.unresolved();
        if (
          pending.length === 1 &&
          recovered.reasons.length > 0 &&
          recovered.reasons.every((r) =>
            [
              "prepared_customer_action",
              "signed_unsubmitted_customer_action",
            ].includes(r),
          )
        ) {
          const action = await this.executor.resumePending(
            String(pending[0]!["id"]),
          );
          return { kind: "advanced", action };
        }
        return { kind: "blocked", reasons: recovered.reasons };
      }
      const reader = await this.client.finalized(),
        town = await reader.getTown();
      const checkpoint = {
        block: reader.block,
        codeHash: reader.identity.codeHash,
        town,
      };
      this.store.ticks.reconcile(checkpoint);
      const priorTickId = this.store.ticks.active()?.["id"];
      if (this.store.ticks.skipFunding(checkpoint))
        return { kind: "advanced", tickId: String(priorTickId) };
      const tick =
        this.store.ticks.active() ?? (await this.scheduler.prepare(reader));
      const tickId = String(tick["id"]);
      const next = this.store.ticks
        .actions(tickId)
        .find((a) => a["state"] === "planned" || a["state"] === "active");
      if (!next) return { kind: "idle", tickId };
      requireStorage(
        next["state"] === "planned",
        "tick action lacks recoverable journal outcome",
      );
      let action: CustomerExecutionResult;
      if (next["arrival"] === "fund")
        action = await this.executor.fundCurrentEpoch();
      else {
        const facts = await this.collect(reader);
        // A collector must supply a coherent complete market/history at the requested checkpoint.
        // Do not consume an opportunity on transient stale/partial facts or retry in a tight loop.
        if (
          !facts.fresh ||
          !facts.marketComplete ||
          !facts.historyComplete ||
          canonicalLivingTownJson(facts.town) !== canonicalLivingTownJson(town)
        )
          return { kind: "deferred", tickId };
        const latest = await this.client.finalized();
        if (!sameCustomerCheckpointState(town, await latest.getTown()))
          return { kind: "deferred", tickId };
        if (this.operations && this.operations.mode !== "active")
          return { kind: "blocked", reasons: ["operator_admission_stopped"] };
        action = await this.executor.executeCustomer({
          ...facts,
          seed: this.store.seed,
          tick: String(tick["epoch"]),
          arrivalIndex: String(next["arrival"]),
        });
      }
      requireStorage(
        action.actionId === next["action_id"],
        "tick dispatch action identity mismatch",
      );
      // Allocation may have become visible between planning and dispatch. Verify on the next poll.
      return {
  kind:
    action.kind === "already_allocated" ||
    action.kind === "stale_checkpoint"
      ? "deferred"
      : "advanced",
  tickId,
  action,
};
    } finally {
      this.busy = false;
    }
  }
}
