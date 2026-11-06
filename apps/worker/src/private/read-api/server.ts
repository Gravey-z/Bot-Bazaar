import { createServer } from "node:http";
import type { Server } from "node:http";
import { createReadHandler } from "./handler.js";
import type { ReadCapabilities } from "./handler.js";
import type { BoundaryConfig } from "./config.js";

export function createReadServer(
  read: ReadCapabilities,
  config: BoundaryConfig,
): Server {
  const handler = createReadHandler(read, config);
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    handler,
  );
  const close = server.close;
  server.close = function (callback) {
    handler.closeStreams();
    return close.call(this, callback);
  };
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(5000, (socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    // Parser failures can include raw request bytes. Never reflect or log them.
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    else socket.destroy();
  });
  return server;
}
