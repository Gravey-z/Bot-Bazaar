import { LivingTownStreams } from "./streams.js";
import type { livingTownActivityPage } from "@bot-bazaar/chain";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActivityPage } from "@bot-bazaar/shared";
import { parseU64, merchantContextMaxBytes } from "@bot-bazaar/chain";
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
    events?: (
      after: string | null,
      limit: number,
    ) => ReturnType<typeof livingTownActivityPage>;
    town: () => unknown;
    offers?: () => unknown;
    gameView?: (account: string) => unknown;
    merchantContext?: () => unknown;
    directory?: (after: string | null, limit: number) => unknown;
    shop: (id: string) => unknown;
    inventory: (id: string) => unknown;
    listings?: (after: string | null, limit: number) => unknown;
    history?: (id: string, after: string | null, limit: number) => unknown;
    production: (id: string, after: string | null, limit: number) => unknown;
  }>;
}
// Only read capabilities enter the HTTP handler. Provider, scheduler, credentials
// and transaction methods are absent from this interface.
export function createReadHandler(
  read: ReadCapabilities,
  config: BoundaryConfig = defaultBoundary,
  clock?: () => number,
): ((request: IncomingMessage, response: ServerResponse) => void) & {
  closeStreams: () => void;
} {
  const limits = new ReadLimits(config, clock);
  const streams = new LivingTownStreams();
  return Object.assign(
    (request: IncomingMessage, response: ServerResponse) => {
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
        const shopRoute =
          /^\/api\/shops\/([1-9][0-9]{0,19})(\/(?:inventory|production|history))?$/.exec(
            url.pathname,
          );
        const eventRoute =
          !!read.livingTown?.events &&
          ["/api/events", "/api/events/stream"].includes(url.pathname);
        const streamRoute = eventRoute && url.pathname === "/api/events/stream";
        const townRoute = url.pathname === "/api/town";
        const merchantContextRoute = !!read.livingTown?.merchantContext && url.pathname === "/api/merchant-context";
        const directoryRoute = !!read.livingTown?.directory && url.pathname === "/api/shops";
        const gameViewRoute = !!read.livingTown?.gameView && url.pathname === "/api/game-view";
        const offerRoute =
          !!read.livingTown?.offers && url.pathname === "/api/merchant-offers";
        const productionRoute =
          !!read.livingTown && shopRoute?.[2] === "/production";
        const historyRoute =
          !!read.livingTown?.history && shopRoute?.[2] === "/history";
        const marketRoute =
          !!read.livingTown?.listings &&
          url.pathname === "/api/market/listings";
        const pagedRoute =
          productionRoute || historyRoute || marketRoute || eventRoute || directoryRoute;
        const projectionRoute =
          !!read.livingTown &&
          (merchantContextRoute || directoryRoute || gameViewRoute || eventRoute ||
            offerRoute ||
            townRoute ||
            marketRoute ||
            (!!shopRoute && (shopRoute[2] !== "/history" || historyRoute)));
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
          gameViewRoute
            ? [...url.searchParams.keys()].some(key => key !== "account") ||
              url.searchParams.getAll("account").length !== 1
            : url.pathname === "/health" || (projectionRoute && !pagedRoute)
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
        const productionAfter = url.searchParams.get("after");
        if (
          pagedRoute &&
          productionAfter !== null &&
          !/^[A-Za-z0-9_-]{1,1024}$/.test(productionAfter)
        )
          throw new ReadApiError(400, "invalid_query");
        if (streamRoute && url.searchParams.has("limit"))
          throw new ReadApiError(400, "invalid_query");
        if (request.method === "OPTIONS") {
          const method = request.headers["access-control-request-method"],
            headers = request.headers["access-control-request-headers"];
          if (
            !allowedOrigin ||
            (method !== "GET" && method !== "HEAD") ||
            (headers !== undefined &&
              (typeof headers !== "string" ||
                !(
                  (streamRoute ? ["accept", "last-event-id"] : ["accept"]).join(
                    ",",
                  ) ===
                    headers
                      .toLowerCase()
                      .split(",")
                      .map((h) => h.trim())
                      .sort()
                      .join(",") ||
                  headers.toLowerCase().trim() === "accept" ||
                  (streamRoute &&
                    headers.toLowerCase().trim() === "last-event-id")
                )))
          ) {
            send(400, { error: "invalid_preflight" });
            return;
          }
          response.writeHead(204, {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Allow-Methods": "GET, HEAD",
            ...(headers
              ? {
                  "Access-Control-Allow-Headers": streamRoute
                    ? "Accept, Last-Event-ID"
                    : "Accept",
                }
              : {}),
            "Access-Control-Max-Age": "300",
          });
          response.end();
          return;
        }
        if (streamRoute) {
          const rawId = request.headers["last-event-id"];
          if (
            rawId !== undefined &&
            (typeof rawId !== "string" ||
              rawId.length === 0 ||
              request.rawHeaders.filter(
                (v, i) => i % 2 === 0 && v.toLowerCase() === "last-event-id",
              ).length !== 1 ||
              (productionAfter !== null && productionAfter !== rawId))
          )
            throw new ReadApiError(400, "invalid_cursor");
          const after = (rawId as string | undefined) ?? productionAfter;
          if (request.method === "HEAD") {
            read.livingTown!.events!(after, 1);
            response.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
            });
            response.end();
            return;
          }
          // Streaming responses have their own connection budget and must leave
          // short read slots available for polling and transaction reconciliation.
          admission.release();
          streams.open(
            request,
            response,
            read.livingTown!.events!,
            after,
            admission.address,
          );
          return;
        }
        let value: unknown, status: number;
        if (url.pathname === "/health") {
          const health = read.health();
          value = health;
          status = health.status === "ready" ? 200 : 503;
        } else if (projectionRoute) {
          value = merchantContextRoute
            ? read.livingTown!.merchantContext!()
            : directoryRoute
            ? read.livingTown!.directory!(productionAfter, Number(limitText))
            : gameViewRoute
            ? read.livingTown!.gameView!(url.searchParams.get("account")!)
            : offerRoute
            ? read.livingTown!.offers!()
            : eventRoute
              ? read.livingTown!.events!(productionAfter, Number(limitText))
              : marketRoute
                ? read.livingTown!.listings!(productionAfter, Number(limitText))
                : historyRoute
                  ? read.livingTown!.history!(
                      shopRoute![1]!,
                      productionAfter,
                      Number(limitText),
                    )
                  : townRoute
                    ? read.livingTown!.town()
                    : productionRoute
                      ? read.livingTown!.production(
                          shopRoute![1]!,
                          productionAfter,
                          Number(limitText),
                        )
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
          Buffer.byteLength(JSON.stringify(value)) > (merchantContextRoute ? merchantContextMaxBytes : 262144)
        )
          throw new ReadApiError(503, "read_unavailable");
        send(status, value);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (error instanceof ReadApiError) {
          if (
            (request.url ?? "").startsWith("/api/events") &&
            [
              "feed_retention_gap",
              "feed_generation_mismatch",
              "cursor_deployment_mismatch",
            ].includes(error.code)
          ) {
            send(error.status, { error: error.code, reset_required: true });
            return;
          }
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
    },
    { closeStreams: () => streams.close() },
  );
}
