import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { parseTownRuntimeConfig } from "../apps/worker/dist/private/living-town/runtime-config.js";
import { activeTownProfile, publicRuntimeKeys, townSetupPaths } from "./living-town-setup.mjs";

const { values } = parseArgs({ options: { keys: { type: "string" }, "public-keys": { type: "string" } } });
if (!values.keys || !isAbsolute(values.keys) || (values["public-keys"] && !isAbsolute(values["public-keys"])))
  throw Error(
    "Usage: write-living-town-runtime-config --keys <absolute-restricted-key-directory> [--public-keys <absolute-public-manifest.json>]",
  );
const profile = await activeTownProfile();
const paths = townSetupPaths(profile);
const publicKeys = await publicRuntimeKeys(profile, values["public-keys"]);
const raw = JSON.parse(
  await readFile(
    new URL("../config/living-town-runtime.example.json", import.meta.url),
    "utf8",
  ),
);
raw.identity = profile.identity;
raw.public = profile.public;
raw.execution_dir = paths.execution;
raw.witness_dir = paths.witness;
raw.receipt_outbox = paths.outbox;
raw.agent_activity_inbox = paths.activity;
raw.control_file = paths.control;
raw.provider = "disabled";
for (const [lane, key] of Object.entries(publicKeys))
  raw.keys[lane] = { public_key: key.public_key, file: join(resolve(values.keys), `runtime-${lane}.json`) };
parseTownRuntimeConfig(raw);
// Refuse to adopt/reset an existing execution or witness as generic setup.
for (const path of [paths.runtime, paths.execution, paths.witness, paths.outbox, paths.control, paths.activity]) {
  try { await lstat(path); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  throw Error(`Existing deployment state/config at ${path}; retain its original config and recovery procedure`);
}
await mkdir(paths.directory, { recursive: true, mode: 0o700 });
await writeFile(
  paths.control,
  JSON.stringify({
    schema: "living-town-runtime-control-v1",
    mode: "paused",
  }) + "\n",
  { flag: "wx", mode: 0o600 },
);
await writeFile(paths.runtime, JSON.stringify(raw, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`Runtime config: ${paths.runtime}`);
console.log(`Deployment: ${profile.public.contractId}`);
console.log(
  "Initial mode: paused; inference disabled. Public key scopes checked offline; installed keys still require runtime preflight. Private keys were referenced, not read or copied.",
);
