import {
  assistantProposal,
  createLivingTownCall,
  livingTownAssistantPolicy,
  canonicalLivingTownJson,
  livingTownCommand,
} from "@bot-bazaar/chain";
import type {
  FinalizedLivingTownReader,
  LivingTownCall,
  LivingTownClient,
} from "@bot-bazaar/chain";
import type { AssistantPipeline } from "./pipeline.js";
import { requireStorage } from "../storage/validation.js";

export interface AutomaticAssistant {
  readonly shopIds: readonly string[];
  propose(
    shop: string,
    reader: FinalizedLivingTownReader,
  ): Promise<unknown | null>;
}
/** Deterministic admission only. Never inference, clipping, purchase, quantity or recipient edits. */
export async function resolveAssistantReprice(
  value: unknown,
  reader: FinalizedLivingTownReader,
  command: unknown,
  expectedShop: string,
): Promise<LivingTownCall | null> {
  try {
    const p = assistantProposal(value),
      a = p.action;
    if (a.type !== "suggest_price" || p.shop_id !== expectedShop) return null;
    const [town, shop, permission] = await Promise.all([
      reader.getTown(),
      reader.getShop(p.shop_id),
      reader.getAssistantPolicy(p.shop_id),
    ]);
    const policy = livingTownAssistantPolicy(permission.data);
    const ledger = await reader.getShopInventory(p.shop_id);
    if (
      town.market_revision !== p.snapshot.market_revision ||
      town.event_sequence !== p.snapshot.event_sequence ||
      ledger.data.revision !== p.expected_ledger_revision
    )
      return null;
    if (
      town.data.paused ||
      shop.data?.owner.kind !== "player" ||
      shop.data.owner.account_id !== p.owner_account_id ||
      shop.data.revision !== p.expected_shop_revision ||
      shop.data.policy_revision !== p.expected_policy_revision ||
      policy.revision !== p.expected_policy_revision ||
      policy.mode !== "auto_reprice" ||
      policy.operator_account_id !== reader.identity.operatorId ||
      policy.expires_at_ns === null ||
      BigInt(policy.expires_at_ns) <= BigInt(reader.block.timestampNs) ||
      BigInt(p.expires_at_ns) <= BigInt(reader.block.timestampNs) ||
      !policy.allowed_items.includes(
        a.item_id as "health_potion" | "iron_tool",
      ) ||
      BigInt(a.suggested_unit_price) < BigInt(policy.min_price) ||
      BigInt(a.suggested_unit_price) > BigInt(policy.max_price) ||
      canonicalLivingTownJson(p.snapshot.deployment) !==
        canonicalLivingTownJson(reader.identity.deployment)
    )
      return null;
    const listings = await reader.getListings({
      shop_id: p.shop_id,
      item_id: null,
      active_only: true,
      after_id: null,
      limit: "50",
      expected_market_revision: town.market_revision,
    });
    const listing = listings.data.items.find(
      (l) => l.listing_id === a.listing_id,
    );
    if (
      listings.data.has_more ||
      !listing?.active ||
      listing.shop_id !== p.shop_id ||
      listing.owner.kind !== "player" ||
      listing.owner.account_id !== p.owner_account_id ||
      listing.item_id !== a.item_id ||
      listing.revision !== a.expected_listing_revision ||
      listing.unit_price !== a.current_unit_price ||
      listing.unit_price === a.suggested_unit_price
    )
      return null;
    // Proposal is local provenance; the command expiry is independently bounded by both permissions.
    const c = livingTownCommand(command),
      expiry = [c.valid_until_ns, policy.expires_at_ns, p.expires_at_ns]
        .map(BigInt)
        .reduce((a, b) => (a < b ? a : b));
    if (expiry <= BigInt(reader.block.timestampNs)) return null;
    const call = createLivingTownCall("assistant_reprice", {
      listing_id: a.listing_id,
      expected_listing_revision: a.expected_listing_revision,
      expected_policy_revision: policy.revision,
      unit_price: a.suggested_unit_price,
      command: { ...c, valid_until_ns: expiry.toString() },
    });
    return call;
  } catch {
    return null;
  }
}

/** Explicit private composition; opening a public page cannot obtain this capability. */
export function automaticAssistant(
  shopIds: readonly string[],
  pipeline: AssistantPipeline,
  client: LivingTownClient,
): AutomaticAssistant {
  requireStorage(
    shopIds.length > 0 &&
      shopIds.length <= 16 &&
      new Set(shopIds).size === shopIds.length &&
      shopIds.every(
        (s) =>
          /^[1-9][0-9]{0,3}$/.test(s) && BigInt(s) >= 4n && BigInt(s) <= 1003n,
      ),
    "reviewed bounded assistant shop set required",
  );
  const ids = Object.freeze([...shopIds]);
  return {
    shopIds: ids,
    async propose(id, reader) {
      requireStorage(
        ids.includes(id),
        "shop outside automatic scheduler scope",
      );
      requireStorage(
        canonicalLivingTownJson(client.identity) ===
          canonicalLivingTownJson(reader.identity),
        "automatic deployment identity mismatch",
      );
      const shop = await reader.getShop(id);
      if (shop.data?.owner.kind !== "player") return null;
      const owner = shop.data.owner.account_id;
      try {
        const initial = (await reader.getAssistantPolicy(id)).data;
        const proposals = await pipeline.generateAutomatic(
          owner,
          id,
          async () => {
            // Never reuse the original pinned block as revocation authority before a paid call.
            const fresh = await client.finalized(),
              p = (await fresh.getAssistantPolicy(id)).data,
              currentShop = (await fresh.getShop(id)).data,
              town = await fresh.getTown();
            requireStorage(
              !town.data.paused &&
                currentShop?.owner.kind === "player" &&
                currentShop.owner.account_id === owner &&
                p.revision === initial.revision &&
                p.mode === "auto_reprice" &&
                p.operator_account_id === reader.identity.operatorId &&
                p.expires_at_ns !== null &&
                BigInt(p.expires_at_ns) > BigInt(fresh.block.timestampNs),
              "automatic permission required",
            );
          },
        );
        return (
          proposals.find(
            (p) => p.shop_id === id && p.action.type === "suggest_price",
          ) ?? null
        );
      } catch {
        return null;
      }
    },
  };
}
