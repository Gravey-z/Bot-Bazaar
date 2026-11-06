import {
  canonicalLivingTownJson,
  createLivingTownCall,
  livingTownSourceState,
} from "@bot-bazaar/chain";
import type { FinalizedLivingTownReader } from "@bot-bazaar/chain";
import type { ContinuityVerifier } from "../recovery/types.js";
import { requireStorage, sha256 } from "../storage/validation.js";
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

type Decision =
  | { kind: "raw"; item: string }
  | { kind: "sweep"; merchant: string }
  | { kind: "no_op"; reason: string }
  | {
      kind: "proposal";
      merchant: ProposalMerchant;
      tickId: string;
      proposal: TownProposal;
      origin: "rules" | "model_proposal";
      validation: string;
      inferenceRef?: string;
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
    }) => Promise<unknown>,
  ) {
    this.runtime = new DurableTownExecutor(
      store,
      adapters,
      continuity,
      (decision, lane, reader, command) =>
        this.refresh(decision as Decision, lane, reader, command),
    );
  }
  private async facts(
    reader: FinalizedLivingTownReader,
  ): Promise<MerchantPolicyInput> {
    const input = await this.collect(reader);
    requireStorage(
      canonicalLivingTownJson(input.town) ===
        canonicalLivingTownJson(await reader.getTown()),
      "merchant collection checkpoint mismatch",
    );
    this.policy.evaluate(input);
    return input;
  }
  private async refresh(
    decision: Decision,
    lane: TownLane,
    reader: FinalizedLivingTownReader,
    command: unknown,
  ): Promise<TownCall | null> {
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
        if (
          BigInt(
            state.raw_epochs[decision.item as keyof typeof state.raw_epochs],
          ) >= BigInt(town.data.epoch)
        )
          return null;
        return createLivingTownCall("allocate_raw_supply", {
          item_id: decision.item,
          epoch: town.data.epoch,
          command,
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
    const input = await this.facts(reader);
    requireStorage(
      input.fresh && input.historyComplete,
      "confirmed merchant facts incomplete",
    );
    try {
      return resolveTownProposal(
        decision.proposal,
        input,
        decision.tickId,
        decision.merchant,
        this.policy,
        this.store.identity,
        command,
      ).call;
    } catch {
      return null;
    }
  }
  async poll(): Promise<SimulationPoll> {
    requireStorage(!this.busy, "simulation adapter already running");
    this.busy = true;
    try {
      let report = await this.runtime.recover();
      if (report.kind === "customer") {
        const r = await this.customers.recover({ preservePrepared: true });
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
      this.store.ticks.reconcile({
        town,
        block: reader.block,
        codeHash: reader.identity.codeHash,
      });
      this.store.marketEvents.observe(
        town,
        await reader.getMarketEvents(),
        reader.block,
        reader.identity.codeHash,
      );
      const prefix: { id: string; arrival: string }[] = [];
      if (!this.store.ticks.active()) {
        const markers = (await reader.getSourceState()).data;
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
            if (BigInt(markers.raw_epochs[item]) < BigInt(town.data.epoch))
              add(`raw:${item}`, ["raw", item, town.data.epoch]);
          for (const name of ["rex", "luna", "bolt"] as const)
            if (BigInt(markers.treasury_epochs[name]) < BigInt(town.data.epoch))
              add(`sweep:${name}`, ["sweep", name, town.data.epoch]);
        }
        const slot = (
          (BigInt(town.block_timestamp_ns) -
            BigInt(town.data.genesis_time_ns)) /
          (BigInt(this.scheduler.cadenceMs) * 1000000n)
        ).toString();
        for (const name of ["rex", "luna", "bolt"] as const)
          add(`merchant:${name}:${slot}`, ["merchant", name, slot]);
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
      else {
        lane = arrival.split(":")[1] as ProposalMerchant;
        const input = await this.facts(reader);
        if (!input.fresh || !input.historyComplete) return { kind: "deferred" };
        const step = this.policy
          .evaluate(input)
          .decisions.find((d) => d.merchant === lane)!.action;
        const command = {
          sequence: (
            BigInt(String(this.store.checkpoint(lane)["last_action_id"])) + 1n
          ).toString(),
          config_version: "1",
          valid_until_ns: (
            BigInt(town.data.genesis_time_ns) +
            (BigInt(town.data.epoch) + 1n) * 60000000000n
          ).toString(),
        };
        try {
          const value = this.propose
            ? await this.propose({
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
                          step.kind === "set_listing" ? step.item : "iron_tool",
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
          decision = {
            kind: "proposal",
            merchant: lane as ProposalMerchant,
            tickId,
            proposal,
            origin:
              delivery?.origin ?? (this.propose ? "model_proposal" : "rules"),
            ...(delivery ? { inferenceRef: delivery.inferenceRef } : {}),
            validation: resolution.reason,
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
    } finally {
      this.busy = false;
    }
  }
}
