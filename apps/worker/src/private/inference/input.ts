import { parseU64 } from "@bot-bazaar/chain";
import { json, sha256, requireStorage } from "../storage/validation.js";
export interface RecordedInput {
  payloadHash: string;
  status: "recorded" | "unavailable";
  inputJson: string | null;
}
type Project = (value: unknown) => unknown;
function record(value: unknown): Record<string, unknown> {
  requireStorage(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid inference input",
  );
  return value as Record<string, unknown>;
}
function shape(fields: Record<string, Project>): Project {
  return (value) => {
    const input = record(value);
    return Object.fromEntries(
      Object.entries(fields).map(([key, project]) => [
        key,
        project(input[key]),
      ]),
    );
  };
}
function list(project: Project, max: number): Project {
  return (value) => {
    requireStorage(
      Array.isArray(value) && value.length <= max,
      "inference input list exceeds bound",
    );
    return value.map(project);
  };
}
function choice(values: readonly string[]): Project {
  return (value) => {
    requireStorage(
      typeof value === "string" && values.includes(value),
      "invalid inference input enum",
    );
    return value;
  };
}
const integer: Project = (value) => {
  requireStorage(
    Number.isSafeInteger(value) && Number(value) >= 0,
    "invalid inference input timestamp",
  );
  return value;
};
const boolean: Project = (value) => {
  requireStorage(typeof value === "boolean", "invalid inference input boolean");
  return value;
};
const merchant = choice(["rex", "luna", "bolt"]),
  resource = choice(["crystal", "wood", "herb", "iron"]);
const stock = shape({
  crystal: parseU64,
  wood: parseU64,
  herb: parseU64,
  iron: parseU64,
});
const actor = shape({
  merchantId: merchant,
  gold: parseU64,
  inventory: stock,
  committed: shape({ gold: parseU64, inventory: stock }),
  spendableGold: parseU64,
  surplusBeforeListings: stock,
  nextActionId: parseU64,
  listings: list(
    shape({
      resource,
      unit_price: parseU64,
      quantity: parseU64,
      active: boolean,
      version: parseU64,
    }),
    4,
  ),
});
const marketInput = shape({
  type: choice(["untrusted_market_data"]),
  merchantId: merchant,
  phase: choice(["decision", "followup"]),
  observedAt: integer,
  block: shape({
    hash: (value) => {
      requireStorage(
        typeof value === "string" &&
          value.trim() === value &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value),
        "invalid inference block hash",
      );
      return value;
    },
    height: parseU64,
    timestampNs: parseU64,
  }),
  marketRevision: parseU64,
  budgets: shape({
    rootDeadline: integer,
    modelCallsRemaining: integer,
    mutationsRemaining: integer,
  }),
  rexShortageMode: boolean,
  restockEconomics: (value) =>
    value === null || value === undefined
      ? null
      : shape({
          resource: choice(["crystal"]),
          targetGap: parseU64,
          spendableGold: parseU64,
          purchaseUnitPriceBand: list(parseU64, 2),
          futureSaleUnitPriceBand: list(parseU64, 2),
          buyerOnlyQuantityCeilingAtMaxPrice: parseU64,
          totalAtQuantityCeilingAndMaxPrice: parseU64,
          potentialUnitGrossMarginAtMinResaleAndMaxBuyPrice: parseU64,
          futureDemandGuaranteed: (value) => {
            requireStorage(value === false, "future demand is not guaranteed");
            return false;
          },
        })(value),
  own: actor,
  merchants: list(actor, 3),
  offers: list(
    shape({
      offer_id: parseU64,
      proposer: merchant,
      buyer: merchant,
      seller: merchant,
      counterparty: merchant,
      resource,
      quantity: parseU64,
      unit_price: parseU64,
      total_price: parseU64,
      created_at_ns: parseU64,
      expires_at_ns: parseU64,
    }),
    72,
  ),
  recentChanges: list(
    shape({
      trade_id: parseU64,
      kind: choice(["player_purchase", "merchant_trade"]),
      direction: choice(["purchase", "sale"]),
      resource,
      quantity: parseU64,
      total_price: parseU64,
      market_revision: parseU64,
    }),
    8,
  ),
  limits: shape({
    max_trade_quantity: parseU64,
    max_listing_quantity: parseU64,
    max_unit_price: parseU64,
    max_total_price: parseU64,
    max_offer_lifetime_ns: parseU64,
  }),
});
// Audit the exact admitted body by digest. Persist only the known P3.7 market
// data projection; system prompts, provider options, credentials and free text
// are not copied into a log. Unavailable context is explicit, never reconstructed.
export function recordInferenceInput(payload: string): RecordedInput {
  requireStorage(
    typeof payload === "string" && Buffer.byteLength(payload) <= 65536,
    "inference body exceeds recording bound",
  );
  const payloadHash = sha256(payload);
  try {
    const body = record(JSON.parse(payload)),
      messages = body["messages"] ?? body["input"];
    requireStorage(
      Array.isArray(messages) && messages.length <= 8,
      "structured market messages required",
    );
    const users = messages.filter((value) => record(value)["role"] === "user");
    requireStorage(users.length === 1, "one market input required");
    const content = record(users[0])["content"];
    requireStorage(
      typeof content === "string",
      "market input must be JSON text",
    );
    const inputJson = json(marketInput(JSON.parse(content)), 49152);
    return { payloadHash, status: "recorded", inputJson };
  } catch {
    return { payloadHash, status: "unavailable", inputJson: null };
  }
}
