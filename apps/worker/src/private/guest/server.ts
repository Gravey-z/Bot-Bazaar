import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ReadLimits } from "../read-api/limits.js";
import { GuestError, GuestStore } from "./store.js";
import type { GuestConfig } from "./config.js";
import { guestActionRequest } from "@bot-bazaar/chain";

const cookieName = "__Host-bazaar-guest";
function token(req: IncomingMessage, preferredName: string): string | null {
  const cookies = req.headers.cookie;
  if (!cookies || cookies.length > 4096) return null;
  const parts = cookies.split(";").map(v => v.trim());
  // Keep existing HTTPS-style local sessions recoverable during the transition.
  const name = preferredName !== cookieName && parts.some(v => v.startsWith(preferredName + "=")) ? preferredName : cookieName;
  const matches = parts.filter(v => v.startsWith(name + "="));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function equal(a: unknown, b: string): boolean {
  return typeof a === "string" && /^[a-f0-9]{64}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function createGuestServer(config: GuestConfig, store: GuestStore) {
  const originUrl = new URL(config.origin);
  const localHttp = originUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname);
  const sessionName = localHttp ? "bazaar-guest-local" : cookieName;
  const sessionCookie = (raw: string, maxAge: number): string =>
    `${sessionName}=${raw}; Path=/; Max-Age=${maxAge}; HttpOnly;${localHttp ? "" : " Secure;"} SameSite=Lax`;
  const limits = new ReadLimits(config.boundary);
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.end(JSON.stringify(value));
    };
    try {
      const admission = limits.admit(req);
      if (!admission.ok) { res.setHeader("Retry-After", admission.retryAfter); reply(admission.status, { error: "guest_rate_limited" }); return; }
      res.once("close", admission.release); res.once("finish", admission.release);
      if (req.url === "/health" && req.method === "GET") {
        reply(store.fundingBlocked() ? 503 : 200, { role: "guest_custody", fundingBlocked: store.fundingBlocked() }); return;
      }
      const route = req.url;
      const activityRoute = /^\/api\/guest\/activity(?:\?before=([1-9][0-9]{0,12}))?$/.exec(route ?? "");
      const actionId = /^\/api\/guest\/actions\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(route ?? "")?.[1];
      if (!actionId && !activityRoute && !["/api/guest/me", "/api/guest/start", "/api/guest/logout", "/api/guest/actions"].includes(route ?? ""))
        throw new GuestError(404, "guest_route_not_found");
      res.setHeader("Vary", "Origin");
      const origin = req.headers.origin;
      // Same-origin fetch GETs may omit Origin. Cross-origin GETs and every
      // mutation must supply the single configured origin; no wildcard cookies.
      if (origin !== config.origin && !(req.method === "GET" && origin === undefined && req.headers["sec-fetch-site"] === "same-origin"))
        throw new GuestError(403, "guest_origin_denied");
      if (origin === config.origin) {
        res.setHeader("Access-Control-Allow-Origin", config.origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      if (req.method === "OPTIONS") {
        if (!["GET", "POST"].includes(String(req.headers["access-control-request-method"])))
          throw new GuestError(405, "guest_method_not_allowed");
        const requested = String(req.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
        if (requested.some(s => !["content-type", "x-guest-csrf", "x-guest-id"].includes(s))) throw new GuestError(403, "guest_headers_denied");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Guest-CSRF, X-Guest-Id");
        res.writeHead(204); res.end(); return;
      }
      let raw = token(req, sessionName), session = raw ? store.session(raw) : null;
      if ((actionId || activityRoute || route === "/api/guest/actions") &&
        (!session?.guestId || req.headers["x-guest-id"] !== session.guestId))
        throw new GuestError(409, "guest_session_changed");
      if (route === "/api/guest/me" && req.method === "GET") {
        if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) !== 0)
          throw new GuestError(400, "guest_body_not_allowed");
        if (!session) {
          const created = store.newSession(store.vault.hmac(`ip:${admission.address}`));
          raw = created.token; session = store.session(raw)!;
        }
        res.setHeader("Set-Cookie", sessionCookie(raw!, Math.max(0, Math.floor((session.expires - Date.now()) / 1000))));
        const csrf = store.vault.hmac(`csrf:${config.origin}:${session.hash}`);
        reply(200, { identity: config.profile.identity, guest: store.publicGuest(session.guestId), csrfToken: csrf, expiresAt: session.expires,
          notice: "Guest progress is temporary. Losing this browser session loses access." }); return;
      }
      if (activityRoute && req.method === "GET") {
        if (!session?.guestId) throw new GuestError(401, "guest_session_required");
        reply(200, { activity: store.activity(session.guestId, activityRoute[1] ?? null) }); return;
      }
      if (actionId && req.method === "GET") {
        if (!session?.guestId) throw new GuestError(401, "guest_session_required");
        const action = store.action(session.guestId, actionId);
        if (!action) throw new GuestError(404, "guest_action_not_found");
        reply(200, { action: store.publicAction(action) }); return;
      }
      if (req.method !== "POST" || route === "/api/guest/me") throw new GuestError(405, "guest_method_not_allowed");
      if (actionId || activityRoute) throw new GuestError(405, "guest_method_not_allowed");
      if (!session) throw new GuestError(401, "guest_session_required");
      if (!equal(req.headers["x-guest-csrf"], store.vault.hmac(`csrf:${config.origin}:${session.hash}`)))
        throw new GuestError(403, "guest_csrf_required");
      if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"])
        throw new GuestError(415, "guest_json_required");
      if (Number(req.headers["content-length"] ?? 0) > 4096) throw new GuestError(413, "guest_body_too_large");
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 4096) throw new GuestError(413, "guest_body_too_large");
        chunks.push(bytes);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new GuestError(400, "guest_invalid_json"); }
      if (route === "/api/guest/actions") {
        if (!session.guestId) throw new GuestError(401, "guest_account_required");
        let command;
        try { command = guestActionRequest(body); } catch { throw new GuestError(400, "guest_action_invalid"); }
        const action = store.enqueueAction(session.guestId, command);
        reply(["confirmed", "failed"].includes(action.status) ? 200 : 202, { action: store.publicAction(action) }); return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
        throw new GuestError(400, "guest_empty_command_required");
      if (route === "/api/guest/logout") {
        store.revoke(session.hash); res.setHeader("Set-Cookie", sessionCookie("", 0)); reply(200, { loggedOut: true }); return;
      }
      const guest = store.start(session.hash, store.vault.hmac(`ip:${admission.address}`));
      reply(guest.status === "active" ? 200 : guest.status === "provisioning" ? 202 : 409, { guest: store.publicGuest(guest.id) });
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      if (error instanceof GuestError) reply(error.status, { error: error.code });
      else reply(503, { error: "guest_service_unavailable" });
    }
  };
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000,
    keepAliveTimeout: 5000 }, (req, res) => { void handler(req, res); });
  server.maxHeadersCount = 32; server.maxConnections = 32; server.maxRequestsPerSocket = 50;
  server.setTimeout(5000, socket => socket.destroy());
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  return server;
}
