import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { securityHeaders } from "./security-headers.mjs";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
};

export function createPreviewServer(directory) {
  const root = path.resolve(directory);
  return createServer(async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders))
      response.setHeader(name, value);
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
