import type { TownObservation } from "./living-town-controller";
import type { TownActivity } from "@bot-bazaar/chain";
export type TownMerchant = "rex" | "luna" | "bolt";
export const merchantGoals: Record<TownMerchant, readonly string[]> = {
  rex: [
    "Grow shop value through profitable sales.",
    "Keep useful stock and enough gold to seize opportunities.",
  ],
  luna: [
    "Keep herbs available at fair prices.",
    "Help with real shortages while protecting essential reserves.",
  ],
  bolt: [
    "Keep the workshop supplied and produce useful iron tools.",
    "Balance material sales with the stock needed to finish work.",
  ],
};
const names = { rex: "Rex", luna: "Luna", bolt: "Bolt" };
const item = (s: string) =>
  s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export interface MerchantEconomyView {
  name: string;
  goals: readonly string[];
  gold: string | null;
  committedGold: string | null;
  stale: boolean;
  offersAvailable: boolean;
  offersStale: boolean;
  historyGap: boolean;
  activityUnavailable: boolean;
  activityGap: boolean;
  stock: {
    id: string;
    name: string;
    held: string;
    available: string;
    listed: string;
    outgoing: string;
    incoming: string;
    production: string;
  }[];
  offers: {
    id: string;
    direction: string;
    text: string;
    price: string;
    label: string;
    reason: string | null;
    delta: string | null;
    url: string | null;
    receipt: string | null;
  }[];
  decisions: {
    id: string;
    recordedAt: string;
    recordedLabel: string;
    label: string;
    reason: string;
    offerId: string | null;
    origin: string;
    url: string | null;
    receipt: string | null;
  }[];
  sources: {
    id: string;
    text: string;
    url: string | null;
    receipt: string | null;
  }[];
}
export function merchantProofUrl(hash: string | null): string | null {
  return hash && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)
    ? `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`
    : null;
}
export function merchantReceiptUrl(
  hash: string | null,
  receipt: string | null,
): string | null {
  const transaction = merchantProofUrl(hash);
  return transaction && merchantProofUrl(receipt)
    ? `${transaction}#${encodeURIComponent(receipt!)}`
    : null;
}
export function merchantEconomy(
  observation: TownObservation | null,
  events: readonly TownActivity[],
  merchant: TownMerchant,
  now = Date.now(),
  activityMode = "unavailable",
  activityGap = false,
): MerchantEconomyView {
  const ledger = observation?.town.npc_ledgers.find(
    (l) => l.actor.kind === "merchant" && l.actor.merchant_id === merchant,
  );
  const stale =
    !observation ||
    observation.stale ||
    now < observation.receivedAt ||
    now - observation.receivedAt > 30000;
  const transfers = events.filter(
    (e): e is Extract<TownActivity, { type: "merchant_economy" }> =>
      e.type === "merchant_economy" && e.data.merchant === merchant,
  );
  const agent = events.filter(
    (e): e is Extract<TownActivity, { type: "agent_action" }> =>
      e.type === "agent_action" && e.data.merchant === merchant,
  );
  const latest = new Map<string, (typeof agent)[number]>();
  // The live feed exposes newest entries first; collapse transitions chronologically.
  for (const e of [...agent].reverse()) {
    const old = latest.get(e.data.action_id);
    if (
      !old ||
      e.data.outcome === "confirmed" ||
      old.data.outcome !== "confirmed"
    )
      latest.set(e.data.action_id, e);
  }
  const decisions = [...latest.values()]
    .filter(
      (e) =>
        e.data.outcome !== "thinking" ||
        !agent.some(
          (other) =>
            other.data.tick_id === e.data.tick_id &&
            other.data.outcome !== "thinking",
        ),
    )
    .slice(-5)
    .reverse()
    .map((e) => {
      const d = e.data;
      const fallback = d.reason.startsWith("rules fallback:");
      const fallbackCode = fallback ? d.reason.slice("rules fallback:".length).trim() : "";
      const fallbackReasons: Record<string, string> = {
        reaction_window_expired: "This queued decision's time window expired. No new AI call was made.",
        reaction_window_or_work_limit: "Too little time or work allowance remained for this reaction. No new AI call was made.",
        reaction_admission_unavailable: "The worker could not authorize this reaction. The merchant waited.",
        reaction_provider_unavailable: "The AI request could not be completed for this reaction. The merchant waited.",
        reaction_decision_invalid: "The returned decision did not pass the reaction checks. The merchant waited.",
        reaction_admission_or_provider_unavailable: "This earlier reaction could not proceed. Its record does not distinguish an expired decision window from a provider or validation failure.",
        stale_context: "The town had changed before this decision could start.",
        stale_response: "The town changed while the AI was thinking, so this decision was not used.",
        request_timeout: "The AI did not reply within this attempt's time limit.",
        prompt_too_large: "The AI request was too large to send. The merchant waited; no AI call was made.",
        schema_invalid: "The AI replied, but its decision did not match the required format. The reply was rejected.",
        budget_admission_rejected: "The AI request did not pass its size or budget checks. No AI call was sent.",
        provider_or_admission_unavailable: "The AI decision could not be used. The merchant followed the town's fallback rules.",
        provider_not_configured: "The AI service is unavailable. The merchant followed the town's fallback rules.",
        provider_busy_or_total_budget_exhausted: "The AI service is busy or its shared budget is unavailable.",
      };
      const label =
        d.outcome === "thinking"
          ? activityMode === "unavailable" ||
            now - Number(BigInt(e.checkpoint.block_timestamp_ns) / 1000000n) >
              20000
            ? "Status unavailable"
            : "Thinking"
          : d.outcome === "unknown"
            ? "Outcome unknown"
            : d.outcome === "submitted" || d.outcome === "awaiting_confirmation"
              ? "Submitted · awaiting confirmation"
              : d.outcome === "confirmed"
                ? d.validation === "seller_listing_release"
                  ? "Listing prepared"
                  : d.proposal_type === "propose_trade"
                    ? "Proposal confirmed"
                    : d.proposal_type === "reject_trade"
                      ? "Declined"
                      : d.proposal_type === "accept_trade"
                        ? "Trade confirmed"
                        : "Confirmed"
                : d.outcome === "expired"
                  ? "Expired"
                  : d.outcome === "rejected"
                    ? "Action failed"
                    : d.outcome === "proposal"
                      ? "Proposed"
                      : d.validation.includes("unavailable") ||
                          d.validation.includes("fallback") ||
                          (e.source === "deterministic_rule" &&
                            d.reason.startsWith("rules fallback:"))
                        ? "AI decision skipped"
                        : "No action";
      return {
        id: e.event_id,
        recordedAt: new Date(Number(BigInt(e.checkpoint.block_timestamp_ns) / 1000000n)).toISOString(),
        recordedLabel: new Date(Number(BigInt(e.checkpoint.block_timestamp_ns) / 1000000n))
          .toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        label,
        reason: fallback ? fallbackReasons[fallbackCode] ?? "The AI decision could not be used. The merchant followed the town's fallback rules."
          : d.reason === "deterministic merchant policy"
            ? d.outcome === "expired"
              ? "The automatic stock update expired or its stock and price checks changed before it could complete."
              : "Automatic stock and listing maintenance."
            : fallbackReasons[d.reason] ?? d.reason,
        offerId: d.offer_id ?? null,
        origin:
          e.source === "model_proposal"
            ? "AI decision"
            : e.source === "confirmed"
              ? "Verified action"
              : "Town rules",
        url:
          e.source === "confirmed"
            ? merchantProofUrl(d.transaction_hash)
            : null,
        receipt:
          e.source === "confirmed"
            ? merchantReceiptUrl(d.transaction_hash, d.receipt_id)
            : null,
      };
    });
  const offers = (observation?.merchantOffers?.items ?? [])
    .filter((o) => o.buyer === merchant || o.seller === merchant)
    .slice()
    .sort((a, b) => (BigInt(a.offer_id) > BigInt(b.offer_id) ? -1 : 1))
    .slice(0, 12)
    .map((o) => {
      const proof =
        o.status === "accepted"
          ? transfers.find((e) => {
              const p = e.data.offer;
              return (
                e.data.kind === "accepted" &&
                p?.offer_id === o.offer_id &&
                p.buyer === o.buyer &&
                p.seller === o.seller &&
                p.item_id === o.item_id &&
                p.quantity === o.quantity &&
                p.unit_price === o.unit_price &&
                p.total_price === o.total_price &&
                p.trade_id === o.trade_id
              );
            })
          : undefined;
      const expired =
        o.expired ||
        (observation?.chainTimestampNs !== undefined &&
          BigInt(observation.chainTimestampNs) >= BigInt(o.expires_at_ns));
      const label =
        o.status === "pending"
          ? expired
            ? "Past deadline · cleanup pending"
            : "Proposed · awaiting seller"
          : o.status === "accepted"
            ? "Settled"
            : o.status === "rejected"
              ? "Declined"
              : o.status === "cancelled"
                ? "Cancelled"
                : "Expired";
      const decision = decisions.find((d) => d.offerId === o.offer_id);
      return {
        id: o.offer_id,
        direction:
          o.seller === merchant ? "Incoming request" : "Outgoing request",
        text: `${names[o.buyer]} buying ${o.quantity} ${item(o.item_id)} from ${names[o.seller]}`,
        price: `${o.unit_price}g each · ${o.total_price}g total`,
        label,
        reason: decision?.reason ?? null,
        delta: proof
          ? o.buyer === merchant
            ? `+${o.quantity} ${item(o.item_id)} · −${o.total_price} gold`
            : `−${o.quantity} ${item(o.item_id)} · +${o.total_price} gold`
          : null,
        url: proof ? merchantProofUrl(proof.data.transaction_hash) : null,
        receipt: proof
          ? merchantReceiptUrl(
              proof.data.transaction_hash,
              proof.data.receipt_id,
            )
          : null,
      };
    });
  return {
    name: names[merchant],
    goals: merchantGoals[merchant],
    gold: ledger?.gold.available ?? null,
    committedGold: ledger?.gold.trade_reserved ?? null,
    stale,
    offersAvailable: observation?.merchantOffers?.available === true,
    offersStale: stale || observation?.merchantOffers?.stale === true,
    historyGap: observation?.merchantOffers?.historyGap === true,
    stock: ledger
      ? (
          [
            "crystal",
            "wood",
            "herb",
            "iron",
            "health_potion",
            "iron_tool",
          ] as const
        )
          .filter(
            (id, n) =>
              n < 4 ||
              BigInt(ledger.inventory.held[id]) +
                BigInt(ledger.inventory.production_output_reserved[id]) >
                0n,
          )
          .map((id) => ({
            id,
            name: item(id),
            held: ledger.inventory.held[id],
            available: ledger.inventory.available[id],
            listed: ledger.inventory.listing_reserved[id],
            outgoing: ledger.inventory.trade_reserved[id],
            incoming: ledger.inventory.trade_inbound_reserved[id],
            production: ledger.inventory.production_output_reserved[id],
          }))
      : [],
    offers,
    decisions,
    activityUnavailable: activityMode === "unavailable",
    activityGap,
    sources: transfers
      .filter((e) => e.data.kind === "source")
      .slice(0, 4)
      .map((e) => ({
        id: e.event_id,
        text: `+${e.data.quantity} ${item(e.data.item_id)}`,
        url: merchantProofUrl(e.data.transaction_hash),
        receipt: merchantReceiptUrl(e.data.transaction_hash, e.data.receipt_id),
      })),
  };
}
