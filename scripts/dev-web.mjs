import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createPreviewServer } from "./preview-server.mjs";

const web = fileURLToPath(new URL("../apps/web/", import.meta.url));
const { values } = parseArgs({
  options: { port: { type: "string", default: "4200" } },
});
if (!/^[1-9][0-9]{0,4}$/.test(values.port) || Number(values.port) > 65535) {
  console.error("--port must be an integer from 1 to 65535");
  process.exit(1);
}
const cli = path.join(web, "node_modules/@angular/cli/bin/ng.js");
const args = [cli, "build", "--configuration", "development"];

const initial = spawnSync(process.execPath, args, {
  cwd: web,
  stdio: "inherit",
});
if (initial.error || initial.status !== 0) process.exit(initial.status || 1);

const watcher = spawn(process.execPath, [...args, "--watch"], {
  cwd: web,
  stdio: "inherit",
});
const server = createPreviewServer(path.join(web, "dist/browser"));
let stopping = false;
function stop() {
  stopping = true;
  watcher.kill("SIGINT");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
watcher.once("error", () => {
  console.error("Could not start Angular watch build");
  process.exitCode = 1;
});
watcher.once("close", (code) => {
  server.close();
  server.closeAllConnections();
  process.exitCode = process.exitCode || (stopping ? 0 : code || 1);
});
server.once("error", () => {
  console.error(
    "Web preview could not listen; check whether the port is already in use",
  );
  process.exitCode = 1;
  stop();
});
server.listen(Number(values.port), "127.0.0.1", () => {
  console.info(
    `Bot Bazaar: http://127.0.0.1:${values.port} (watch build; refresh the browser after edits)`,
  );
});
