import {
  accountId,
  check,
  choice,
  hash32,
  object,
  positiveU64,
  record,
} from "../wire.js";
import { createLivingTownCall } from "./calls.js";
import { createLivingTownCompletionCall } from "./completion.js";
import { parseLivingTownDeployment } from "./wire.js";
import type { LivingTownProof } from "./receipts.js";
import type { LivingTownCompletionProof } from "./completion.js";

/** Untrusted discovery hint only. No outcomes, balances, keys or signed bytes. */
export const playerReceiptMethods: readonly string[] = Object.freeze([
  "register_player",
  "create_shop",
  "rename_shop",
  "buy_from_merchant",
  "start_production",
  "complete_production",
  "set_listing",
  "cancel_listing",
  "set_assistant_permissions",
  "purchase_upgrade",
]);
export function playerReceiptProof(
  value: unknown,
): LivingTownProof | LivingTownCompletionProof {
  const input = record(value);
  const r = object({
    transactionHash: hash32,
    signerId: accountId,
    deployment: parseLivingTownDeployment,
    referenceBlockHeight: positiveU64,
    ...(Object.hasOwn(input, "gas")
      ? { gas: choice(["30000000000000", "100000000000000"] as const) } : {}),
    call: (value: unknown) => {
      const c = record(value);
      check(
        Object.keys(c).sort().join() === "args,deposit,gas,method",
        "invalid player call",
      );
      check(
        playerReceiptMethods.includes(String(c["method"])),
        "player method required",
      );
      const call =
        c["method"] === "complete_production"
          ? createLivingTownCompletionCall(c["args"])
          : createLivingTownCall(
              c["method"] as Parameters<typeof createLivingTownCall>[0],
              c["args"],
            );
      check(
        c["gas"] === call.gas && c["deposit"] === call.deposit,
        "player call mismatch",
      );
      return call;
    },
  })(value);
  return r as LivingTownProof | LivingTownCompletionProof;
}
