import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  omv7ReaderConfig,
  projectionInitialization,
} from "./omv7-reader-config.mjs";
import { parseLivingTownWorkerConfig } from "/app/dist/private/living-town/config.js";

const profile = JSON.parse(
  await readFile("/app/config/living-town-testnet.json", "utf8"),
);
const config = omv7ReaderConfig(profile, process.env);
parseLivingTownWorkerConfig(config);
const initialize = projectionInitialization(
  config.data_dir,
  process.env.V2_CREATE_NEW_PROJECTION,
);
const filename = "/tmp/living-town-reader.json";
await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
const child = spawn(
  process.execPath,
  [
    "/app/dist/living-town.js",
    "--config",
    filename,
    ...(initialize ? ["--initialize"] : []),
  ],
  { stdio: "inherit" },
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => child.kill(signal));
child.once("error", () => {
  console.error("Unable to start V2 read projection");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
