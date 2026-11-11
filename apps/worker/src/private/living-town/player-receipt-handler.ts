import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoundaryConfig } from "../read-api/config.js";
import { ReadLimits } from "../read-api/limits.js";
import { PlayerReceiptError } from "./player-receipts.js";
import type { PlayerReceipts } from "./player-receipts.js";

export function playerReceiptHandler(
  queue: Pick<PlayerReceipts, "receive">,
  config: BoundaryConfig,
) {
  const limits = new ReadLimits({
    ...config,
    clientPerMinute: Math.min(30, config.clientPerMinute),
    globalPerSecond: Math.min(3, config.globalPerSecond),
  });
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    const admission = limits.admit(req);
    if (!admission.ok) {
      reply(admission.status, { error: admission.code });
      return;
    }
    res.once("close", admission.release);
    res.once("finish", admission.release);
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (typeof origin !== "string" || !config.allowedOrigins.includes(origin)) {
      reply(403, { error: "origin_denied" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      reply(204, null);
      return;
    }
    if (req.method !== "POST") {
      reply(405, { error: "method_not_allowed" });
      return;
    }
    if (
      req.headers["content-type"] !== "application/json" ||
      req.headers["content-encoding"] ||
      Number(req.headers["content-length"] ?? 0) > 16384
    ) {
      reply(413, { error: "invalid_proof_body" });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 16384) {
          reply(413, { error: "proof_too_large" });
          return;
        }
        chunks.push(bytes);
      }
      const result = queue.receive(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      reply(result.status === "queued" ? 202 : 200, result);
    } catch (error) {
      if (error instanceof PlayerReceiptError)
        reply(error.status, { error: error.code });
      else if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.name === "ChainValidationError")
      )
        reply(422, { error: "invalid_player_proof" });
      else reply(503, { error: "proof_handoff_unavailable" });
    }
  };
}
