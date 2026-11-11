// Offline discovery import only: no signing, RPC, inference or server startup.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  playerReceiptProof,
  playerReceiptMethods,
} from "../packages/chain/dist/index.js";
import {
  readBoundedFile,
  parseLivingTownWorkerConfig,
} from "../apps/worker/dist/private/living-town/config.js";
import { PlayerReceipts } from "../apps/worker/dist/private/living-town/player-receipts.js";

export function capturedPlayerProofs(records, identity) {
  if (!Array.isArray(records) || records.length > 100)
    throw new Error("bounded transactions array required");
  const reference = (r) =>
    r.reference_block_height ??
    r.before?.block?.height ??
    r.before?.town?.block_height;
  return records
    .filter(
      (r) => playerReceiptMethods.includes(r.method) && r.args && reference(r),
    )
    .map((r) => {
      if (r.receiver_id !== identity.deployment.contract_id)
        throw new Error("capture deployment mismatch");
      return playerReceiptProof({
        transactionHash: r.transaction_hash,
        signerId: r.signer_id,
        deployment: identity.deployment,
        referenceBlockHeight: reference(r),
        call:
          r.method === "complete_production"
            ? createLivingTownCompletionCall(r.args)
            : createLivingTownCall(r.method, r.args),
      });
    });
}
export async function main(args) {
  if (
    ![4, 5].includes(args.length) ||
    args[0] !== "--config" ||
    args[2] !== "--transactions" ||
    (args[4] && args[4] !== "--enqueue")
  )
    throw new Error(
      "Usage: node scripts/living-town-import-player-receipts.mjs --config <reader.json> --transactions <transactions.json> [--enqueue]",
    );
  const config = parseLivingTownWorkerConfig(
    readBoundedFile(resolve(args[1]), 32768),
  );
  const records = readBoundedFile(resolve(args[3]), 2097152);
  const proofs = capturedPlayerProofs(records, config.identity);
  const queue = args[4]
    ? new PlayerReceipts(config.dataDir, config.identity)
    : null;
  try {
    const results = proofs.map((proof) => ({
      transaction_hash: proof.transactionHash,
      method: proof.call.method,
      ...(queue ? queue.requeueExpired(proof) : { status: "checked_only" }),
    }));
    console.log(
      JSON.stringify(
        {
          results,
          skipped_without_player_metadata: records.length - proofs.length,
          note: "Discovery only; the running reader must independently verify and archive each receipt.",
        },
        null,
        2,
      ),
    );
    return results;
  } finally {
    queue?.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main(process.argv.slice(2));
