import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseDecision } from "../../apps/worker/dist/private/decisions/schema.js";
import { evaluateDecision } from "../../apps/worker/dist/private/policy/evaluate.js";
import {
  buildMerchantPrompt,
  promptVersion,
} from "../../apps/worker/dist/private/prompts/merchant-prompt.js";
import { sanitizeBriefReason } from "../../apps/worker/dist/private/storage/validation.js";

// Test-only provider. Never imported by a worker runtime or a live-provider path.
export function controlledDecision(state, merchantId, phase) {
  const own = state.market.data.merchants.find(
    (m) => m.merchant_id === merchantId,
  );
  if (!own) throw new Error("unknown scenario merchant");
  const action_id = String(BigInt(own.last_action_id) + 1n);
  if (merchantId === "rex" && phase === "decision")
    return {
      action: {
        method: "propose_trade",
        args: {
          proposer: "rex",
          buyer: "rex",
          seller: "luna",
          resource: "crystal",
          quantity: "4",
          total_price: "24",
          expires_at_ns: String(
            (BigInt(state.block.timestampNs) / 1000000n + 90000n) * 1000000n,
          ),
          action_id,
        },
      },
      reason: "Controlled fixture: replenish four crystals within reserves.",
    };
  if (merchantId === "luna" && phase === "decision") {
    const offer = state.offers.find(
      (o) => o.status === "pending" && o.counterparty === "luna",
    );
    if (!offer) throw new Error("controlled incoming offer missing");
    return {
      action: {
        method: "accept_trade",
        args: { offer_id: offer.offer_id, action_id },
      },
      reason:
        "Controlled fixture: sell four crystals while keeping the stock floor.",
    };
  }
  if (merchantId === "rex" && phase === "followup") {
    const listing = own.listings.find((l) => l.resource === "crystal");
    return {
      action: {
        method: "set_listing",
        args: {
          merchant_id: "rex",
          resource: "crystal",
          quantity: "4",
          unit_price: "7",
          active: true,
          expected_version: listing.version,
          action_id,
        },
      },
      reason:
        "Controlled fixture: relist four crystals in the permanent shortage band.",
    };
  }
  return {
    action: { method: "hold" },
    reason: "Controlled fixture: keep reserves; no eligible followup trade.",
  };
}

export function controlledTurn(input) {
  const { state, merchantId, phase } = input;
  if (
    !state ||
    !["rex", "luna", "bolt"].includes(merchantId) ||
    !["decision", "followup"].includes(phase)
  )
    throw new Error("invalid controlled turn");
  const now = Number(BigInt(state.block.timestampNs) / 1000000n);
  const context = {
    state,
    merchantId,
    phase,
    rootDeadline: now + 120000,
    rexShortageMode: true,
    mutationsRemaining: input.mutationsRemaining ?? 8,
    commitments: [],
    rejectedOfferIds: [],
    changedResources: ["crystal"],
  };
  const prompt = buildMerchantPrompt(
    state,
    { ...context, modelCallsRemaining: 6 },
    now,
  );
  const candidate = parseDecision(
    input.candidate ?? controlledDecision(state, merchantId, phase),
  );
  candidate.reason = sanitizeBriefReason(candidate.reason);
  // Action IDs are allocated by orchestration after confirmed prerequisites,
  // without changing the selected trade terms or requesting another response.
  if (input.candidate && "args" in candidate.action)
    candidate.action.args.action_id = String(
      BigInt(
        state.market.data.merchants.find((m) => m.merchant_id === merchantId)
          .last_action_id,
      ) + 1n,
    );
  const plan = evaluateDecision(candidate.action, context, now);
  return {
    source: "controlled_fixture",
    label: "Controlled sandbox test data",
    liveAiEvidence: false,
    provider: "controlled-fixture",
    model: "scripted-crystal-shortage-v1",
    promptVersion,
    providerInvoked: input.candidate == null,
    promptSha256: createHash("sha256")
      .update(JSON.stringify(prompt.messages))
      .digest("hex"),
    merchantId,
    phase,
    candidate,
    plan,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 262144) throw new Error("input bound");
      chunks.push(chunk);
    }
    process.stdout.write(
      JSON.stringify(
        controlledTurn(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
      ),
    );
  } catch {
    console.error(
      "Controlled scenario turn failed schema or policy validation",
    );
    process.exitCode = 1;
  }
}
