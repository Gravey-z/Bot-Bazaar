import { createServer } from "node:http";
import { ConfigurationError } from "@bot-bazaar/shared";
import { parseWorkerConfig } from "./private/config.js";

const config = (() => {
  try {
    return parseWorkerConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : "Worker configuration could not be loaded",
    );
    process.exit(1);
  }
})();

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "not_ready" }));
    return;
  }

  response.writeHead(404);
  response.end();
});

server.on("error", () => {
  console.error(
    "Worker could not listen; check HOST/PORT and whether the port is already in use",
  );
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  console.info(
    `Bot Bazaar worker scaffold listening on ${config.host}:${config.port}; provider ${config.provider.kind}`,
  );
});

process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
