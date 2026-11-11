import { createPreviewServer } from "./preview-server.mjs";
const server = createPreviewServer("/app/public");
server.on("error", () => {
  console.error("V2 web failed to bind host loopback port 4201");
  process.exitCode = 1;
});
server.listen(4201, "127.0.0.1", () =>
  console.log("V2 frontend: http://127.0.0.1:4201"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
