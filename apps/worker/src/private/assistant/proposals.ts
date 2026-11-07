import {
  canonicalLivingTownJson,
  parseU64,
  livingTownShop,
  livingTownLedger,
  livingTownListing,
} from "@bot-bazaar/chain";
import { livingTownItemIds } from "@bot-bazaar/shared";
import { requireStorage, sha256 } from "../storage/validation.js";

export const assistantSchema = "living-town-assistant-proposal-v1";
export const assistantPromptVersion = "assistant-recommendations-v1";
const positiveString = { type: "string", pattern: "^[1-9][0-9]{0,19}$" };
export const assistantResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "proposals"],
  properties: {
    schema: { const: assistantSchema },
    proposals: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "reason"],
        properties: {
          reason: {
            type: "string",
            minLength: 1,
            maxLength: 240,
            pattern: "^[\\x20-\\x7e]+$",
          },
          action: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "type",
                  "item_id",
                  "listing_id",
                  "expected_listing_revision",
                  "current_unit_price",
                  "suggested_unit_price",
                ],
                properties: {
                  type: { const: "suggest_price" },
                  item_id: { enum: ["health_potion", "iron_tool"] },
                  listing_id: positiveString,
                  expected_listing_revision: positiveString,
                  current_unit_price: positiveString,
                  suggested_unit_price: positiveString,
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "type",
                  "item_id",
                  "listing_id",
                  "expected_listing_revision",
                  "seller_shop_id",
                  "quantity",
                  "unit_price",
                  "total_price",
                ],
                properties: {
                  type: { const: "suggest_restock" },
                  item_id: { enum: ["crystal", "wood", "herb", "iron"] },
                  listing_id: positiveString,
                  expected_listing_revision: positiveString,
                  seller_shop_id: positiveString,
                  quantity: positiveString,
                  unit_price: positiveString,
                  total_price: positiveString,
                },
              },
            ],
          },
        },
      },
    },
  },
};
export type PriceAction = {
  type: "suggest_price";
  item_id: string;
  listing_id: string;
  expected_listing_revision: string;
  current_unit_price: string;
  suggested_unit_price: string;
};
export type RestockAction = {
  type: "suggest_restock";
  item_id: string;
  listing_id: string;
  expected_listing_revision: string;
  seller_shop_id: string;
  quantity: string;
  unit_price: string;
  total_price: string;
};
export type AssistantAction = PriceAction | RestockAction;
export interface Candidate {
  action: AssistantAction;
  reason: string;
}
export interface AssistantFacts {
  snapshot: {
    deployment: unknown;
    block_hash: string;
    block_height: string;
    block_timestamp_ns: string;
    market_revision: string;
    event_sequence: string;
  };
  shop: ReturnType<typeof livingTownShop>;
  ledger: ReturnType<typeof livingTownLedger>;
  listings: ReturnType<typeof livingTownListing>[];
  fresh: boolean;
  historyComplete: boolean;
  paused: boolean;
  /** Historical confirmed completed-batch unit cost ceiling; not current FIFO/margin proof. */
  productionCost: Record<string, string | null>;
  /** Units bought from this shop during the preceding five chain epochs. */
  demand: Record<string, string>;
}
export interface AssistantProposal extends Candidate {
  schema: typeof assistantSchema;
  proposal_id: string;
  shop_id: string;
  owner_account_id: string;
  snapshot: AssistantFacts["snapshot"];
  expected_shop_revision: string;
  expected_ledger_revision: string;
  expected_policy_revision: string;
  config_revision: string;
  created_at_ns: string;
  expires_at_ns: string;
  source: "model" | "rules_fallback";
}
const exact = (v: unknown, keys: string[]): Record<string, unknown> => {
  requireStorage(
    v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(v)),
    "invalid assistant object",
  );
  const descriptors = Object.getOwnPropertyDescriptors(v);
  requireStorage(
    Reflect.ownKeys(v).length === keys.length &&
      keys.every(
        (k) =>
          Object.hasOwn(descriptors, k) &&
          descriptors[k]!.enumerable &&
          Object.hasOwn(descriptors[k]!, "value"),
      ),
    "invalid assistant fields",
  );
  return v as Record<string, unknown>;
};
const integer = (v: unknown, max = 18446744073709551615n): string => {
  const s = parseU64(v);
  requireStorage(
    BigInt(s) > 0n && BigInt(s) <= max,
    "invalid assistant integer",
  );
  return s;
};
export function parseAssistantCandidates(value: unknown): Candidate[] {
  const top = exact(value, ["schema", "proposals"]);
  requireStorage(
    top["schema"] === assistantSchema &&
      Array.isArray(top["proposals"]) &&
      top["proposals"].length <= 2,
    "invalid assistant schema/count",
  );
  const seen = new Set<string>();
  return top["proposals"].map((v: unknown) => {
    const p = exact(v, ["action", "reason"]);
    requireStorage(
      typeof p["reason"] === "string" &&
        /^[\x20-\x7e]{1,240}$/.test(p["reason"]) &&
        !/[<>]/.test(p["reason"]),
      "invalid assistant reason",
    );
    const raw = p["action"],
      type =
        raw && typeof raw === "object"
          ? Object.getOwnPropertyDescriptor(raw, "type")?.value
          : null;
    let action: AssistantAction;
    if (type === "suggest_price") {
      const a = exact(raw, [
        "type",
        "item_id",
        "listing_id",
        "expected_listing_revision",
        "current_unit_price",
        "suggested_unit_price",
      ]);
      requireStorage(
        ["health_potion", "iron_tool"].includes(String(a["item_id"])),
        "invalid product",
      );
      action = {
        type,
        item_id: String(a["item_id"]),
        listing_id: integer(a["listing_id"]),
        expected_listing_revision: integer(a["expected_listing_revision"]),
        current_unit_price: integer(a["current_unit_price"], 100n),
        suggested_unit_price: integer(a["suggested_unit_price"], 100n),
      };
    } else {
      requireStorage(
        type === "suggest_restock",
        "unsupported assistant action",
      );
      const a = exact(raw, [
        "type",
        "item_id",
        "listing_id",
        "expected_listing_revision",
        "seller_shop_id",
        "quantity",
        "unit_price",
        "total_price",
      ]);
      requireStorage(
        ["crystal", "wood", "herb", "iron"].includes(String(a["item_id"])),
        "invalid raw item",
      );
      action = {
        type,
        item_id: String(a["item_id"]),
        listing_id: integer(a["listing_id"]),
        expected_listing_revision: integer(a["expected_listing_revision"]),
        seller_shop_id: integer(a["seller_shop_id"]),
        quantity: integer(a["quantity"], 100n),
        unit_price: integer(a["unit_price"], 100n),
        total_price: integer(a["total_price"], 10000n),
      };
      requireStorage(
        BigInt(action.total_price) ===
          BigInt(action.quantity) * BigInt(action.unit_price),
        "restock total mismatch",
      );
    }
    requireStorage(
      !seen.has(action.type),
      "duplicate assistant suggestion kind",
    );
    seen.add(action.type);
    return { action, reason: p["reason"] };
  });
}
export function validateCandidate(
  candidate: Candidate,
  f: AssistantFacts,
): void {
  const a = candidate.action,
    l = f.listings.find((l) => l.listing_id === a.listing_id);
  requireStorage(
    f.fresh &&
      f.historyComplete &&
      !f.paused &&
      l?.active &&
      l.item_id === a.item_id &&
      l.revision === a.expected_listing_revision,
    "stale assistant listing",
  );
  if (a.type === "suggest_price") {
    const cost = f.productionCost[a.item_id];
    requireStorage(
      l.shop_id === f.shop.shop_id &&
        l.owner.kind === "player" &&
        f.shop.owner.kind === "player" &&
        l.owner.account_id === f.shop.owner.account_id &&
        a.current_unit_price === l.unit_price &&
        a.suggested_unit_price !== l.unit_price &&
        cost !== null &&
        cost !== undefined &&
        BigInt(a.suggested_unit_price) > BigInt(cost),
      "invalid price/cost policy",
    );
  } else {
    const index = livingTownItemIds.find((item) => item === a.item_id);
    requireStorage(
      l.owner.kind === "merchant" &&
        ["1", "2", "3"].includes(l.shop_id) &&
        a.seller_shop_id === l.shop_id &&
        a.unit_price === l.unit_price &&
        index !== undefined &&
        BigInt(a.quantity) <= BigInt(l.remaining_quantity) &&
        BigInt(f.ledger.inventory.held[index]!) +
          BigInt(f.ledger.inventory.trade_inbound_reserved[index]!) +
          BigInt(a.quantity) <=
          4n &&
        BigInt(a.total_price) <= 100n &&
        BigInt(f.ledger.gold.available) >= BigInt(a.total_price) + 20n &&
        BigInt(f.ledger.inventory.held[index]!) +
          BigInt(f.ledger.inventory.production_output_reserved[index]!) +
          BigInt(f.ledger.inventory.trade_inbound_reserved[index]!) +
          BigInt(a.quantity) <=
          1000n,
      "invalid restock budget/stock/capacity",
    );
  }
}
export function rulesCandidates(f: AssistantFacts): Candidate[] {
  if (!f.fresh || !f.historyComplete || f.paused) return [];
  const result: Candidate[] = [];
  for (const item of ["health_potion", "iron_tool"]) {
    const l = f.listings.find(
        (l) => l.shop_id === f.shop.shop_id && l.item_id === item && l.active,
      ),
      cost = f.productionCost[item];
    if (!l || cost === null || cost === undefined) continue;
    const floor = BigInt(cost) + 1n,
      old = BigInt(l.unit_price),
      sold = BigInt(f.demand[item] ?? "0");
    const next =
      sold > 0n
        ? old + 1n > floor
          ? old + 1n
          : floor
        : old - 1n > floor
          ? old - 1n
          : floor;
    if (next < 1n || next > 100n || next === old) continue;
    const p: Candidate = {
      action: {
        type: "suggest_price",
        item_id: item,
        listing_id: l.listing_id,
        expected_listing_revision: l.revision,
        current_unit_price: l.unit_price,
        suggested_unit_price: next.toString(),
      },
      reason:
        "Rules fallback: bounded price using recorded production cost and recent confirmed demand; review required.",
    };
    validateCandidate(p, f);
    result.push(p);
    break;
  }
  for (const item of ["crystal", "wood", "herb", "iron"] as const) {
    const i = item;
    const held =
      BigInt(f.ledger.inventory.held[i]!) +
      BigInt(f.ledger.inventory.trade_inbound_reserved[i]!);
    if (held >= 4n) continue;
    const l = f.listings
      .filter(
        (l) =>
          l.active &&
          l.item_id === item &&
          l.owner.kind === "merchant" &&
          ["1", "2", "3"].includes(l.shop_id),
      )
      .sort(
        (a, b) =>
          Number(BigInt(a.unit_price) - BigInt(b.unit_price)) ||
          Number(BigInt(a.listing_id) - BigInt(b.listing_id)),
      )[0];
    if (!l) continue;
    const quantity = [
      4n - held,
      BigInt(l.remaining_quantity),
      (BigInt(f.ledger.gold.available) - 20n) / BigInt(l.unit_price),
      100n / BigInt(l.unit_price),
    ].reduce((a, b) => (a < b ? a : b));
    if (quantity < 1n) continue;
    const p: Candidate = {
      action: {
        type: "suggest_restock",
        item_id: item,
        listing_id: l.listing_id,
        expected_listing_revision: l.revision,
        seller_shop_id: l.shop_id,
        quantity: quantity.toString(),
        unit_price: l.unit_price,
        total_price: (quantity * BigInt(l.unit_price)).toString(),
      },
      reason:
        "Rules fallback: replenish toward four units while preserving 20 game gold; owner purchase approval required.",
    };
    try {
      validateCandidate(p, f);
      result.push(p);
      break;
    } catch {
      /* no safe suggestion */
    }
  }
  return result;
}
export function bindProposal(
  c: Candidate,
  f: AssistantFacts,
  revision: string,
  source: AssistantProposal["source"],
): AssistantProposal {
  requireStorage(f.shop.owner.kind === "player", "player assistant only");
  const terms: Omit<AssistantProposal, "proposal_id"> = {
    schema: assistantSchema,
    shop_id: f.shop.shop_id,
    owner_account_id: f.shop.owner.account_id,
    snapshot: f.snapshot,
    expected_shop_revision: f.shop.revision,
    expected_ledger_revision: f.ledger.revision,
    expected_policy_revision: f.shop.policy_revision,
    config_revision: revision,
    created_at_ns: f.snapshot.block_timestamp_ns,
    expires_at_ns: (
      BigInt(f.snapshot.block_timestamp_ns) + 120000000000n
    ).toString(),
    source,
    ...c,
  };
  return { ...terms, proposal_id: sha256(canonicalLivingTownJson(terms)) };
}
export function factKey(f: AssistantFacts): string {
  // Validate the core decoded records again at the injected/internal boundary.
  livingTownShop(f.shop);
  livingTownLedger(f.ledger);
  f.listings.forEach(livingTownListing);
  return sha256(canonicalLivingTownJson(f));
}
