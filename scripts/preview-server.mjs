import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { securityHeaders } from "./security-headers.mjs";
import { guestProxy } from "./guest-proxy.mjs";
import { townRpcProxy } from "./town-rpc-proxy.mjs";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".map": "application/json",
};

export function createPreviewServer(directory) {
  const root = path.resolve(directory);
  const proxyGuest = guestProxy(process.env.GUEST_API_URL);
  const proxyTownRpc = townRpcProxy(path.join(root, "living-town.json"));
  return createServer(async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders))
      response.setHeader(name, value);
    if (proxyGuest(request, response)) return;
    if (await proxyTownRpc(request, response)) return;
    if (request.url === "/favicon.ico" && ["GET", "HEAD"].includes(request.method)) {
      response.writeHead(302, { Location: "/favicon.svg" });
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    let filename;
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      filename = path.resolve(
        root,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    try {
      const [resolvedRoot, resolvedFile] = await Promise.all([
        realpath(root),
        realpath(filename),
      ]);
      const relative = path.relative(resolvedRoot, resolvedFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(resolvedFile);
      response.writeHead(200, {
        "Content-Type":
          contentTypes[path.extname(resolvedFile)] ??
          "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });
}
