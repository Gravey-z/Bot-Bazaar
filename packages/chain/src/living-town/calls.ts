import {
  accountId,
  bounded,
  check,
  choice,
  object,
  positiveU64,
} from "../wire.js";
import {
  livingTownSnapshot,
  livingTownCommand,
  livingTownOwnershipEffect,
  livingTownPurchaseEffect,
  parseLivingTownDeployment,
  decodeLivingTownSnapshot,
} from "./wire.js";
import {
  canonicalLivingTownJson,
  livingTownJsonDigest,
  parseLivingTownJson,
} from "./json.js";

const name = (v: unknown): string => {
  check(
    typeof v === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.exec(v)?.[0] === v,
    "invalid V2 shop name",
  );
  return v;
};
export const livingTownCallArguments = {
  register_player: object({ command: livingTownCommand }),
  create_shop: object({ name, command: livingTownCommand }),
  rename_shop: object({
    shop_id: positiveU64,
    expected_shop_revision: positiveU64,
    name,
    command: livingTownCommand,
  }),
  buy_from_merchant: object({
    merchant_id: choice(["rex", "luna", "bolt"] as const),
    item_id: choice(["crystal", "wood", "herb", "iron"] as const),
    quantity: bounded(1n, 100n),
    expected_listing_revision: positiveU64,
    max_total_price: bounded(1n, 10000n),
    command: livingTownCommand,
  }),
};
export type LivingTownMethod = keyof typeof livingTownCallArguments;
export const livingTownGas = "100000000000000";
export function createLivingTownCall(
  method: LivingTownMethod,
  input: unknown,
): LivingTownCall {
  check(
    Object.hasOwn(livingTownCallArguments, method),
    "unsupported V2 mutation",
  );
  const args = livingTownCallArguments[method](input);
  // Return a detached deeply frozen public request, never a mutable caller object.
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
  };
  freeze(args);
  return Object.freeze({
    method,
    args,
    gas: livingTownGas,
    deposit: "0" as const,
  });
}
export type LivingTownCall = Readonly<{
  method: LivingTownMethod;
  args: ReturnType<(typeof livingTownCallArguments)[LivingTownMethod]>;
  gas: typeof livingTownGas;
  deposit: "0";
}>;
export type LivingTownResult = ReturnType<
  ReturnType<
    typeof livingTownSnapshot<
      | ReturnType<typeof livingTownOwnershipEffect>
      | ReturnType<typeof livingTownPurchaseEffect>
    >
  >
>;
export interface LivingTownWalletRequest {
  network: "testnet";
  signerId: string;
  receiverId: string;
  actions: {
    type: "FunctionCall";
    params: {
      methodName: LivingTownMethod;
      args: LivingTownCall["args"];
      gas: typeof livingTownGas;
      deposit: "0";
    };
  }[];
}
export async function livingTownCommandDigest(
  deployment: unknown,
  predecessor: string,
  call: LivingTownCall,
): Promise<string> {
  const d = parseLivingTownDeployment(deployment),
    actor = accountId(predecessor),
    c = createLivingTownCall(call.method, call.args);
  return livingTownJsonDigest({
    domain: "bot-bazaar:living-town:command:1",
    network_id: d.network_id,
    genesis_hash: d.genesis_hash,
    contract_id: d.contract_id,
    api_version: d.api_version,
    principal: `account:${actor}`,
    predecessor_account_id: actor,
    method: c.method,
    args: c.args,
  });
}
export function livingTownWalletRequest(
  contractId: string,
  signerId: string,
  input: LivingTownCall,
): LivingTownWalletRequest {
  const c = createLivingTownCall(input.method, input.args);
  return {
    network: "testnet" as const,
    signerId: accountId(signerId),
    receiverId: accountId(contractId),
    actions: [
      {
        type: "FunctionCall" as const,
        params: {
          methodName: c.method,
          args: c.args,
          gas: c.gas,
          deposit: c.deposit,
        },
      },
    ],
  };
}
export function decodeLivingTownBytes(value: unknown): unknown {
  check(
    Array.isArray(value) &&
      value.length <= 262144 &&
      value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
    "invalid V2 view bytes",
  );
  return parseLivingTownJson(
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value)),
  );
}
export function decodeLivingTownBase64(value: unknown): unknown {
  check(
    typeof value === "string" &&
      value.length <= 350000 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
    "invalid V2 base64",
  );
  return parseLivingTownJson(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value), (v) => v.charCodeAt(0)),
    ),
  );
}
export function decodeLivingTownResult(
  method: LivingTownMethod,
  value: unknown,
  deployment: unknown,
): LivingTownResult {
  return decodeLivingTownSnapshot(value, deployment, (v) =>
    method === "buy_from_merchant"
      ? livingTownPurchaseEffect(v)
      : livingTownOwnershipEffect(v),
  );
}
export async function verifyLivingTownEffect(
  value: unknown,
  deployment: unknown,
  signer: string,
  input: LivingTownCall,
): Promise<LivingTownResult> {
  const call = createLivingTownCall(input.method, input.args),
    result = decodeLivingTownResult(call.method, value, deployment),
    effect = result.data;
  const args = call.args as Record<string, unknown>,
    command = call.args.command;
  check(
    effect.principal === `account:${accountId(signer)}` &&
      effect.command_sequence === command.sequence &&
      effect.payload_sha256 ===
        (await livingTownCommandDigest(deployment, signer, call)),
    "V2 command effect binding mismatch",
  );
  const outcome = effect.outcome;
  if (call.method === "register_player")
    check(
      outcome.kind === "player_registered" &&
        outcome.player.shop_id === null &&
        outcome.player.ledger.gold.held === "100" &&
        Object.values(outcome.player.ledger.inventory.held).every(
          (v) => v === "0",
        ),
      "V2 registration effect mismatch",
    );
  if (call.method === "create_shop" || call.method === "rename_shop") {
    check(
      outcome.kind ===
        (call.method === "create_shop" ? "shop_created" : "shop_renamed"),
      "V2 shop effect mismatch",
    );
    check(
      "shop" in outcome &&
        outcome.shop.name === args["name"] &&
        (call.method === "create_shop"
          ? outcome.shop.revision === "1"
          : outcome.shop.shop_id === args["shop_id"] &&
            BigInt(outcome.shop.revision) ===
              BigInt(String(args["expected_shop_revision"])) + 1n),
      "V2 shop terms mismatch",
    );
  }
  if (call.method === "buy_from_merchant") {
    check(outcome.kind === "raw_purchased", "V2 purchase effect mismatch");
    check(
      outcome.trade.seller.merchant_id === args["merchant_id"] &&
        outcome.trade.item_id === args["item_id"] &&
        outcome.trade.quantity === args["quantity"] &&
        BigInt(outcome.trade.total_price) <=
          BigInt(String(args["max_total_price"])) &&
        BigInt(outcome.listing.revision) ===
          BigInt(String(args["expected_listing_revision"])) + 1n,
      "V2 purchase terms mismatch",
    );
  }
  check(
    BigInt(effect.effect_revision) <= BigInt(result.market_revision),
    "V2 future original effect",
  );
  if (!effect.replayed)
    check(
      effect.effect_revision === result.market_revision,
      "V2 first-effect revision mismatch",
    );
  return result;
}
export { canonicalLivingTownJson };
