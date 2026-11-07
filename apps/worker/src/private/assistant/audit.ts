import {
  assistantAuditEntries,
  assistantProposal,
  canonicalLivingTownJson,
  createLivingTownCall,
} from "@bot-bazaar/chain";
import type { AssistantAuditEntry, LivingTownClient } from "@bot-bazaar/chain";
import type { LivingTownExecutionStore } from "../living-town/execution-store.js";
import { requireStorage, sha256 } from "../storage/validation.js";
import type { AssistantStore } from "./store.js";
import type { AssistantProposal } from "./proposals.js";
function proposalTerms(p: Pick<AssistantProposal, "action">): string {
  const a = p.action;
  return a.type === "suggest_price"
    ? `${a.item_id}, listing ${a.listing_id}: ${a.current_unit_price} -> ${a.suggested_unit_price} gold/unit; listing revision ${a.expected_listing_revision}`
    : `${a.quantity} ${a.item_id} from shop ${a.seller_shop_id}, listing ${a.listing_id}: ${a.unit_price} gold/unit, maximum ${a.total_price}; listing revision ${a.expected_listing_revision}`;
}

export function manualAssistantAudit(
  store: AssistantStore,
  account: string,
  shop: string,
): AssistantAuditEntry[] {
  return assistantAuditEntries(
    store.auditRecords(account, shop).flatMap<unknown>((r) => {
      const base = {
        shop_id: shop,
        owner_account_id: account,
        source: "manual",
        validation: r.status === "proposed" ? "validated" : r.status,
        created_at_ms: String(r.started),
        updated_at_ms: String(r.updated),
        reviewed_at_ms: null,
        accepted_at_ms: null,
        transaction_hash: null,
        receipt_id: null,
      };
      if (!r.proposals.length)
        return [
          {
            ...base,
            id: r.id,
            action: "generation",
            terms: "No actionable proposal",
            reason: r.code,
            acceptance: "none",
            policy_revision: null,
            outcome:
              r.status === "rejected" || r.status === "expired"
                ? r.status
                : "not_submitted",
          },
        ];
      return r.proposals.map((p) => {
        const d = store.auditDecision(account, shop, p.proposal_id);
        const outcome = d?.["outcome_json"]
          ? (JSON.parse(String(d["outcome_json"])) as {
              status: string;
              transaction_hash: string;
              receipt_id: string | null;
            })
          : null;
        return {
          ...base,
          id: p.proposal_id,
          action: p.action.type,
          terms: proposalTerms(p),
          reason: p.reason,
          policy_revision: p.expected_policy_revision,
          acceptance: d?.status ?? "none",
          outcome:
            outcome?.status ??
            (d?.status === "accepted" ? "unknown" : "not_submitted"),
          updated_at_ms: String(
            Math.max(Number(d?.["updated_at"] ?? 0), r.updated),
          ),
          reviewed_at_ms: d?.["reviewed_at"] ? String(d["reviewed_at"]) : null,
          accepted_at_ms: d?.["accepted_at"] ? String(d["accepted_at"]) : null,
          transaction_hash: outcome?.transaction_hash ?? null,
          receipt_id: outcome?.receipt_id ?? null,
        };
      });
    }),
  );
}

/** Private composition only. Identity mismatch must fail before any journal read. */
export class AssistantAudit {
  get automaticAvailable(): boolean {
    return this.executions !== undefined;
  }
  constructor(
    private readonly store: AssistantStore,
    private readonly client: LivingTownClient,
    private readonly executions?: LivingTownExecutionStore,
  ) {
    requireStorage(
      store.identity === canonicalLivingTownJson(client.identity) &&
        (!executions ||
          canonicalLivingTownJson(executions.identity) === store.identity),
      "assistant audit deployment mismatch",
    );
  }
  automatic(account: string, shop: string): AssistantAuditEntry[] {
    this.store.settings(account, shop);
    return assistantAuditEntries(
      (this.executions?.assistantAudit(shop) ?? []).map((row) => {
        const decision = JSON.parse(String(row["decision_json"])) as {
          kind: string;
          shop?: string;
          proposal?: unknown;
        };
        const p =
          decision.kind === "assistant"
            ? assistantProposal(decision.proposal)
            : null;
        requireStorage(
          !p || (p.shop_id === shop && p.owner_account_id === account),
          "assistant audit scope mismatch",
        );
        const e = row["evidence_json"]
          ? (JSON.parse(String(row["evidence_json"])) as {
              kind: string;
              transactionHash?: string;
              executionReceiptId?: string;
            })
          : null;
        const status = String(row["status"] ?? row["job_status"]);
        const terminal = status === "confirmed" || status === "failed";
        const receipt =
          terminal &&
          ["succeeded", "failed"].includes(e?.kind ?? "") &&
          e?.transactionHash === row["tx_hash"]
            ? (e?.executionReceiptId ?? null)
            : null;
        return {
          id: String(row["id"]),
          shop_id: shop,
          owner_account_id: account,
          source: "automatic",
          action: p?.action.type ?? "no_op",
          terms: p ? proposalTerms(p) : "No actionable proposal",
          reason: p?.reason ?? "assistant_unavailable_or_invalid",
          validation:
            !p ||
            status === "failed" ||
            (status === "completed" && !row["method"])
              ? "rejected"
              : status === "expired" || status === "abandoned"
                ? "expired"
                : "validated",
          acceptance: p && row["method"] ? "onchain_policy" : "none",
          outcome:
            status === "failed" || !p
              ? "rejected"
              : status === "completed"
                ? "not_submitted"
                : status === "abandoned"
                  ? "expired"
                  : status === "active" || status === "queued"
                    ? "prepared"
                    : status,
          policy_revision: p?.expected_policy_revision ?? null,
          created_at_ms: String(row["created_at"]),
          updated_at_ms: String(row["updated_at"]),
          reviewed_at_ms: null,
          accepted_at_ms: null,
          transaction_hash: row["tx_hash"] ?? null,
          receipt_id: receipt,
        };
      }),
    );
  }
  async outcome(
    account: string,
    shop: string,
    proposal: string,
    attempt: string,
    hash: string,
    reference: string,
  ): Promise<void> {
    const d = this.store.auditDecision(account, shop, proposal);
    requireStorage(
      d?.status === "accepted" && d.attempt_id === attempt && d["call_json"],
      "accepted assistant attempt required",
    );
    const raw = JSON.parse(String(d["call_json"])) as {
      method: "set_listing" | "buy_from_merchant";
      args: unknown;
    };
    const call = createLivingTownCall(raw.method, raw.args);
    requireStorage(
      sha256(canonicalLivingTownJson(call)) === d.call_hash,
      "assistant audit call mismatch",
    );
    // The browser supplies a lookup hint, never a trusted success/status/receipt URL.
    const status = await this.client.receipt({
      transactionHash: hash,
      signerId: account,
      deployment: this.client.identity.deployment,
      call,
      referenceBlockHeight: reference,
    });
    this.store.saveOutcome(account, shop, proposal, attempt, {
      status:
        status.kind === "succeeded"
          ? "confirmed"
          : status.kind === "failed"
            ? "rejected"
            : status.kind === "pending"
              ? "submitted"
              : "unknown",
      transaction_hash: status.transactionHash,
      receipt_id:
        status.kind === "succeeded" || status.kind === "failed"
          ? status.executionReceiptId
          : null,
    });
  }
}
