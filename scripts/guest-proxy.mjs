import { request as httpRequest } from "node:http";

/** Optional, fixed-loopback guest route for local previews. Starts no service. */
export function guestProxy(targetValue) {
  if (!targetValue) return (incoming, outgoing) => {
    if (!incoming.url?.startsWith("/api/guest/")) return false;
    outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    outgoing.end('{"error":"guest_not_configured"}');
    return true;
  };
  const target = new URL(targetValue);
  if (target.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname) ||
    target.username || target.password || target.pathname !== "/" || target.search || target.hash)
    throw Error("GUEST_API_URL must be a fixed loopback HTTP origin");
  return (incoming, outgoing) => {
    if (!/^\/api\/guest\/(?:me|start|logout|actions(?:\/[a-f0-9-]{36})?|activity(?:\?before=[1-9][0-9]{0,12})?)$/.test(incoming.url ?? "")) return false;
    let size = 0, finished = false;
    const fail = () => {
      if (finished) return; finished = true;
      if (!outgoing.headersSent) outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      outgoing.end('{"error":"guest_service_unavailable"}');
    };
    if (incoming.socket.localPort === Number(target.port || 80)) { fail(); return true; }
    const headers = { ...incoming.headers, host: target.host };
    delete headers["x-forwarded-for"]; delete headers["x-forwarded-host"]; delete headers["x-forwarded-proto"];
    delete headers.authorization; delete headers.connection;
    if (headers.cookie) headers.cookie = headers.cookie.split(";").map(v => v.trim())
      .filter(v => v.startsWith("__Host-bazaar-guest=") || v.startsWith("bazaar-guest-local=")).join("; ");
    headers["x-forwarded-for"] = incoming.socket.remoteAddress ?? "";
    const upstream = httpRequest(new URL(incoming.url, target), { method: incoming.method, headers, timeout: 15000 }, response => {
      if (finished) { response.destroy(); return; }
      outgoing.writeHead(response.statusCode ?? 503, response.headers);
      response.pipe(outgoing); response.once("end", () => { finished = true; });
      response.once("error", fail);
    });
    incoming.on("data", chunk => {
      size += chunk.length;
      if (size > 4096) { upstream.destroy(); fail(); }
    });
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    upstream.once("timeout", () => { upstream.destroy(); fail(); });
    upstream.once("error", fail);
    incoming.pipe(upstream);
    return true;
  };
}
