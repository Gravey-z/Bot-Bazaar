import {
  canonicalLivingTownJson,
  livingTownCommandDigest,
  verifyLivingTownEffect,
  verifyLivingTownCompletionEffect,
} from "@bot-bazaar/chain";
import type {
  FinalizedLivingTownReader,
  LivingTownProof,
  LivingTownCompletionProof,
  LivingTownCall,
} from "@bot-bazaar/chain";
import type { ContinuityVerifier } from "../recovery/types.js";
import { requireStorage, sha256 } from "../storage/validation.js";
import {
  TownChainAdapter,
  readTownPrepared,
  townCall,
  validateTownOfferCall,
} from "./town-chain.js";
import type { TownCall, PreparedTownCall } from "./town-chain.js";
import { LivingTownExecutionStore, townLanes } from "./execution-store.js";
import type { TownLane } from "./execution-store.js";

export interface TownWork {
  id: string;
  tick: string;
  arrival: string;
  lane: TownLane;
  decision: unknown;
}
export type TownRecovery = {
  kind: "ready" | "blocked" | "customer";
  reasons: string[];
};
export type TownSubmission = {
  kind: "submitted" | "unknown" | "no_op" | "expired";
  actionId: string;
  transactionHash?: string;
};
class StaleTownStep extends Error {}
/** Only deterministic shelf reconciliation may outlive its scheduling epoch.
 * Economic proposals, source allocations and customer demand remain epoch-bound.
 * The selected listing is still recompiled and compared before every signature.
 */
function shelfMaintenance(work: TownWork): boolean {
  const d = work.decision as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return false;
  const proposal = d["proposal"] as { action?: { type?: string } } | undefined;
  return /^merchant:(rex|luna|bolt):shelf:[0-9]+$/.test(work.arrival) &&
    work.arrival.split(":")[1] === work.lane &&
    d["kind"] === "proposal" && d["origin"] === "rules" &&
    d["inferenceRef"] === undefined &&
    d["merchant"] === work.lane && proposal?.action?.type === "restock";
}
/** Uses the original shared journal. The refresh callback is deterministic, never inference/signing. */
export class DurableTownExecutor {
  private busy = false;
  private authorized = false;
  constructor(
    private readonly store: LivingTownExecutionStore,
    private readonly adapters: Record<TownLane, TownChainAdapter>,
    private readonly continuity: ContinuityVerifier,
    private readonly refresh: (
      decision: unknown,
      lane: TownLane,
      reader: FinalizedLivingTownReader,
      command: unknown,
    ) => Promise<TownCall | null>,
  ) {
    for (const lane of townLanes)
      requireStorage(
        adapters[lane].lane === lane &&
          canonicalLivingTownJson(adapters[lane].identity) ===
            canonicalLivingTownJson(store.identity),
        "town executor adapter identity mismatch",
      );
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    requireStorage(!this.busy, "town executor busy");
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      this.authorized = false;
      this.store.invalidate();
      throw e;
    } finally {
      this.busy = false;
    }
  }
  async recover(): Promise<TownRecovery> {
    return this.exclusive(async () => {
      this.authorized = false;
      this.store.invalidate();
      const context = {
          sessionId: this.store.sessionId,
          identityHash: this.store.identityHash,
        },
        proof = await this.continuity(context);
      if (
        !proof ||
        proof.sessionId !== context.sessionId ||
        proof.identityHash !== context.identityHash ||
        proof.journal !== "current" ||
        proof.fencing !== "verified" ||
        proof.providerHistory !== "accounted" ||
        !/^[a-zA-Z0-9:_.-]{1,128}$/.test(proof.evidenceRef)
      )
        return {
          kind: "blocked",
          reasons: ["journal_continuity_or_fencing_unverified"],
        };
      this.authorized = true;
      const reasons: string[] = [];
      for (const row of this.store.unresolved()) {
        if (
          ["fund_customer_budget", "settle_customer_purchase"].includes(
            String(row["method"]),
          )
        )
          return { kind: "customer", reasons: [] };
        const lane = String(row["merchant_id"]) as TownLane,
          adapter = this.adapters[lane],
          actionId = String(row["id"]);
        requireStorage(adapter, "invalid journal lane");
        if (["prepared", "signed"].includes(String(row["status"]))) {
          reasons.push("unsent_town_action");
          continue;
        }
        const p = readTownPrepared(
          String(row["signed_json"]),
          this.store.identity,
          lane,
        );
        requireStorage(
          p.transactionHash === row["tx_hash"] &&
            canonicalLivingTownJson(p.call.args) === row["args_json"] &&
            p.call.method === row["method"],
          "town recovery signed mismatch",
        );
        let status;
        try {
          status = await (p.call.method === "complete_production"
            ? adapter.client.completionReceipt(p as LivingTownCompletionProof)
            : adapter.client.receipt(p as LivingTownProof));
        } catch {
          status = {
            kind: "unknown" as const,
            transactionHash: p.transactionHash,
          };
        }
        if (status.kind === "succeeded") {
          await (p.call.method === "complete_production"
            ? verifyLivingTownCompletionEffect(
                status.result,
                this.store.identity.deployment,
                p.signerId,
                p.call,
              )
            : verifyLivingTownEffect(
                status.result,
                this.store.identity.deployment,
                p.signerId,
                p.call,
              ));
          this.store.resolveTown(actionId, status, true);
        } else if (status.kind === "failed")
          this.store.resolveTown(actionId, status, false);
        else if (
          p.call.method !== "complete_production" &&
          "command" in p.call.args
        ) {
          const reader = await adapter.client.finalized(),
            principal =
              lane === "operator"
                ? this.store.identity.operatorId
                : `merchant:${lane}`;
          const checkpoint = await reader.getCommand(
            principal,
            p.call.args.command.sequence,
          );
          if (checkpoint.data.kind === "found") {
            requireStorage(
              checkpoint.data.method === p.call.method &&
                checkpoint.data.payload_sha256 === row["args_digest"],
              "town command checkpoint conflict",
            );
            await verifyLivingTownEffect(
              {
                ...checkpoint,
                data: { ...checkpoint.data.effect, replayed: true },
              },
              this.store.identity.deployment,
              p.signerId,
              p.call,
            );
            this.store.resolveTown(
              actionId,
              { kind: "command_checkpoint", command: checkpoint },
              true,
            );
          } else reasons.push("unknown_town_receipt");
        } else reasons.push("unknown_town_completion");
      }
      if (reasons.length || this.store.unresolved().length)
        return { kind: "blocked", reasons };
      const reader = await this.adapters.operator.client.finalized(),
        checkpoints = {} as Record<
          TownLane,
          { sequence: string; digest: string | null }
        >;
      if (this.store.negotiatedTrading)
        await this.store.offers.reconcile(reader);
      const commandResults = await Promise.allSettled(townLanes.map(async lane => {
        const old = this.store.checkpoint(lane)["last_action_id"],
          c = await reader.getCommand(
            lane === "operator"
              ? this.store.identity.operatorId
              : `merchant:${lane}`,
            old === null || old === "0" ? "1" : String(old),
          );
        return { lane, checkpoint: {
          sequence: c.data.high_water,
          digest: c.data.kind === "found" ? c.data.payload_sha256 : null,
        } };
      }));
      const commandFailure = commandResults.find(r => r.status === "rejected");
      if (commandFailure?.status === "rejected") throw commandFailure.reason;
      for (const result of commandResults) {
        requireStorage(result.status === "fulfilled", "incomplete command reads");
        checkpoints[result.value.lane] = result.value.checkpoint;
      }
      this.store.recovered(checkpoints);
      return { kind: "ready", reasons: [] };
    });
  }
  private async live(work: TownWork, call: TownCall): Promise<void> {
    requireStorage(this.authorized, "verified town recovery required");
    const reader = await this.adapters[work.lane].client.finalized(),
      town = await reader.getTown();
    const reaction = this.store.reactions.work(work.id);
    if (
      reaction &&
      reaction.role !== "cleanup" &&
      BigInt(town.block_timestamp_ns) >= BigInt(reaction.deadlineNs)
    )
      throw new StaleTownStep("reaction deadline expired");
    const shelf = shelfMaintenance(work) && call.method === "set_listing";
    if (!reaction && !shelf && town.data.epoch !== work.tick)
      throw new StaleTownStep("town opportunity epoch expired");
    if ("command" in call.args) {
      if (
        BigInt(call.args.command.valid_until_ns) <=
        BigInt(town.block_timestamp_ns)
      )
        throw new StaleTownStep("town command expired");
    }
    // Independent checks share this exact finalized block and the bounded RPC
    // read pool. Finish every check before signing or reporting a failure.
    const checks = await Promise.allSettled([
      "command" in call.args
        ? reader.getCommand(work.lane === "operator" ? this.store.identity.operatorId : `merchant:${work.lane}`,
            call.args.command.sequence).then(c => {
            requireStorage("command" in call.args && c.data.kind === "not_applied" &&
              c.data.next_sequence === call.args.command.sequence, "town command high-water changed");
          })
        : Promise.resolve(),
      validateTownOfferCall(reader, call),
      this.refresh(work.decision, work.lane, reader, "command" in call.args ? call.args.command : null),
    ] as const);
    const failure = checks.find(check => check.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const refreshed = checks[2];
    requireStorage(refreshed.status === "fulfilled", "incomplete town policy checks");
    const current = refreshed.value;
    if (
      !current ||
      canonicalLivingTownJson(current) !== canonicalLivingTownJson(call)
    )
      throw new StaleTownStep("town policy/quote changed");
  }
  async execute(work: TownWork): Promise<TownSubmission> {
    return this.exclusive(async () => {
      this.store.gate();
      requireStorage(this.authorized, "town continuity required");
      if (this.store.get(work.id)) return { kind: "no_op", actionId: work.id };
      const reader = await this.adapters[work.lane].client.finalized(),
        town = await reader.getTown();
      const reaction = this.store.reactions.work(work.id);
      const shelf = shelfMaintenance(work);
      if (!reaction && !shelf && town.data.epoch !== work.tick) {
        this.store.ticks.reconcile({
          town,
          block: reader.block,
          codeHash: reader.identity.codeHash,
        });
        return { kind: "expired", actionId: work.id };
      }
      const command = {
        sequence: (
          BigInt(String(this.store.checkpoint(work.lane)["last_action_id"])) +
          1n
        ).toString(),
        config_version: town.deployment.config_version,
        valid_until_ns: (reaction
          ? reaction.role === "cleanup" ||
            BigInt(reaction.deadlineNs) >
              BigInt(town.block_timestamp_ns) + 60000000000n
            ? BigInt(town.block_timestamp_ns) + 60000000000n
            : BigInt(reaction.deadlineNs)
          : shelf ? BigInt(town.block_timestamp_ns) + 120000000000n
          : BigInt(town.data.genesis_time_ns) +
            (BigInt(work.tick) + 1n) * 60000000000n
        ).toString(),
      };
      const proposed = await this.refresh(
          work.decision,
          work.lane,
          reader,
          command,
        ),
        call = proposed && (!shelf || proposed.method === "set_listing")
          ? townCall(proposed.method, proposed.args, work.lane)
          : null;
      const digest = call
        ? "command" in call.args
          ? await livingTownCommandDigest(
              this.store.identity.deployment,
              this.adapters[work.lane].signerId,
              call as LivingTownCall,
            )
          : sha256(canonicalLivingTownJson(call))
        : null;
      this.store.prepareTown({ ...work, call, digest }, Date.now() + (shelf ? 120000 : 60000));
      if (!call) return { kind: "no_op", actionId: work.id };
      return this.signAndSubmit(work, call);
    });
  }
  private async signAndSubmit(
    work: TownWork,
    call: TownCall,
  ): Promise<TownSubmission> {
    try {
      await this.live(work, call);
      const p = await this.adapters[work.lane].prepare(call, () =>
        this.live(work, call),
      );
      this.store.saveTownSigned(work.id, p);
      return await this.submit(work, p);
    } catch (e) {
      if (!(e instanceof StaleTownStep)) throw e;
      this.store.abandon(work.id);
      return { kind: "expired", actionId: work.id };
    }
  }
  private async submit(
    work: TownWork,
    p: PreparedTownCall,
  ): Promise<TownSubmission> {
    await this.live(work, p.call);
    this.store.markBroadcast(work.id, "unknown");
    this.store.invalidate();
    const result = await this.adapters[work.lane].submit(p);
    this.store.markBroadcast(work.id, result.kind);
    this.authorized = false;
    return { ...result, actionId: work.id };
  }
  async resume(actionId: string): Promise<TownSubmission> {
    return this.exclusive(async () => {
      requireStorage(
        this.authorized && this.store.unresolved().length === 1,
        "verified original town recovery required",
      );
      const row = this.store.get(actionId);
      requireStorage(
        row && ["prepared", "signed"].includes(String(row["status"])),
        "only unbroadcast town work may resume",
      );
      const work: TownWork = {
        id: actionId,
        tick: String(row["tick"]),
        arrival: String(row["arrival"]),
        lane: String(row["lane"]) as TownLane,
        decision: JSON.parse(String(row["decision_json"])),
      };
      const call = townCall(
        String(row["method"]),
        JSON.parse(String(row["args_json"])),
        work.lane,
      );
      const digest =
        "command" in call.args
          ? await livingTownCommandDigest(
              this.store.identity.deployment,
              this.adapters[work.lane].signerId,
              call as LivingTownCall,
            )
          : sha256(canonicalLivingTownJson(call));
      requireStorage(
        digest === row["args_digest"],
        "town recovery digest mismatch",
      );
      if (row["status"] === "prepared") return this.signAndSubmit(work, call);
      try {
        return await this.submit(
          work,
          readTownPrepared(
            String(row["signed_json"]),
            this.store.identity,
            work.lane,
          ),
        );
      } catch (e) {
        if (!(e instanceof StaleTownStep)) throw e;
        this.store.abandon(actionId);
        return { kind: "expired", actionId };
      }
    });
  }
}
