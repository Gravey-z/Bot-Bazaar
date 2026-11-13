import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { requireStorage, sha256 } from "../storage/validation.js";
import type { TownProviderConfiguration } from "./provider.js";
import type { TownProposalContext } from "./proposals.js";
import { townProposalSchema } from "./proposals.js";
import type { LivingTownMerchantPolicy } from "./merchant-policy.js";
import type { RuntimeBudget } from "./runtime-budget.js";
import { merchantCharacter } from "./merchant-characters.js";
import { negotiationAvailable } from "./negotiation.js";
import { offerMaterialRules } from "@bot-bazaar/chain";

// Ready JSON-mode model in the NEAR AI catalogue checked 2026-11-11.
// Modest upgrade: $0.17 input / $1.10 output per million tokens.
export const nearAiModel = "Qwen/Qwen3.6-35B-A3B-FP8";
const origin = "https://cloud-api.near.ai";
export class NearAiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
    readonly parameter?: string,
  ) {
    super(`NEAR AI HTTP ${status}`);
    this.name = "NearAiHttpError";
  }
}

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => {
  requireStorage(
    v && typeof v === "object" && !Array.isArray(v),
    "invalid NEAR AI object",
  );
  return v as ObjectValue;
};
/** Intentionally no endpoint override, redirects, automatic paid retries, tools or browser credentials. */
async function jsonRequest(
  path: string,
  key: string | null,
  body?: unknown,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ body: ObjectValue; headers: Headers }> {
  const response = await fetcher(origin + path, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    ...(signal ? { signal } : {}),
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Never include a remote error body or request headers in exceptions/logs.
if (!response.ok) {
  let detail: string | undefined;
  let parameter: string | undefined;

  try {
    // Read at most 4 KB from an error response.
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        while (total < 4096) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value.slice(0, 4096 - total));
          total += value.byteLength;
        }
      } finally {
        await reader.cancel();
      }

      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(raw);
      const error = parsed?.error;

      if (typeof error?.message === "string") {
        detail = error.message
          .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
          .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
          .replace(/[\r\n\t]/g, " ")
          .slice(0, 240);
      }

      if (typeof error?.param === "string") {
        parameter = error.param.slice(0, 80);
      }
    }
  } catch {
    // Preserve the HTTP status even if the body cannot be parsed.
  }

  throw new NearAiHttpError(response.status, detail, parameter);
}
  requireStorage(response.body, "NEAR AI body missing");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireStorage(size <= 131072, "NEAR AI response too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return {
    body: object(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
    headers: response.headers,
  };
}
export function nearAiCredential(path: string): () => string {
  const original = realpathSync(path);
  return () => {
    const stat = lstatSync(path);
    requireStorage(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size <= 4096 &&
        realpathSync(path) === original,
      "NEAR AI credential file changed",
    );
    const key = readFileSync(path, "utf8").trim();
    requireStorage(
      key.length > 0 && key.length <= 1024 && !/\s/.test(key),
      "invalid NEAR AI credential file",
    );
    return key;
  };
}
export interface NearAiQuote {
  model: string;
  inputRate: number;
  outputRate: number;
  evidence: string;
  verifiedUntil: number;
}
export async function nearAiPreflight(
  loadKey: () => string,
  fetcher: typeof fetch = fetch,
): Promise<NearAiQuote> {
  const signal = AbortSignal.timeout(15000);
  const auth = await jsonRequest(
    "/v1/check_api_key",
    loadKey(),
    {},
    signal,
    fetcher,
  );
  requireStorage(auth.body["valid"] === true, "NEAR AI key not authorized");
  const catalog = await jsonRequest(
    "/v1/models",
    null,
    undefined,
    signal,
    fetcher,
  );
  requireStorage(
    Array.isArray(catalog.body["data"]),
    "invalid NEAR AI catalog",
  );
  const model = object(
    catalog.body["data"].find((v: unknown) => object(v)["id"] === nearAiModel),
  );
  const pricing = object(model["pricing"]),
    inputRate = Number(pricing["input"]) * 1000000,
    outputRate = Number(pricing["output"]) * 1000000;
  requireStorage(
    model["is_ready"] === true &&
      Array.isArray(model["supported_features"]) &&
      model["supported_features"].includes("json_mode") &&
      model["supported_features"].includes("structured_outputs") &&
      Number.isSafeInteger(inputRate) &&
      inputRate > 0 &&
      inputRate <= 170000 &&
      Number.isSafeInteger(outputRate) &&
      outputRate > 0 &&
      outputRate <= 1100000 &&
      Number(pricing["request"] ?? "0") === 0,
    "unreviewed NEAR AI model capability/pricing increase",
  );
  return {
    model: nearAiModel,
    inputRate,
    outputRate,
    evidence: `near-ai-catalog:${sha256(JSON.stringify(model))}`,
    verifiedUntil: Date.now() + 3600000,
  };
}
/** Byte-level BPE cannot exceed UTF-8 bytes before merges. Full serialized body
 * plus 256 template/special tokens is a conservative bound for this text-only,
 * two-message template, including its response schema (no tools or images).
 * The whole body, including settings/JSON escaping, is over-counted deliberately. */
export const nearAiInputBound = (payload: string): number =>
  Buffer.byteLength(payload, "utf8") + 256;

function responseFormat(context: TownProposalContext): ObjectValue {
  // Use the same action fields as the local decoder. Keep backend regexes simple;
  // the local decoder still checks full decimal bounds and exact string endings.
  
const schema = object(
  JSON.parse(
    JSON.stringify(townProposalSchema, (key, value: unknown) => {
      // These constraints are not supported by the model's xgrammar backend.
      // Keep them in our local proposal validator instead.
      if (
        key === "pattern" ||
        key === "minLength" ||
        key === "maxLength"
      ) {
        return undefined;
      }

      return value;
    }),
  ),
);

  const properties = object(schema["properties"]);
  properties["tick_id"] = { type: "string", enum: [context.tickId] };
  properties["market_revision"] = { type: "string", enum: [object(context.facts.town)["market_revision"]] };
  properties["merchant_id"] = { type: "string", enum: [context.merchant] };
  const action = object(properties["action"]);
  const hasIncomingOffer =
  (context.facts.pendingOffers ?? []).some(
    o => object(o)["seller"] === context.merchant
  );

const productionActions =
  context.merchant === "bolt"
    ? ["start_production", "complete_production"]
    : [];

const allowed = negotiationAvailable(context.facts)
  ? hasIncomingOffer
    ? ["wait", "accept_trade", "reject_trade"]
    : [
        "wait",
        "propose_trade",
        ...productionActions,
      ]
  : [
      "wait",
      "adjust_price",
      "set_listing",
      ...productionActions,
    ];
  const focused = context.purpose === "pricing" ? ["wait", "adjust_price"] : allowed;
  action["anyOf"] = (action["oneOf"] as ObjectValue[]).filter(branch =>
    focused.includes(String(object(object(branch["properties"])["type"])["const"])));
  delete action["oneOf"];
  return { type: "json_schema", json_schema: { name: "merchant_decision", strict: true, schema } };
}

// Full profiles remain in the audited provider context. Send a concise rendering
// so repeated personality prose does not crowd out exact economic facts.
function promptCharacter(character: ReturnType<typeof merchantCharacter>): string {

const priorities = {
  rex:
    "You are the primary crystal supplier. Sell crystals and protect your crystal reserves. " +
    "Look for eligible opportunities to BUY wood and iron from Bolt and herbs from Luna or other eligible sellers. " +
    "Do not search for crystal suppliers when your own crystal stock is healthy. " +
    "Build useful backup inventory for future sales and stock security. " +
    "Consider affordable purchases even without immediate resale profit. " +
    "Protect operating gold and avoid unnecessary overstock.",

  luna:
    "You are the primary herb supplier. Sell herbs and protect your herb reserves. " +
    "Look for eligible opportunities to BUY crystals from Rex and wood or iron from Bolt. " +
    "Build useful backup inventory to support the town and future sales. " +
    "Consider affordable purchases even without immediate resale profit. " +
    "Preserve operating gold and keep essential herbs available.",

  bolt:
    "You are the primary wood and iron supplier and an iron-tool producer. " +
    "Sell wood and iron while protecting materials needed for crafting. " +
    "Look for eligible opportunities to BUY crystals from Rex and herbs from Luna or other eligible sellers. " +
    "Prioritize production and useful backup inventory. " +
    "Consider affordable purchases even without immediate resale profit. " +
    "Protect operating gold and production reserves.",
}[character.id];

  return `${character.name}; ${character.role}. Voice: ${character.voice} Priorities: ${priorities}`;
}

function pricingPrompt(context: TownProposalContext, signals: ReturnType<LivingTownMerchantPolicy["evaluate"]>): string {
  const own = context.facts.merchants.find(m =>
    object(object(object(m.shop)["data"])["owner"])["merchant_id"] === context.merchant)!;
  const state = {
    tick_id: context.tickId, market_revision: object(context.facts.town)["market_revision"],
    merchant_id: context.merchant, now_ns: object(context.facts.town)["block_timestamp_ns"],
    pricing: signals.pricing.filter(p => p.merchant === context.merchant),
    stocks: object(context.facts.town)["data"],
    listings: own.listings,
    competitors: context.facts.merchants.filter(m => m !== own).flatMap(m => m.listings),
  };
  // Pricing needs inventory totals, not the full town, account ledgers or offers.
  state.stocks = (object(state.stocks)["npc_ledgers"] as unknown[])
    .map(object).filter(l => object(l["actor"])["merchant_id"] === context.merchant)
    .map(l => ({ held: object(l["inventory"])["held"], listed: object(l["inventory"])["listing_reserved"] }));
  const listing = (value: unknown) => {
    const l = object(value);
    return [l["item_id"], l["remaining_quantity"], l["unit_price"], l["active"]];
  };
  return JSON.stringify({ model: nearAiModel, stream: false, temperature: 0.2, max_tokens: 512,
    reasoning_effort: "none", response_format: responseFormat(context), messages: [
      { role: "system", content: "Review prices only. Return JSON matching the response schema; copy identities exactly. " +
        "Choose wait or adjust_price for one stocked item. Decimal values are strings; reason is 1-240 printable ASCII. " +
        "Use demand, inventory and active competitors to choose competitive sustainable prices within the supplied bands. " +
        "Change at most one gold and respect cooldowns. Preserve listing quantities and stock reserves. " +
        "Suggestions are guidance, not mandatory prices. Explain your choice. Character: " + promptCharacter(merchantCharacter(context.merchant)) },
      { role: "user", content: JSON.stringify({ ...state, listings: own.listings.map(listing), competitors: state.competitors.map(listing) }) },
    ] });
}

function prompt(
  context: TownProposalContext,
  policy: LivingTownMerchantPolicy,
): string {
  const signals = policy.evaluate(context.facts);
  if (context.purpose === "pricing") return pricingPrompt(context, signals);
  const character = merchantCharacter(context.merchant);
  if (negotiationAvailable(context.facts))
    return negotiationPrompt(context, signals, character);
  const row = context.facts.merchants.find(
    (m) =>
      object(object(m.shop)["data"])["owner"] &&
      object(object(object(m.shop)["data"])["owner"])["merchant_id"] ===
        context.merchant,
  )!;
  const state = {
    tick_id: context.tickId,
    market_revision: object(context.facts.town)["market_revision"],
    merchant_id: context.merchant,
    merchant_trading_available: context.facts.merchantTrading === true,
    
    pricing_columns:
      "item,basePrice,minPrice,maxPrice,cooldownUntilNs",
    pricing: signals.pricing
      .filter(p => p.merchant === context.merchant)
      .map(p => [
        p.item,
        p.basePrice,
        p.minPrice,
        p.maxPrice,
        p.cooldownUntilNs,
      ]),

    peer_listings: context.facts.merchantTrading
      ? context.facts.merchants.flatMap((m) =>
          m.listings.filter(listing => object(object(listing)["owner"])["merchant_id"] !== context.merchant).map((listing) => {
            const l = object(listing);
            return [object(l["owner"])["merchant_id"], l["item_id"], l["remaining_quantity"], l["unit_price"]];
          }),
        )
      : [],
    peer_listing_columns: "merchant,item,quantity,price",
    scarcity: signals.scarcity
      .filter((s) => s.supplier === context.merchant)
      .map((s) => [s.item, s.held, s.reserved, s.floor, s.target, s.saleable, s.confirmedDemand]),
    scarcity_columns: "item,held,listed,floor,target,saleable,demand",
    listings: row.listings.map((l) => {
      const v = object(l);
      return [v["item_id"], v["remaining_quantity"], v["unit_price"]];
    }),
    listing_columns: "item,quantity,price",
    job:
      row.job === null
        ? null
        : (() => {
            const job = object(row.job);
            return {
              job_id: job["job_id"],
              item: job["output_item"],
              quantity: job["output_quantity"],
              ready_at_ns: job["ready_at_ns"],
              status: job["status"],
            };
          })(),
    now_ns: object(context.facts.town)["block_timestamp_ns"],
    ...(context.merchant === "bolt" ? {
      production_rules: { recipe_id: "iron_tool", recipe_version: "1", quantity: "1", wood: "1", iron: "2", minimum_gold_reserve: "60", maximum_running_jobs: 1 },
    } : {}),
    inventory: (() => {
  const ledgers = object(
    object(context.facts.town)["data"]
  )["npc_ledgers"];

  requireStorage(
    Array.isArray(ledgers),
    "merchant ledgers missing",
  );

  const ledger = ledgers
    .map(object)
    .find(
      l =>
        object(l["actor"])["merchant_id"] ===
        context.merchant,
    );

  requireStorage(ledger, "merchant ledger missing");

  const inventory = object(ledger["inventory"]);

  return {
    held: inventory["held"],
    listing_reserved: inventory["listing_reserved"],
    trade_reserved: inventory["trade_reserved"],
    available: inventory["available"],
  };
})(),
    available_gold: (() => {
      const ledgers = object(object(context.facts.town)["data"])["npc_ledgers"];
      requireStorage(Array.isArray(ledgers), "merchant ledgers missing");
      const ledger = ledgers
        .map(object)
        .find((l) => object(l["actor"])["merchant_id"] === context.merchant);
      requireStorage(ledger, "merchant ledger missing");
      return object(ledger["gold"])["available"];
    })(),
  };
  return JSON.stringify({
    model: nearAiModel,
    stream: false,
    temperature: 0.2,
    max_tokens: 512,
    reasoning_effort: "none",
    response_format: responseFormat(context),
    messages: [
      {
        role: "system",
        content:
          'Choose from confirmed facts. ' +
          'Return one JSON object using this envelope (replace the example action with your chosen permitted action): {"schema":"living-town-proposal-v1","tick_id":"COPY","market_revision":"COPY","merchant_id":"COPY","reason":"1-240 printable ASCII","action":{"type":"wait"}}. ' +
          'Keep all six fields. ' +
          'action must be ONE object, never an array; no extra fields or markdown. ' +
          'Copy identity strings exactly; decimals are strings. ' +
          'Replace action with one of: ' +
          '{"type":"wait"}, ' +
          '{"type":"start_production","recipe_id":"iron_tool","quantity":"1"}, ' +
          '{"type":"complete_production","job_id":"JOB_ID"}, ' +
'{"type":"set_listing","item_id":"ITEM","quantity":"QTY","unit_price":"PRICE","reserve_quantity":"RESERVE"}, ' +
'{"type":"adjust_price","item_id":"ITEM","unit_price":"PRICE"}. ' +
'For set_listing, choose the selling quantity and ' +
'the amount to keep for production or future trades. ' +
'Use actual held inventory minus trade reservations. ' +
'Existing listed stock is already included in held; ' +
'do not subtract it twice. ' +
'The proposed listing plus desired reserve must ' +
'not exceed uncommitted stock. ' +
'Keep essential supplier and production reserves. ' +
'Choose prices within the permitted pricing bands. ' +
'Avoid unnecessary listing updates. ' +
          'Independently choose among verified economic opportunities. ' +
          'For Bolt, independently compare production against waiting and selling. ' +
          'Start only the configured iron_tool recipe, using one wood and two iron, when free resources, reserves and the single job slot permit it. ' +
          'Complete only the confirmed running job when ready; copy the exact job_id from the input. ' +
          'You independently decide whether to increase, decrease or ' +
          'keep your selling prices based on supply, demand, ' +
          'competition, inventory and your merchant personality. ' +
          'Use adjust_price only for an existing owned listing. ' +
          'Choose a price within minPrice and maxPrice. ' +
          'Change prices by at most 1 gold per decision. ' +
          'Preserve listing quantity and respect cooldownUntilNs. ' +
          'Choose wait if no price change is economically justified. ' +
          'No negotiated trades here. ' +
          'Use only owned stock and supported actions; invent nothing. ' +
          'Character: ' +
          promptCharacter(character),
      },
      { role: "user", content: JSON.stringify(state) },
    ],
  });
}
function negotiationPrompt(
  context: TownProposalContext,
  signals: ReturnType<LivingTownMerchantPolicy["evaluate"]>,
  character: ReturnType<typeof merchantCharacter>,
): string {
  const town = object(context.facts.town),
    data = object(town["data"]),
    plan = signals.stockSharing!;
  const items = [
    "crystal",
    "wood",
    "herb",
    "iron",
    "health_potion",
    "iron_tool",
  ];
  const offers = (context.facts.pendingOffers ?? [])
    .map(object)
    .filter((o) => o["seller"] === context.merchant);
  const own = context.facts.merchants.find(
    (r) =>
      object(object(object(r.shop)["data"])["owner"])["merchant_id"] ===
      context.merchant,
  )!;

const merchantPlan = plan.merchants.find(
  (m) => m.merchant === context.merchant,
);

console.log(
  JSON.stringify({
    role: "economic_runtime",
    event: "merchant_trade_opportunities",
    merchant: context.merchant,
    reaction_role: context.facts.stockSharingReaction?.followUpOnly
      ? "followup_only"
      : "buyer_eligible",
    backup_target: "3",
    candidates: plan.candidates
      .filter((c) => c.buyer === context.merchant)
      .map((c) => ({
        seller: c.seller,
        item: c.item,
        kind: c.kind,
        choices: c.quantityChoices.map((q) => ({
          quantity: q.quantity,
          minimum_price: q.minUnitPrice,
          maximum_price: q.maxUnitPrice,
        })),
      })),
    rejection_reasons: merchantPlan?.reasons ?? [],
  }),
);

  const stocks = (data["npc_ledgers"] as unknown[]).map(object).map((l) => {
    const inv = object(l["inventory"]),
      gold = object(l["gold"]);
    return [
      object(l["actor"])["merchant_id"],
      [gold["held"], gold["available"], gold["trade_reserved"]].join(","),
      ...[
        "held",
        "listing_reserved",
        "trade_reserved",
        "trade_inbound_reserved",
        "production_output_reserved",
      ].map((k) => items.map((item) => object(inv[k])[item]).join(",")),
    ];
  });
  const state = {
    tick_id: context.tickId,
    market_revision: town["market_revision"],
    merchant_id: context.merchant,
    now_ns: town["block_timestamp_ns"],
    items,
    stock_columns:
      "merchant,gold(held,available,reserved),held,listed,outgoing,incoming,outputs; vectors CSV in items order",
    stocks,
    your_gold_floor: ({ rex: "80", luna: "120", bolt: "60" } as const)[
      context.merchant
    ],
    peer_cap: "7",
    peer_floor: "2",
    backup_target: "3",
        resale_pricing_columns:
      "item,basePrice,minAllowedPrice,maxAllowedPrice,currentOwnListingPrice,cooldownUntilNs",

    resale_pricing: (
      ["crystal", "wood", "herb", "iron"] as const
    ).map((item) => {
      const rule = offerMaterialRules[item];

      const listing = own.listings
        .map(object)
        .find((l) => l["item_id"] === item);

      const pricing = signals.pricing.find(
        (p) =>
          p.merchant === context.merchant &&
          p.item === item,
      );

      return [
        item,
        rule.base_price,
        rule.min_price,
        rule.max_price,
        listing?.["unit_price"] ?? null,
                pricing?.cooldownUntilNs ?? null,
      ];
    }),

    candidate_columns:
      "seller,item,choices[quantity,minPrice,maxPrice,releaseTo]",
    candidates: plan.candidates
      .filter((c) => c.buyer === context.merchant)
      .map((c) => [
        c.seller,
        c.item,
        c.quantityChoices.map((q) => [
          q.quantity,
          q.minUnitPrice,
          q.maxUnitPrice,
          q.listingRelease?.maxRemainingQuantity ?? null,
        ]),
      ]),
    signal_columns: "item,sold300s,low,fast",
    demand: plan.signals.map((s) => [
      s.item,
      s.retailDemand,
      s.lowStock,
      s.fastSelling,
    ]),
    ...(offers.length
      ? {
          offer_columns:
            "id,buyer,seller,item,quantity,price,total,revision,created_ns,expires_ns",
        }
      : {}),
    incoming: offers.map((o) => [
      o["offer_id"],
      o["buyer"],
      o["seller"],
      o["item_id"],
      o["quantity"],
      o["unit_price"],
      o["total_price"],
      o["revision"],
      o["created_at_ns"],
      o["expires_at_ns"],
    ]),
    assessments: plan.pendingAssessments
      .filter((a) => a.seller === context.merchant)
      .map((a) => [
        a.offerId,
        a.eligible,
        a.listingRelease?.maxRemainingQuantity ?? null,
        a.reasons,
      ]),
    shop: own.listings
      .map(object)
      .map((l) => [l["item_id"], l["remaining_quantity"], l["unit_price"]]),
    job:
      own.job === null
        ? null
        : [
             object(own.job)["job_id"],
            object(own.job)["output_item"],
            object(own.job)["output_quantity"],
            object(own.job)["status"],
            object(own.job)["ready_at_ns"],
          ],
    // resale_pricing already includes these bands and cooldowns.
  };

if (offers.length > 0) {
  console.log(JSON.stringify({
    role: "economic_runtime",
    event: "merchant_incoming_offer_assessment",
    merchant: context.merchant,
    offers: offers.map(o => ({
      offer_id: o["offer_id"],
      buyer: o["buyer"],
      seller: o["seller"],
      item: o["item_id"],
      quantity: o["quantity"],
      unit_price: o["unit_price"],
    })),
    assessments: plan.pendingAssessments.filter(
      a => a.seller === context.merchant
    ).map(a => ({
      offer_id: a.offerId,
      eligible: a.eligible,
      acceptance_ready: a.acceptanceReady,
      reasons: a.reasons,
      listing_release: a.listingRelease,
    })),
  }));
}

  return JSON.stringify({
    model: nearAiModel,
    stream: false,
    temperature: 0.2,
    max_tokens: 512,
    reasoning_effort: "none",
    response_format: responseFormat(context),
    messages: [
      {
        role: "system",
        content:
          'Use confirmed facts. Return JSON matching the response schema: copy tick_id, market_revision and merchant_id; ' +
          'reason is 1-240 printable ASCII; action is one permitted object. Decimal values are strings. No extra fields or markdown. ' +
          'Candidates are buying opportunities; only incoming contains actual offers. Favor affordable purchases below backup target 3, ' +
          'including partial buys; never exceed shortage. Immediate resale profit is optional; consider future use and gold floors. ' +
          'Held includes listed stock. Respect reservations, capacity, supplier floors and price bands. ' +
          'For incoming offers, use explicit buyer/seller roles: seller gives stock for gold; buyer pays gold for stock. ' +
          'Accept only eligible terms; acceptance permits necessary listing release and fresh checks, not settlement. ' +
          'Bolt may craft one iron_tool from 1 wood and 2 iron only with no running job and safe reserves. ' +
          'Complete only a ready job using its exact job_id. Offers are not completed trades. ' +
          'Explain the selected action accurately; wait needs a concrete reason and never implies a transfer. ' +
          'A partial purchase reduces shortage, not necessarily to zero. Character: ' +
          promptCharacter(character),

      },
      { role: "user", content: JSON.stringify(state) },
    ],
  });
}
export async function nearAiAccountCost(
  authority: RuntimeBudget,
  requestId: string,
  inferenceId: string,
  loadKey: () => string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<number | null> {
  requireStorage(
    /^[a-f0-9-]{36}$/i.test(inferenceId),
    "invalid inference billing identity",
  );
  const response = await jsonRequest(
    "/v1/billing/costs",
    loadKey(),
    { requestIds: [inferenceId] },
    signal,
    fetcher,
  );
  requireStorage(
    Array.isArray(response.body["requests"]),
    "invalid billing response",
  );
  const found = response.body["requests"]
      .map(object)
      .find((r) => r["requestId"] === inferenceId),
    cost = found?.["costNanoUsd"];
  if (
    response.body["warning"] ||
    !Number.isSafeInteger(cost) ||
    Number(cost) < 0
  )
    return null;
  const usage = authority.budget
    .history()
    .entries.find((r) => r.request_id === requestId);
  requireStorage(usage, "billing reservation missing");
  if (usage.status === "reserved")
    authority.budget.account(
      requestId,
      "near-ai",
      usage.model,
      Math.ceil(Number(cost) / 1000),
      `near-ai-billing:${inferenceId}`,
    );
  else
    requireStorage(
      usage.charged_micro === Math.ceil(Number(cost) / 1000),
      "billing charge changed",
    );
  authority.recordBilling(requestId, inferenceId, Number(cost));
  return Number(cost);
}
export function nearAiProvider(
  policy: LivingTownMerchantPolicy,
  authority: RuntimeBudget,
  quote: NearAiQuote,
  loadKey: () => string,
  fetcher: typeof fetch = fetch,
): TownProviderConfiguration {
  return {
    provider: "near-ai",
    model: nearAiModel,
    promptVersion: "town-near-ai-v17-focused-trading-pricing",
    prepare: (context) => ({
      payload: prompt(context, policy),
      provider: "near-ai",
      model: nearAiModel,
      maxOutputTokens: 512,
      countTokens: nearAiInputBound,
      accountingEvidence: "utf8-byte-upper-bound:full-body-plus-256",
      worstInputMicroPerMillion: quote.inputRate,
      outputMicroPerMillion: quote.outputRate,
      pricingEvidence: quote.evidence,
      verifiedUntil: quote.verifiedUntil,
    }),
    invoke: async (context) => {
      const payload = JSON.parse(context.payload);
      requireStorage(
        payload.model === nearAiModel &&
          payload.max_tokens === 512 &&
          payload.stream === false &&
          payload.response_format?.type === "json_schema" &&
          payload.response_format?.json_schema?.strict === true &&
          context.maxOutputTokens === 512,
        "NEAR AI payload mismatch",
      );
      const result = await jsonRequest(
          "/v1/chat/completions",
          loadKey(),
          payload,
          context.signal,
          fetcher,
        ),
        body = result.body;
      if (body["model"] !== nearAiModel) {
        authority.budget.invalidate("near-ai:model-identity-mismatch");
        requireStorage(false, "NEAR AI model identity mismatch");
      }
      const inferenceId = result.headers.get("inference-id"),
        chatId = body["id"];
      const usage = object(body["usage"]),
        input = Number(usage["prompt_tokens"]),
        output = Number(usage["completion_tokens"]);
      const boundedUsage =
        Number.isSafeInteger(input) &&
        input >= 0 &&
        input <= nearAiInputBound(context.payload) &&
        Number.isSafeInteger(output) &&
        output >= 0 &&
        output <= 512;
      if (!boundedUsage) {
        authority.budget.invalidate("near-ai:token-bound-exceeded");
        requireStorage(false, "NEAR AI token bound exceeded");
      }
      requireStorage(
        Array.isArray(body["choices"]) && body["choices"].length === 1,
        "NEAR AI choice count",
      );
      const choice = object(body["choices"][0]),
        message = object(choice["message"]),
        content = message["content"];
      authority.record(context.requestId, {
        character_prompt_version: "town-near-ai-v4-compact-character",
        payload_sha256: sha256(context.payload),
        input_bound: nearAiInputBound(context.payload),
        chat_id: chatId,
        inference_id: inferenceId,
        transport_request_id:
          result.headers.get("x-request-id") ?? randomUUID(),
        model: body["model"],
        usage,
        response_sha256: sha256(JSON.stringify(body)),
        content: typeof content === "string" ? content.slice(0, 8192) : null,
        finish_reason: choice["finish_reason"],
      });
      context.reportIdentity({ provider: "near-ai", model: nearAiModel });
      // Read-only billing may lag. Retain the full reservation rather than claiming zero cost.
      if (inferenceId) {
        try {
          await nearAiAccountCost(
            authority,
            context.requestId,
            inferenceId,
            loadKey,
            context.signal,
            fetcher,
          );
        } catch {
          /* original reservation remains charged */
        }
      }
      requireStorage(
        !authority.budget.status().blocked,
        "NEAR AI billing stopped further authority",
      );
      requireStorage(
        choice["finish_reason"] === "stop" &&
          typeof content === "string" &&
          content.length <= 8192 &&
          !message["tool_calls"],
        "NEAR AI incomplete/non-JSON response",
      );
      const decision: unknown = JSON.parse(content);
      // Some backends ignore schema string-length constraints. Bound only the
      // display explanation; the full raw reply was recorded above. Never fill
      // missing trade terms or repair economic fields/decision identities.
      if (decision && typeof decision === "object" && !Array.isArray(decision)) {
        const row = decision as ObjectValue;
        const reason = row["reason"];
        if (typeof reason === "string" && reason.length > 240 && /^[\x20-\x7e]+$/.test(reason))
          row["reason"] = reason.slice(0, 237) + "...";
      }
      return decision;
    },
  };
}
