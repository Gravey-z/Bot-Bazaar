import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateTownRelease } from "./living-town-web-release.mjs";
import { createPreviewServer } from "./preview-server.mjs";

// Serve the validated artifact directly; never serve workspace or private data.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = new URL("../apps/web/dist/browser/", import.meta.url);
const result = spawnSync(
  process.execPath,
  ["scripts/check-web-output.mjs", fileURLToPath(directory), "v2-local"],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const profile = await validateTownRelease(
  JSON.parse(await readFile(new URL("living-town.json", directory), "utf8")),
  "local",
);
const server = createPreviewServer(fileURLToPath(directory));
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "Port 4201 is already in use. Stop the identified existing frontend before starting this build."
      : "Unable to start the local V2 frontend",
  );
  process.exitCode = 1;
});
server.listen(4201, "127.0.0.1", () =>
  console.log(
    `Living Town local Testnet: http://127.0.0.1:4201/ (${profile.public.contractId})`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
