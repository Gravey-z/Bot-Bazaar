import { livingTownJsonDigest } from "@bot-bazaar/chain";
import type { LivingTownTransactions } from "./living-town-transactions";

/** Existing refreshes drive retries; never opens a wallet or signs a transaction. */
export function receiptHandoff(
  journal: Pick<LivingTownTransactions, "receiptProofs" | "acknowledgeReceipt">,
  workerUrl: string,
  fetcher: typeof fetch,
  now: () => number = Date.now,
) {
  let running: Promise<void> | undefined,
    nextAt = 0,
    failures = 0,
    offset = 0;
  return (): Promise<void> => {
    if (running) return running;
    if (!workerUrl || now() < nextAt) return Promise.resolve();
    running = (async () => {
      try {
        const proofs = await journal.receiptProofs();
        const selected = Array.from(
          { length: Math.min(3, proofs.length) },
          (_, i) => proofs[(offset + i) % proofs.length]!,
        );
        offset += selected.length;
        for (const proof of selected) {
          const response = await fetcher(
            new URL("/api/player-receipts", workerUrl),
            {
              method: "POST",
              credentials: "omit",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(proof),
              signal: AbortSignal.timeout(5000),
            },
          );
          if (!response.ok) throw new Error("Receipt handoff unavailable");
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Missing handoff acknowledgement");
          let text = "";
          try {
            const decoder = new TextDecoder();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              text += decoder.decode(chunk.value, { stream: true });
              if (text.length > 1024)
                throw new Error("Invalid handoff acknowledgement");
            }
          } finally {
            await reader.cancel();
          }
          const result = JSON.parse(text);
          if (result.id !== (await livingTownJsonDigest(proof)))
            throw new Error("Receipt acknowledgement mismatch");
          // A durable queue acknowledgement alone does not establish verification.
          if (result.status === "indexed")
            await journal.acknowledgeReceipt(proof);
          else if (result.status !== "queued")
            throw new Error("Receipt requires recovery");
        }
        failures = 0;
        nextAt = now() + 10000;
      } catch {
        nextAt = now() + Math.min(300000, 5000 * 2 ** Math.min(++failures, 6));
        // Keep original proofs for reload/retry. Chain success and wallet state
        // are independent of reader reachability.
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
}
