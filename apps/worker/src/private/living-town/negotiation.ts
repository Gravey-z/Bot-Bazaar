import {
  canonicalLivingTownJson,
  createLivingTownCall,
  livingTownOffer,
  livingTownSnapshot,
  livingTownTown,
  parseLivingTownIdentity,
} from "@bot-bazaar/chain";
import type {
  LivingTownMerchantPolicy,
  MerchantPolicyInput,
} from "./merchant-policy.js";
import type { TownProposal, ProposalMerchant } from "./proposals.js";
import { parseTownProposal } from "./proposals.js";
import { requireStorage } from "../storage/validation.js";

const merchants = ["rex", "luna", "bolt"] as const;
/** Service facts, never model-supplied fields. Signing repeats the on-chain key check. */
export function negotiationAvailable(input: MerchantPolicyInput): boolean {
  const town = livingTownSnapshot(livingTownTown)(input.town);
  return (
    town.deployment.state_schema === "2" &&
    input.negotiatedTrading === true &&
    input.negotiationAuthority?.journal === "ready" &&
    merchants.every(
      (m) =>
        input.negotiationAuthority?.signerScopes[m] ===
        "town_negotiating_merchant",
    ) &&
    !!input.stockSharingReaction &&
    /^[a-f0-9]{64}$/.test(input.stockSharingReaction.id) &&
    input.pendingOffers !== undefined
  );
}
export interface SellerTradeApproval {
  proposal: TownProposal;
  offer: ReturnType<typeof livingTownOffer>;
  rootId: string;
}
export interface SellerTradeStep {
  call: ReturnType<typeof createLivingTownCall>;
  phase: "seller_listing_release" | "seller_acceptance";
  approval: SellerTradeApproval;
}

export function assertNegotiationActor(
  input: MerchantPolicyInput,
  merchant: ProposalMerchant,
  identityValue: unknown,
): ReturnType<typeof parseLivingTownIdentity> {
  const identity = parseLivingTownIdentity(identityValue),
    town = livingTownSnapshot(livingTownTown)(input.town);
  requireStorage(
    negotiationAvailable(input) && input.fresh && input.historyComplete,
    "negotiation authority or fresh facts unavailable",
  );
  requireStorage(
    canonicalLivingTownJson(identity.deployment) ===
      canonicalLivingTownJson(town.deployment),
    "negotiation deployment mismatch",
  );
  const controllers = merchants.map((m) => identity.controllers[m]);
  requireStorage(
    new Set(controllers).size === 3 &&
      controllers.every(
        (id) =>
          ![
            identity.ownerId,
            identity.operatorId,
            identity.deployment.contract_id,
          ].includes(id),
      ) &&
      controllers.includes(identity.controllers[merchant]),
    "independent negotiation controllers required",
  );
  return identity;
}

/** Reused after explicit seller preparation. It never changes the stored offer terms,
 * selects a different offer, or authorizes a second model decision. The durable owner
 * must retain the original model proposal/inference reference with this approval. */
export function compileSellerTradeApproval(
  input: MerchantPolicyInput,
  value: SellerTradeApproval,
  policy: LivingTownMerchantPolicy,
  identityValue: unknown,
  command: unknown,
): SellerTradeStep {
  const proposal = parseTownProposal(value.proposal),
    original = livingTownOffer(value.offer),
    merchant = proposal.merchant_id;
  assertNegotiationActor(input, merchant, identityValue);
  const town = livingTownSnapshot(livingTownTown)(input.town);
  requireStorage(
    proposal.action.type === "accept_trade" &&
      proposal.action.offer_id === original.offer_id &&
      proposal.action.expected_offer_revision === original.revision &&
      original.seller === merchant &&
      value.rootId === input.stockSharingReaction!.id,
    "seller approval binding mismatch",
  );
  const offers = (input.pendingOffers ?? []).map(livingTownOffer),
    offer = offers.find((o) => o.offer_id === original.offer_id);
  requireStorage(
    offer &&
      canonicalLivingTownJson(offer) === canonicalLivingTownJson(original),
    "seller approval terms changed or offer closed",
  );
  const assessment = policy
    .evaluate(input)
    .stockSharing?.pendingAssessments.find((a) => a.offerId === offer.offer_id);
  requireStorage(
    assessment?.eligible &&
      !town.data.paused &&
      BigInt(town.block_timestamp_ns) < BigInt(offer.expires_at_ns),
    "seller offer expired, invalidated or unsafe",
  );
  const release = assessment.listingRelease;
  let call: ReturnType<typeof createLivingTownCall>;
  if (release) {
    const listing = input.merchants
      .flatMap((r) => r.listings)
      .find((v) => {
        const l = v as {
          listing_id?: string;
          owner?: { kind?: string; merchant_id?: string };
        };
        return (
          l.listing_id === release.listingId &&
          l.owner?.kind === "merchant" &&
          l.owner.merchant_id === merchant
        );
      }) as { shop_id: string; item_id: string; unit_price: string };
    requireStorage(
      listing && listing.item_id === offer.item_id,
      "seller release listing missing",
    );
    call = createLivingTownCall("set_listing", {
      shop_id: listing.shop_id,
      item_id: offer.item_id,
      quantity: release.maxRemainingQuantity,
      unit_price: listing.unit_price,
      expected_listing_revision: release.expectedRevision,
      command,
    });
  } else {
    const buyer = town.data.npc_ledgers.find(
        (l) =>
          l.actor.kind === "merchant" && l.actor.merchant_id === offer.buyer,
      )!,
      seller = town.data.npc_ledgers.find(
        (l) => l.actor.kind === "merchant" && l.actor.merchant_id === merchant,
      )!;
    call = createLivingTownCall("accept_trade", {
      merchant_id: merchant,
      offer_id: offer.offer_id,
      expected_offer_revision: offer.revision,
      expected_buyer_ledger_revision: buyer.revision,
      expected_seller_ledger_revision: seller.revision,
      command,
    });
  }
  requireStorage(
    call.args.command.config_version === town.deployment.config_version &&
      BigInt(call.args.command.valid_until_ns) >
        BigInt(town.block_timestamp_ns) &&
      BigInt(call.args.command.valid_until_ns) <=
        BigInt(town.block_timestamp_ns) + 600000000000n,
    "seller command outside lifetime",
  );
  return {
    call,
    phase: release ? "seller_listing_release" : "seller_acceptance",
    approval: structuredClone(value),
  };
}
