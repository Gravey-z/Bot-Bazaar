import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActivityPage } from "@bot-bazaar/shared";
import type { HealthPage } from "./health.js";
import { ReadApiError } from "../activity/repository.js";
export interface ReadCapabilities {
  health: () => HealthPage;
  activity: (after: string | undefined, limit: number) => ActivityPage;
}
// Only read capabilities enter the HTTP handler. Provider, scheduler, credentials
// and transaction methods are absent from this interface.
export function createReadHandler(
  read: ReadCapabilities,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const started = performance.now();
    const send = (status: number, value: unknown, allow = false) => {
      const encoded = JSON.stringify(value);
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": Buffer.byteLength(encoded),
        ...(allow ? { Allow: "GET, HEAD" } : {}),
      });
      response.end(request.method === "HEAD" ? undefined : encoded);
    };
    try {
      const raw = request.url ?? "";
      if (
        Buffer.byteLength(raw) > 4096 ||
        !raw.startsWith("/") ||
        raw.startsWith("//")
      )
        throw new ReadApiError(400, "invalid_query");
      const url = new URL(raw, "http://worker.invalid");
      if (url.origin !== "http://worker.invalid" || url.hash !== "")
        throw new ReadApiError(400, "invalid_query");
      if (url.pathname !== "/health" && url.pathname !== "/activity") {
        send(404, { error: "not_found" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        request.resume();
        send(405, { error: "method_not_allowed" }, true);
        return;
      }
      let value: HealthPage | ActivityPage, status: number;
      if (url.pathname === "/health") {
        if ([...url.searchParams].length !== 0)
          throw new ReadApiError(400, "invalid_query");
        value = read.health();
        status = 503;
      } else {
        if (
          [...url.searchParams.keys()].some(
            (key) => key !== "after" && key !== "limit",
          ) ||
          url.searchParams.getAll("after").length > 1 ||
          url.searchParams.getAll("limit").length > 1
        )
          throw new ReadApiError(400, "invalid_query");
        const limitText = url.searchParams.get("limit") ?? "20";
        if (!/^[1-9][0-9]?$/.test(limitText) || Number(limitText) > 50)
          throw new ReadApiError(400, "invalid_query");
        value = read.activity(
          url.searchParams.get("after") ?? undefined,
          Number(limitText),
        );
        status = 200;
      }
      if (
        performance.now() - started > 5000 ||
        Buffer.byteLength(JSON.stringify(value)) > 262144
      )
        throw new ReadApiError(503, "read_unavailable");
      send(status, value);
    } catch (error) {
      if (error instanceof ReadApiError) {
        if (error.code === "feed_generation_mismatch") {
          try {
            const health = read.health();
            send(409, {
              error: error.code,
              reset_required: true,
              deployment: health.deployment,
              feed_generation: health.feed_generation,
              captured_at: health.captured_at,
            });
          } catch {
            send(409, { error: error.code, reset_required: true });
          }
        } else send(error.status, { error: error.code });
      } else send(503, { error: "read_unavailable" });
    }
  };
}
