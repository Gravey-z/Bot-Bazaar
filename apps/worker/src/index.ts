import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "not_ready" }));
    return;
  }

  response.writeHead(404);
  response.end();
});

server.listen(3001, "127.0.0.1", () => {
  console.info("Bot Bazaar worker scaffold listening at http://127.0.0.1:3001");
});

process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
