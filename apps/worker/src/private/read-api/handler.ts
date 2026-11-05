import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActivityPage } from "@bot-bazaar/shared";
import { parseU64 } from "@bot-bazaar/chain";
import type { LivingTownHealth } from "../living-town/health.js";
import type { HealthPage } from "./health.js";
import { ReadApiError } from "../activity/repository.js";
import { defaultBoundary } from "./config.js";
import type { BoundaryConfig } from "./config.js";
import { ReadLimits } from "./limits.js";
export interface ReadCapabilities {
  health: () => HealthPage | LivingTownHealth;
  activity: (after: string | undefined, limit: number) => ActivityPage;
  livingTown?: Readonly<{
    town: () => unknown;
    shop: (id: string) => unknown;
    inventory: (id: string) => unknown;
  }>;
}
// Only read capabilities enter the HTTP handler. Provider, scheduler, credentials
// and transaction methods are absent from this interface.
export function createReadHandler(
  read: ReadCapabilities,
  config: BoundaryConfig = defaultBoundary,
  clock?: () => number,
): (request: IncomingMessage, response: ServerResponse) => void {
  const limits = new ReadLimits(config, clock);
  return (request, response) => {
    const started = performance.now();
    const origin = request.headers.origin;
    const allowedOrigin =
      typeof origin === "string" && config.allowedOrigins.includes(origin)
        ? origin
        : null;
    response.setHeader(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (allowedOrigin) {
      response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      response.setHeader("Access-Control-Expose-Headers", "Retry-After");
    }
    const send = (status: number, value: unknown, allow = false) => {
      const encoded = JSON.stringify(value);
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": Buffer.byteLength(encoded),
        ...(allow ? { Allow: "GET, HEAD, OPTIONS" } : {}),
      });
      response.end(request.method === "HEAD" ? undefined : encoded);
    };
    try {
      const admission = limits.admit(request);
      if (!admission.ok) {
        response.setHeader("Connection", "close");
        if (admission.retryAfter)
          response.setHeader("Retry-After", String(admission.retryAfter));
        send(admission.status, { error: admission.code });
        return;
      }
      response.once("finish", admission.release);
      response.once("close", admission.release);
      if (origin !== undefined && !allowedOrigin) {
        response.setHeader("Connection", "close");
        send(403, { error: "origin_not_allowed" });
        return;
      }
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
      const shopRoute = /^\/api\/shops\/([1-9][0-9]{0,19})(\/inventory)?$/.exec(
        url.pathname,
      );
      const townRoute = url.pathname === "/api/town";
      const projectionRoute = !!read.livingTown && (townRoute || !!shopRoute);
      if (projectionRoute && raw.split("?")[0] !== url.pathname)
        throw new ReadApiError(400, "invalid_query");
      if (shopRoute) {
        try {
          parseU64(shopRoute[1]);
        } catch {
          throw new ReadApiError(400, "invalid_query");
        }
      }
      if (
        url.pathname !== "/health" &&
        url.pathname !== "/activity" &&
        !projectionRoute
      ) {
        send(404, { error: "not_found" });
        return;
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) {
        response.setHeader("Connection", "close");
        request.resume();
        send(405, { error: "method_not_allowed" }, true);
        return;
      }
      if (
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0")
      ) {
        response.setHeader("Connection", "close");
        send(400, { error: "request_body_not_allowed" });
        return;
      }
      // Validate the query even for preflight, before any read callback.
      if (
        url.pathname === "/health" || projectionRoute
          ? [...url.searchParams].length !== 0
          : [...url.searchParams.keys()].some(
              (key) => key !== "after" && key !== "limit",
            ) ||
            url.searchParams.getAll("after").length > 1 ||
            url.searchParams.getAll("limit").length > 1
      )
        throw new ReadApiError(400, "invalid_query");
      const limitText = url.searchParams.get("limit") ?? "20";
      if (!/^[1-9][0-9]?$/.test(limitText) || Number(limitText) > 50)
        throw new ReadApiError(400, "invalid_query");
      if (request.method === "OPTIONS") {
        const method = request.headers["access-control-request-method"],
          headers = request.headers["access-control-request-headers"];
        if (
          !allowedOrigin ||
          (method !== "GET" && method !== "HEAD") ||
          (headers !== undefined &&
            (typeof headers !== "string" ||
              headers.toLowerCase().trim() !== "accept"))
        ) {
          send(400, { error: "invalid_preflight" });
          return;
        }
        response.writeHead(204, {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Access-Control-Allow-Methods": "GET, HEAD",
          ...(headers ? { "Access-Control-Allow-Headers": "Accept" } : {}),
          "Access-Control-Max-Age": "300",
        });
        response.end();
        return;
      }
      let value: unknown, status: number;
      if (url.pathname === "/health") {
        const health = read.health();
        value = health;
        status = health.status === "ready" ? 200 : 503;
      } else if (projectionRoute) {
        value = townRoute
          ? read.livingTown!.town()
          : shopRoute![2]
            ? read.livingTown!.inventory(shopRoute![1]!)
            : read.livingTown!.shop(shopRoute![1]!);
        status = 200;
      } else {
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
