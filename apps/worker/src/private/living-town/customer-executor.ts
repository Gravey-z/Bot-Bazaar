import {
  canonicalLivingTownJson,
  livingTownCommandDigest,
  verifyLivingTownEffect,
} from "@bot-bazaar/chain";
import type { ContinuityVerifier, RecoveryReport } from "../recovery/types.js";
import { requireStorage, sha256 } from "../storage/validation.js";
import {
  LivingTownCustomerDemand,
  sameCustomerCheckpointState,
} from "./customers.js";
import type { CustomerDemandInput } from "./customers.js";
import {
  CustomerChainAdapter,
  customerCall,
  readCustomerPrepared,
} from "./customer-chain.js";
import type { CustomerCall, PreparedCustomerCall } from "./customer-chain.js";
import { LivingTownExecutionStore, townLanes } from "./execution-store.js";
import type { TownLane } from "./execution-store.js";

type Town = Awaited<
  ReturnType<
    Awaited<ReturnType<CustomerChainAdapter["client"]["finalized"]>>["getTown"]
  >
>;
class StaleCustomerQuote extends Error {}
function requireFresh(value: unknown, message: string): asserts value {
  if (!value) throw new StaleCustomerQuote(message);
}
export type CustomerExecutionResult = {
  kind:
    "duplicate" | "no_purchase" | "already_allocated" | "submitted" | "unknown";
  actionId: string;
  transactionHash?: string;
};

/** Bounded work invoked by the existing orchestrator; no timers or independent signing loop. */
export class DurableCustomerExecutor {
  private busy = false;
  private authorized = false;
  constructor(
    private readonly store: LivingTownExecutionStore,
    private readonly demand: LivingTownCustomerDemand,
    private readonly adapter: CustomerChainAdapter,
    private readonly continuity: ContinuityVerifier,
  ) {
    requireStorage(
      canonicalLivingTownJson(store.identity) ===
        canonicalLivingTownJson(adapter.identity),
      "customer executor identity mismatch",
    );
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    requireStorage(!this.busy, "shared customer processor busy");
    this.busy = true;
    try {
      return await run();
    } catch (error) {
      this.authorized = false;
      this.store.invalidate();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private gate(): void {
    requireStorage(this.authorized, "customer continuity/fencing required");
    this.store.gate();
  }
  async recover(
    options: { preservePrepared?: boolean } = {},
  ): Promise<RecoveryReport> {
    return this.exclusive(async () => {
      this.authorized = false;
      this.store.invalidate();
      const context = {
        sessionId: this.store.sessionId,
        identityHash: this.store.identityHash,
      };
      const proof = await this.continuity(context);
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
          unresolved: this.store.unresolved().length,
        };
      // Verified continuity allows submission of existing bytes, never a new signature while blocked.
      this.authorized = true;
      const reader = await this.adapter.client.finalized(),
        town = await reader.getTown();
      const reasons: string[] = [];
      for (const row of this.store.unresolved()) {
        const actionId = String(row["id"]);
        if (row["merchant_id"] !== "operator") {
          reasons.push("merchant_recovery_required");
          continue;
        }
        if (row["status"] === "prepared") {
          if (options.preservePrepared)
            reasons.push("prepared_customer_action");
          else this.store.abandon(actionId);
          continue;
        }
        const p = readCustomerPrepared(
          String(row["signed_json"]),
          this.store.identity,
        );
        requireStorage(
          p.transactionHash === row["tx_hash"] &&
            canonicalLivingTownJson(p.call.args) === row["args_json"] &&
            p.call.method === row["method"],
          "customer recovery journal mismatch",
        );
        if (row["status"] === "signed") {
          if (
            BigInt(p.call.args.command.valid_until_ns) <=
            BigInt(town.block_timestamp_ns)
          )
            this.store.abandon(actionId);
          else reasons.push("signed_unsubmitted_customer_action");
          continue;
        }
        let status;
        try {
          status = await this.adapter.client.receipt(p);
        } catch {
          status = {
            kind: "unknown" as const,
            transactionHash: p.transactionHash,
          };
        }
        if (status.kind === "succeeded") {
          requireStorage(
            status.transactionHash === p.transactionHash,
            "customer receipt hash mismatch",
          );
          await verifyLivingTownEffect(
            status.result,
            this.store.identity.deployment,
            this.store.identity.operatorId,
            p.call,
          );
          this.store.resolve(actionId, status, true);
        } else if (status.kind === "failed") {
          requireStorage(
            status.transactionHash === p.transactionHash &&
              status.code === "EXECUTION_FAILED",
            "invalid customer failure receipt",
          );
          this.store.resolve(actionId, status, false);
        } else {
          const command = await reader.getCommand(
            this.store.identity.operatorId,
            p.call.args.command.sequence,
          );
          if (command.data.kind === "found") {
            requireStorage(
              command.data.method === p.call.method &&
                command.data.payload_sha256 === row["args_digest"],
              "customer command checkpoint conflict",
            );
            await verifyLivingTownEffect(
              // get_command contains the original effect at a newer read checkpoint.
              { ...command, data: { ...command.data.effect, replayed: true } },
              this.store.identity.deployment,
              this.store.identity.operatorId,
              p.call,
            );
            this.store.resolve(
              actionId,
              { kind: "command_checkpoint", checkpoint: reader.block, command },
              true,
            );
          } else reasons.push("unknown_customer_receipt");
        }
      }
      // Refresh after receipt lookup: command finality may have advanced while recovering.
      const latest = await this.adapter.client.finalized();
      const checkpoints = {} as Record<
        TownLane,
        { sequence: string; digest: string | null }
      >;
      for (const lane of townLanes) {
        const old = this.store.checkpoint(lane)["last_action_id"],
          seq = old === null || old === "0" ? "1" : String(old);
        const command = await latest.getCommand(
          lane === "operator"
            ? this.store.identity.operatorId
            : `merchant:${lane}`,
          seq,
        );
        checkpoints[lane] = {
          sequence: command.data.high_water,
          digest:
            command.data.kind === "found" ? command.data.payload_sha256 : null,
        };
      }
      if (this.store.unresolved().length || reasons.length)
        return {
          kind: "blocked",
          reasons,
          unresolved: this.store.unresolved().length,
        };
      this.store.recovered(checkpoints);
      return { kind: "ready", reasons: [], unresolved: 0 };
    });
  }
  async executeCustomer(
    value: CustomerDemandInput,
  ): Promise<CustomerExecutionResult> {
    const input = structuredClone(value);
    return this.exclusive(async () => {
      this.gate();
      requireStorage(
        input.seed === this.store.seed,
        "persisted customer seed cannot change",
      );
      const reader = await this.adapter.client.finalized(),
        town = await reader.getTown();
      requireStorage(
        sameCustomerCheckpointState(input.town, town),
        "customer decision checkpoint changed",
      );
      const decision = this.demand.select(input),
        actionId = decision.customerId;
      if (this.store.get(actionId)) return { kind: "duplicate", actionId };
      const call =
        decision.kind === "purchase"
          ? customerCall("settle_customer_purchase", {
              ...decision.terms,
              command: this.command(town),
            })
          : null;
      return this.prepare(
        actionId,
        decision.tick,
        decision.arrivalIndex,
        decision,
        call,
        town,
      );
    });
  }
  async fundCurrentEpoch(): Promise<CustomerExecutionResult> {
    return this.exclusive(async () => {
      this.gate();
      const reader = await this.adapter.client.finalized(),
        town = await reader.getTown();
      const tick = town.data.epoch,
        actionId = sha256(
          canonicalLivingTownJson([
            "living-town-customer-fund-v1",
            this.store.identity,
            this.store.seed,
            tick,
          ]),
        );
      if (this.store.get(actionId)) return { kind: "duplicate", actionId };
      if (town.data.customer_pool.last_funded_epoch === tick)
        return { kind: "already_allocated", actionId };
      const call = customerCall("fund_customer_budget", {
        epoch: tick,
        command: this.command(town),
      });
      return this.prepare(
        actionId,
        tick,
        "fund",
        { kind: "fund_customer_budget", tick, checkpoint: reader.block },
        call,
        town,
      );
    });
  }
  private command(town: Town) {
    return {
      sequence: (
        BigInt(String(this.store.checkpoint("operator")["last_action_id"])) + 1n
      ).toString(),
      config_version: town.deployment.config_version,
      valid_until_ns: (
        BigInt(town.data.genesis_time_ns) +
        (BigInt(town.data.epoch) + 1n) * 60_000_000_000n
      ).toString(),
    };
  }
  private async prepare(
    actionId: string,
    tick: string,
    arrival: string,
    decision: unknown,
    call: CustomerCall | null,
    town: Town,
  ): Promise<CustomerExecutionResult> {
    const remaining =
      BigInt(this.command(town).valid_until_ns) -
      BigInt(town.block_timestamp_ns);
    requireStorage(
      remaining > 0n && remaining <= 60_000_000_000n,
      "customer epoch window exhausted",
    );
    const digest = call
      ? await livingTownCommandDigest(
          this.store.identity.deployment,
          this.store.identity.operatorId,
          call,
        )
      : null;
    this.gate();
    this.store.prepare(
      { id: actionId, tick, arrival, decision, call, digest },
      Date.now() + Math.max(1, Number(remaining / 1_000_000n)),
    );
    if (!call) return { kind: "no_purchase", actionId };
    const signed = await this.adapter.prepare(call, async () => {
      this.gate();
      await this.assertLive(actionId, call);
    });
    this.gate();
    this.store.saveSigned(actionId, signed);
    return this.submitSigned(actionId, signed);
  }
  private async assertLive(
    actionId: string,
    call: CustomerCall,
  ): Promise<void> {
    requireStorage(this.authorized, "customer continuity required");
    const reader = await this.adapter.client.finalized(),
      town = await reader.getTown();
    const args = call.args as Record<string, unknown>,
      epoch = String(args["epoch"]);
    requireFresh(
      !town.data.paused &&
        town.data.epoch === epoch &&
        BigInt(town.block_timestamp_ns) <
          BigInt(call.args.command.valid_until_ns),
      "customer epoch expired or paused",
    );
    const command = await reader.getCommand(
      this.store.identity.operatorId,
      call.args.command.sequence,
    );
    requireStorage(
      command.data.kind === "not_applied" &&
        command.data.next_sequence === call.args.command.sequence,
      "operator command changed; reconcile before signing/submission",
    );
    if (call.method === "fund_customer_budget")
      requireFresh(
        BigInt(town.data.customer_pool.last_funded_epoch) < BigInt(epoch),
        "customer funding already allocated",
      );
    else {
      const row = this.store.get(actionId)!,
        decision = JSON.parse(String(row["decision_json"])) as {
          shopId: string;
        };
      const page = await reader.getListings({
        shop_id: decision.shopId,
        item_id: null,
        active_only: false,
        after_id: null,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      requireStorage(!page.data.has_more, "incomplete customer shop listings");
      const listing = page.data.items.find(
        (l) => l.listing_id === args["listing_id"],
      );
      requireFresh(
        listing &&
          listing.owner.kind === "player" &&
          listing.active &&
          listing.revision === args["expected_listing_revision"] &&
          listing.unit_price === args["max_total_price"] &&
          (listing.item_id === "health_potion" ||
            listing.item_id === "iron_tool"),
        "customer listing quote changed",
      );
      const ledger = await reader.getShopInventory(listing.shop_id);
      const pool = town.data.customer_pool,
        price = BigInt(listing.unit_price);
      requireFresh(
        ledger.data.inventory.listing_reserved[listing.item_id] ===
          listing.remaining_quantity &&
          BigInt(pool.gold) >= price &&
          price <= (listing.item_id === "health_potion" ? 18n : 24n) &&
          BigInt(
            listing.item_id === "health_potion"
              ? pool.potion_units_bought
              : pool.tool_units_bought,
          ) < 2n &&
          BigInt(ledger.data.gold.held) +
            BigInt(ledger.data.gold.trade_inbound_reserved) +
            price <=
            1_000_000n,
        "customer budget, quota, reservation or seller capacity changed",
      );
    }
  }
  private async submitSigned(
    actionId: string,
    signed: PreparedCustomerCall,
  ): Promise<CustomerExecutionResult> {
    const row = this.store.get(actionId);
    requireStorage(
      row?.["status"] === "signed" && row["tx_hash"] === signed.transactionHash,
      "only persisted unsubmitted customer bytes may be sent",
    );
    await this.assertLive(actionId, signed.call);
    // Crash from this point is unknown. Persist this marker before touching the network.
    this.store.markBroadcast(actionId, "unknown");
    this.store.invalidate();
    const result = await this.adapter.submit(signed);
    this.store.markBroadcast(actionId, result.kind);
    this.authorized = false;
    return { ...result, actionId };
  }
  async resumeSigned(actionId: string): Promise<CustomerExecutionResult> {
    return this.exclusive(async () => {
      requireStorage(
        this.authorized,
        "verified recovery required before resuming customer bytes",
      );
      const row = this.store.get(actionId);
      requireStorage(
        row?.["status"] === "signed",
        "only unsubmitted customer work may resume",
      );
      return this.submitSigned(
        actionId,
        readCustomerPrepared(String(row["signed_json"]), this.store.identity),
      );
    });
  }
  /** Resume exactly one provably unbroadcast intent after verified continuity recovery. */
  async resumePending(
    actionId: string,
  ): Promise<CustomerExecutionResult | { kind: "skipped"; actionId: string }> {
    return this.exclusive(async () => {
      requireStorage(
        this.authorized,
        "verified recovery required before resuming customer work",
      );
      const row = this.store.get(actionId);
      requireStorage(
        row &&
          ["prepared", "signed"].includes(String(row["status"])) &&
          this.store.unresolved().length === 1,
        "only original unsent work may resume",
      );
      const call = customerCall(
        String(row["method"]),
        JSON.parse(String(row["args_json"])),
      );
      requireStorage(
        (await livingTownCommandDigest(
          this.store.identity.deployment,
          this.store.identity.operatorId,
          call,
        )) === row["args_digest"],
        "prepared recovery digest mismatch",
      );
      try {
        await this.assertLive(actionId, call);
        if (row["status"] === "signed")
          return await this.submitSigned(
            actionId,
            readCustomerPrepared(
              String(row["signed_json"]),
              this.store.identity,
            ),
          );
        const signed = await this.adapter.prepare(call, async () => {
          requireStorage(
            this.authorized,
            "customer recovery continuity required",
          );
          await this.assertLive(actionId, call);
        });
        this.store.saveSigned(actionId, signed, true);
        return await this.submitSigned(actionId, signed);
      } catch (error) {
        // A verified stale quote can discard only bytes that have never crossed the broadcast marker.
        // Transport errors, digest/command conflicts and unknown sends retain the original work.
        if (!(error instanceof StaleCustomerQuote)) throw error;
        this.store.abandon(actionId);
        return { kind: "skipped", actionId };
      }
    });
  }
}
