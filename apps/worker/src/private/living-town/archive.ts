import { gunzipSync } from "node:zlib";
import {
  canonicalLivingTownJson,
  createLivingTownCall,
  createLivingTownCompletionCall,
  parseLivingTownIdentity,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
} from "@bot-bazaar/chain";
import type {
  FinalizedBlock,
  LivingTownProof,
  LivingTownCompletionProof,
} from "@bot-bazaar/chain";
import { requireStorage, sha256 } from "../storage/validation.js";
import type { LivingTownProjectionStore } from "./store.js";

/** A checksum protects archive bytes; this independent verifier authenticates chain identity/finality. */
export async function replayLivingTownArchive(
  value: { body: string; sha256: string },
  store: LivingTownProjectionStore,
  verifyHistoricalBlock: (hash: string) => Promise<FinalizedBlock>,
): Promise<number> {
  requireStorage(
    Buffer.byteLength(value.body) <= 16 * 1024 * 1024 &&
      sha256(value.body) === value.sha256,
    "invalid receipt archive checksum/size",
  );
  const archive = JSON.parse(value.body) as {
    schema: string;
    identity: unknown;
    entries: {
      proof: LivingTownProof | LivingTownCompletionProof;
      response_gzip_base64: string;
    }[];
  };
  requireStorage(
    archive.schema === "living-town-receipt-archive-v1" &&
      canonicalLivingTownJson(parseLivingTownIdentity(archive.identity)) ===
        canonicalLivingTownJson(store.identity) &&
      Array.isArray(archive.entries) &&
      archive.entries.length <= 25,
    "archive identity/bound mismatch",
  );
  let indexed = 0;
  for (const entry of archive.entries) {
    requireStorage(
      typeof entry.response_gzip_base64 === "string" &&
        entry.response_gzip_base64.length <= 350000,
      "invalid archive proof size",
    );
    const bytes = Buffer.from(entry.response_gzip_base64, "base64");
    requireStorage(
      bytes.toString("base64") === entry.response_gzip_base64,
      "invalid archive proof encoding",
    );
    const response: unknown = JSON.parse(
      gunzipSync(bytes, { maxOutputLength: 1048576 }).toString("utf8"),
    );
    const proof = entry.proof;
    requireStorage(
      canonicalLivingTownJson(proof.deployment) ===
        canonicalLivingTownJson(store.identity.deployment),
      "archive proof deployment mismatch",
    );
    let record;
    if (proof.call.method === "complete_production") {
      const p = {
        ...proof,
        call: createLivingTownCompletionCall(proof.call.args),
      } as LivingTownCompletionProof;
      record = livingTownIndexedCompletion(p, {
        status: await verifyLivingTownCompletionReceipt(
          response,
          p,
          verifyHistoricalBlock,
        ),
        response,
      });
    } else {
      const p = {
        ...proof,
        call: createLivingTownCall(proof.call.method, proof.call.args),
      } as LivingTownProof;
      record = livingTownIndexedReceipt(p, {
        status: await verifyLivingTownReceipt(
          response,
          p,
          verifyHistoricalBlock,
        ),
        response,
      });
    }
    requireStorage(record, "archive contains unresolved receipt");
    if (store.commit(record) === "indexed") indexed++;
  }
  return indexed;
}
