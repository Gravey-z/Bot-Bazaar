import {
  MarketClient,
  createMarketCall,
  verifyFinalReceipt,
} from "@bot-bazaar/chain";
import type {
  CallInput,
  FinalizedMarketReader,
  Offer,
} from "@bot-bazaar/chain";
import type { MerchantChainAdapter, MerchantMethod } from "../chain-adapter.js";
import type { Intent, WorkerStore } from "../storage/database.js";
import {
  id,
  identityJson,
  json,
  requireStorage,
  sha256,
  StorageError,
} from "../storage/validation.js";
import { readPrepared } from "./proof.js";
import type {
  ContinuityAttestation,
  ContinuityVerifier,
  RecoveryReport,
} from "./types.js";

const names = ["rex", "luna", "bolt"] as const;
export class CrashSafeProcessor {
  private busy = false;
  private authorizedSession: string | undefined;
  private recoveredSession = false;
  last: RecoveryReport = {
    kind: "blocked",
    reasons: ["recovery_required"],
    unresolved: 0,
  };
  constructor(
    private readonly store: WorkerStore,
    private readonly client: MarketClient,
    private readonly adapter?: MerchantChainAdapter,
    private readonly verifyContinuity?: ContinuityVerifier,
  ) {}
  private context() {
    return {
      sessionId: String(this.store.checkpoint()["feed_generation"]),
      identityHash: sha256(identityJson(this.store.identity)),
    };
  }
  private attested(
    value: ContinuityAttestation | undefined,
  ): value is ContinuityAttestation {
    const context = this.context();
    return (
      !!value &&
      value.sessionId === context.sessionId &&
      value.identityHash === context.identityHash &&
      value.journal === "current" &&
      value.fencing === "verified" &&
      value.providerHistory === "accounted" &&
      /^[a-zA-Z0-9:_.-]{1,128}$/.test(value.evidenceRef)
    );
  }
  private gate(): void {
    requireStorage(
      this.store.available &&
        this.authorizedSession === this.context().sessionId &&
        this.store.checkpoint()["recovery_required"] === 0,
      "verified recovery required before fresh signing",
    );
  }
  async execute(
    input: Intent,
  ): Promise<{ kind: "submitted" | "unknown"; transactionHash: string }> {
    requireStorage(!this.busy, "transaction processor busy");
    this.gate();
    requireStorage(this.adapter, "runtime signer is not configured");
    input = { ...input, args: createMarketCall(input.method, input.args).args };
    requireStorage(
      !this.store.getIntent(input.id),
      "existing intent must be reconciled; never sign a replacement",
    );
    this.busy = true;
    try {
      await this.store.prepareIntent(input);
      this.gate();
      const prepared = await this.adapter.prepare(
        input.merchantId,
        input.method,
        input.args as CallInput<MerchantMethod>,
      );
      this.gate();
      this.store.saveSigned(input.id, prepared);
      return await this.submitSigned(input.id);
    } catch {
      this.authorizedSession = undefined;
      try {
        this.store.requireRecovery();
      } catch {
        /* Keep signing stopped after failed persistence. */
      }
      throw new StorageError(
        "transaction preparation stopped; reconcile durable journal",
      );
    } finally {
      this.busy = false;
    }
  }
  async submitPersisted(
    intentId: string,
  ): Promise<{ kind: "submitted" | "unknown"; transactionHash: string }> {
    requireStorage(!this.busy, "transaction processor busy");
    this.busy = true;
    try {
      return await this.submitSigned(intentId);
    } finally {
      this.busy = false;
    }
  }
  private async submitSigned(intentId: string) {
    id(intentId);
    requireStorage(
      this.adapter &&
        this.store.available &&
        this.authorizedSession === this.context().sessionId,
      "verified journal continuity required before submission",
    );
    const row = this.store.getIntent(intentId),
      attempt = this.store.attempt(intentId);
    requireStorage(
      row?.["status"] === "signed" && attempt,
      "only a durably signed, unsubmitted intent may be submitted",
    );
    const prepared = readPrepared(
      String(attempt["signed_json"]),
      this.store.identity,
    );
    const job = this.store.getJob(String(row["job_id"]));
    requireStorage(
      prepared.method === "cancel_trade" ||
        prepared.method === "expire_offers" ||
        (job?.["status"] === "active" && Number(job["deadline"]) > Date.now()),
      "economic decision window expired before first submission",
    );
    requireStorage(
      prepared.transactionHash === attempt["tx_hash"] &&
        json(prepared.args) === row["args_json"] &&
        prepared.method === row["method"] &&
        prepared.merchantId === row["merchant_id"],
      "journal identity mismatch",
    );
    const { market } = await this.client.verifyDeployment(this.store.identity);
    requireStorage(
      !market.data.paused ||
        prepared.method === "cancel_trade" ||
        prepared.method === "expire_offers",
      "market paused before broadcast",
    );
    const actor = market.data.merchants.find(
      (value) => value.merchant_id === prepared.merchantId,
    )!;
    requireStorage(
      row["action_id"] === null ||
        BigInt(String(row["action_id"])) === BigInt(actor.last_action_id) + 1n,
      "action changed before broadcast; reconcile",
    );
    // This durable marker precedes every network submission. A crash after it is
    // indistinguishable from a submitted call; recovery queries, never replaces.
    this.store.markBroadcast(intentId, "unknown");
    try {
      const result = await this.adapter.submit(prepared);
      this.store.markBroadcast(intentId, result.kind);
      this.authorizedSession = undefined;
      this.store.requireRecovery();
      return result;
    } catch {
      this.authorizedSession = undefined;
      // If a durable write failed after sending, the pre-send unknown marker remains.
      try {
        this.store.requireRecovery();
      } catch {
        /* Storage failures cannot authorize more work. */
      }
      return {
        kind: "unknown" as const,
        transactionHash: prepared.transactionHash,
      };
    }
  }
  private async offers(
    reader: FinalizedMarketReader,
    revision: string,
    signal: AbortSignal,
  ): Promise<Offer[]> {
    const offers = new Map<string, Offer>();
    for (const name of names) {
      let after: string | null = null;
      for (let page = 0; page < 3; page++) {
        signal.throwIfAborted();
        const result = await reader.getOffersForMerchant(name, "all", {
          after_id: after,
          limit: "50",
          expected_revision: revision,
        });
        for (const offer of result.data.items) {
          const old = offers.get(offer.offer_id);
          requireStorage(
            !old || json(old) === json(offer),
            "inconsistent recovery offer",
          );
          offers.set(offer.offer_id, offer);
        }
        requireStorage(offers.size <= 112, "recovery offer bound exceeded");
        if (!result.data.has_more) break;
        requireStorage(
          page < 2 && result.data.next_after_id !== after,
          "incomplete recovery offer pages",
        );
        after = result.data.next_after_id;
      }
    }
    return [...offers.values()];
  }
  async recover(
    signal = new AbortController().signal,
  ): Promise<RecoveryReport> {
    requireStorage(!this.busy, "transaction processor busy");
    this.busy = true;
    this.authorizedSession = undefined;
    const reasons = new Set<string>();
    try {
      this.store.requireRecovery();
      const authority = await this.verifyContinuity?.(this.context());
      const verified = this.attested(authority);
      if (!verified) reasons.add("journal_continuity_or_fencing_unverified");
      const client = new MarketClient(
        this.client.contractId,
        async (method, params) => {
          signal.throwIfAborted();
          return this.client.transport(method, params);
        },
      );
      const { reader, market } = await client.verifyDeployment(
        this.store.identity,
      );
      for (const intent of this.store.unresolvedIntents()) {
        signal.throwIfAborted();
        const intentId = String(intent["id"]),
          actor = market.data.merchants.find(
            (row) => row.merchant_id === intent["merchant_id"],
          )!;
        if (intent["status"] === "prepared") {
          if (
            verified &&
            (intent["action_id"] === null ||
              BigInt(actor.last_action_id) + 1n ===
                BigInt(String(intent["action_id"])))
          )
            this.store.abandonUnsigned(intentId);
          else
            reasons.add("unsigned_intent_requires_continuity_or_action_review");
          continue;
        }
        const prepared = readPrepared(
          String(intent["signed_json"]),
          this.store.identity,
        );
        requireStorage(
          prepared.transactionHash === intent["tx_hash"] &&
            json(prepared.args) === intent["args_json"] &&
            prepared.merchantId === intent["merchant_id"] &&
            prepared.method === intent["method"],
          "persisted recovery intent mismatch",
        );
        let outcome;
        try {
          outcome = await verifyFinalReceipt(
            await client.transport("tx", {
              tx_hash: prepared.transactionHash,
              sender_account_id: prepared.signerId,
              wait_until: "NONE",
            }),
            prepared,
          );
        } catch {
          outcome = {
            kind: "unknown" as const,
            transactionHash: prepared.transactionHash,
          };
        }
        if (outcome.kind === "succeeded" || outcome.kind === "failed") {
          this.store.finishAttempt(intentId, outcome);
          continue;
        }
        // A matching last-action proof commits the business action, not an invented
        // execution receipt for this hash. Cleanup has no such application ID.
        if (
          intent["action_id"] !== null &&
          actor.last_action_id === intent["action_id"]
        ) {
          requireStorage(
            actor.last_action?.method === intent["method"] &&
              actor.last_action.args_sha256 === intent["args_digest"],
            "unexpected digest for recovered action ID",
          );
          const action = actor.last_action;
          requireStorage(
            action.method !== "set_listing" ||
              action.listing_version ===
                (
                  BigInt(
                    String(
                      (prepared.args as { expected_version: string })
                        .expected_version,
                    ),
                  ) + 1n
                ).toString(),
            "listing checkpoint mismatch",
          );
          const expectedOffer = (prepared.args as { offer_id?: string })
            .offer_id;
          requireStorage(
            expectedOffer === undefined || expectedOffer === action.offer_id,
            "stored offer action mismatch",
          );
          let offer: Offer | undefined;
          if (action.offer_id !== null) {
            const lookup = await reader.getOffer(action.offer_id);
            if (lookup.data.kind === "found") offer = lookup.data.offer;
            if (offer && prepared.method === "propose_trade") {
              requireStorage(
                offer.proposal_action.merchant_id === prepared.merchantId &&
                  offer.proposal_action.action_id === intent["action_id"],
                "recovered proposal reference mismatch",
              );
              for (const key of [
                "proposer",
                "buyer",
                "seller",
                "resource",
                "quantity",
                "total_price",
                "expires_at_ns",
              ] as const)
                requireStorage(
                  offer[key] ===
                    (prepared.args as Record<string, unknown>)[key],
                  "recovered proposal terms mismatch",
                );
            }
            if (offer && prepared.method === "accept_trade")
              requireStorage(
                offer.status === "accepted" &&
                  offer.counterparty === prepared.merchantId &&
                  offer.settled_trade_id === action.trade_id,
                "recovered acceptance mismatch",
              );
            if (offer && prepared.method === "cancel_trade")
              requireStorage(
                offer.status === "cancelled" &&
                  offer.proposer === prepared.merchantId,
                "recovered cancellation mismatch",
              );
          }
          this.store.confirmActionCheckpoint(
            intentId,
            actor,
            reader.block,
            offer,
          );
        }
      }
      const unresolved = this.store.unresolvedIntents();
      if (this.store.unprovenOfferDependencies().length)
        reasons.add("offer_dependency_evidence_unavailable");
      if (unresolved.length) reasons.add("unresolved_transaction");
      const observedOffers = await this.offers(
        reader,
        market.market_revision,
        signal,
      );
      const knownOffers = this.store.offers();
      for (const offer of observedOffers)
        if (
          offer.status === "pending" ||
          (offer.status === "expired" &&
            !knownOffers.some(
              (row) =>
                row["offer_id"] === offer.offer_id && row["cleanup_ack"] === 1,
            ))
        ) {
          if (
            !knownOffers.some(
              (row) =>
                row["offer_id"] === offer.offer_id && row["job_id"] !== null,
            )
          )
            reasons.add("unexplained_offer");
        }
      if (
        this.store.scheduler
          .inputs()
          .some((row) => row["disposition"] === "quarantined")
      )
        reasons.add("quarantined_activity");
      for (const actor of market.data.merchants) {
        const old = this.store.merchantCheckpoint(actor.merchant_id);
        if (old["last_action_id"] === null) {
          const baseline = verified
            ? authority.baselines?.[actor.merchant_id]
            : undefined;
          if (
            !baseline ||
            baseline.actionId !== actor.last_action_id ||
            baseline.digest !== (actor.last_action?.args_sha256 ?? null)
          )
            reasons.add("merchant_baseline_unverified");
        } else if (
          old["last_action_id"] !== actor.last_action_id ||
          old["last_action_digest"] !== (actor.last_action?.args_sha256 ?? null)
        )
          reasons.add("unexpected_controller_action");
      }
      signal.throwIfAborted();
      if (
        verified &&
        [...reasons].every((reason) => reason === "unresolved_transaction")
      )
        this.authorizedSession = this.context().sessionId;
      if (reasons.size === 0) {
        this.store.completeRecovery(
          this.context().sessionId,
          market.data.merchants,
          !this.recoveredSession,
        );
        this.authorizedSession = this.context().sessionId;
        this.recoveredSession = true;
      }
      return (this.last = {
        kind: reasons.size ? "blocked" : "ready",
        reasons: [...reasons],
        unresolved: unresolved.length,
      });
    } catch {
      this.authorizedSession = undefined;
      return (this.last = {
        kind: "blocked",
        reasons: [...reasons, "verification_or_storage_unavailable"],
        unresolved: this.store.available
          ? this.store.unresolvedIntents().length
          : null,
      });
    } finally {
      this.busy = false;
    }
  }
}
