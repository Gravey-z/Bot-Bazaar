import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RehearsalSession } from "./local-rehearsal/session.mjs";

export function createRehearsalServer() {
  const session = new RehearsalSession();
  return createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${response.socket.localPort}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status, value) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(value));
    };
    if (request.headers.host !== new URL(origin).host) {
      json(403, { error: "Loopback host required." });
      return;
    }
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          await readFile(
            new URL("./local-rehearsal/index.html", import.meta.url),
          ),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/api/state") {
        json(200, session.snapshot());
        return;
      }
      if (request.method !== "POST" || request.url !== "/api/action") {
        json(404, { error: "Not found." });
        return;
      }
      if (
        request.headers.origin !== origin ||
        request.headers["content-type"] !== "application/json"
      ) {
        json(403, { error: "Use the local rehearsal page." });
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > 4096) {
          json(413, { error: "Request too large." });
          return;
        }
      }
      json(200, session.act(JSON.parse(body)));
    } catch (error) {
      json(400, {
        error:
          error instanceof Error ? error.message : "Rehearsal action rejected.",
      });
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.BAZAAR_REHEARSAL_PORT ?? "4210");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("BAZAAR_REHEARSAL_PORT must be 1024–65535.");
  const server = createRehearsalServer();
  server.on("error", (error) => {
    console.error(`Local rehearsal could not start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Local rehearsal: http://127.0.0.1:${port}/\nSimulated only: no wallet, blockchain or AI calls. One in-memory practice shop; restarting resets it. Ctrl+C stops the server.`,
    ),
  );
}
