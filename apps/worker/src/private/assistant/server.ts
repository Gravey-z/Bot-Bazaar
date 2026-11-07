import { createServer } from "node:http";
import type { Server } from "node:http";
import { parseLivingTownJson } from "@bot-bazaar/chain";
import { AssistantAuth, AssistantAuthError } from "./auth.js";
import { ReadLimits } from "../read-api/limits.js";

/** Separate private boundary; no economic signer, model or public-read capabilities. */
export function createAssistantServer(auth: AssistantAuth): Server {
  const limits = new ReadLimits({
    allowedOrigins: [auth.origin],
    trustedProxyIps: [],
    clientPerMinute: 6,
    globalPerSecond: 2,
  });
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    (req, res) => {
      void (async () => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; frame-ancestors 'none'",
        );
        const send = (status: number, data: unknown): void => {
          res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify(data));
        };
        try {
          const admission = limits.admit(req);
          if (!admission.ok) {
            res.setHeader("Retry-After", String(admission.retryAfter));
            send(admission.status, { error: "request_limited" });
            return;
          }
          res.once("finish", admission.release);
          res.once("close", admission.release);
          // Bearer-only, no cookies. Private operations use POST with exact Origin.
          if (
            req.headers.origin !== auth.origin ||
            req.headers.cookie !== undefined
          )
            throw new AssistantAuthError(403);
          res.setHeader("Access-Control-Allow-Origin", auth.origin);
          res.setHeader("Vary", "Origin");
          if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.setHeader(
              "Access-Control-Allow-Headers",
              "Authorization, Content-Type",
            );
            res.writeHead(204);
            res.end();
            return;
          }
          const route = req.url ?? "";
          if (route.length > 256 || route.includes("?") || route.includes("#"))
            throw new AssistantAuthError(400);
          const authorization = req.headers.authorization ?? "";
          const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
            authorization,
          )?.[1];
          const scope =
            /^\/private\/assistant\/shops\/([1-9][0-9]{0,19})\/scope$/.exec(
              route,
            );
          if (
            req.method !== "POST" ||
            (!scope &&
              ![
                "/private/assistant/challenge",
                "/private/assistant/verify",
                "/private/assistant/logout",
              ].includes(route))
          )
            throw new AssistantAuthError(404);
          if (req.headers["content-type"] !== "application/json")
            throw new AssistantAuthError(415);
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 4096) throw new AssistantAuthError(413);
            chunks.push(Buffer.from(chunk));
          }
          const body: unknown = parseLivingTownJson(
            Buffer.concat(chunks).toString("utf8"),
          );
          const keys = route.endsWith("/challenge")
            ? ["accountId", "shopId"]
            : route.endsWith("/verify")
              ? ["id", "accountId", "publicKey", "signature"]
              : [];
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).sort().join() !== [...keys].sort().join() ||
            Object.values(body).some(
              (v) => typeof v !== "string" || v.length > 512,
            )
          )
            throw new AssistantAuthError(400);
          const b = body as Record<string, string>;
          if (scope) {
            if (!bearer) throw new AssistantAuthError(401);
            send(200, await auth.scope(bearer, scope[1]!));
            return;
          }
          if (route.endsWith("/challenge"))
            send(200, auth.challenge(b["accountId"]!, b["shopId"]!));
          else if (route.endsWith("/verify")) {
            const session = await auth.verify({
              id: b["id"]!,
              accountId: b["accountId"]!,
              publicKey: b["publicKey"]!,
              signature: b["signature"]!,
            });
            if (bearer) auth.revoke(bearer);
            send(200, session);
          } else {
            if (!bearer) throw new AssistantAuthError(401);
            auth.revoke(bearer);
            send(200, { loggedOut: true });
          }
        } catch (error) {
          if (!res.headersSent)
            send(error instanceof AssistantAuthError ? error.status : 400, {
              error: "private_request_rejected",
            });
        }
      })();
    },
  );
  server.maxConnections = 32;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 40;
  server.setTimeout(5000, (socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    else socket.destroy();
  });
  return server;
}
