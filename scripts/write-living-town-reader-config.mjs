import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  releaseProfileUrl,
  validateTownRelease,
} from "./living-town-web-release.mjs";
import { parseLivingTownWorkerConfig } from "../apps/worker/dist/private/living-town/config.js";
import { townSetupPaths } from "./living-town-setup.mjs";

const { values } = parseArgs({ options: { "print-path": { type: "boolean", default: false } } });

const raw = JSON.parse(await readFile(releaseProfileUrl, "utf8"));
const profile = await validateTownRelease(raw, "local");
const paths = townSetupPaths(profile);
const config = JSON.parse(
  await readFile(
    new URL("../config/living-town-reader.example.json", import.meta.url),
    "utf8",
  ),
);
config.identity = raw.identity;
config.public = profile.public;
config.data_dir = paths.projection;
config.poll_ms = "3000";
config.allowed_origins = ["http://127.0.0.1:4200", "http://127.0.0.1:4201"];
parseLivingTownWorkerConfig(config);
const output = paths.reader;
if (values["print-path"]) {
  console.log(output);
} else {
try {
  await lstat(paths.projection);
  throw Error("An existing projection must retain its original reader configuration; setup does not adopt established state");
} catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(paths.directory, { recursive: true, mode: 0o700 });
// Never replace an operator's existing configuration.
await writeFile(output, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
console.log(`Reader config: ${output}`);
console.log(`Deployment: ${profile.public.contractId}`);
console.log(
  "First start only: node apps/worker/dist/living-town.js --config <absolute-config-path> --initialize",
);
console.log(
  "Restart without --initialize. This service only reads; it has no signer or model.",
);
}
