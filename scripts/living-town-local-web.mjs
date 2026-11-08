import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseLivingTownWebProfile } from "../packages/chain/dist/index.js";
import { publicDeploymentDescriptor } from "./public-deployment-policy.mjs";
import { createPreviewServer } from "./preview-server.mjs";

// Serve only an isolated copy of built public assets, never the workspace/data root.
const profile = JSON.parse(
  await readFile(
    new URL(
      "../data/p77-deployment-artifacts/living-town.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const parsed = parseLivingTownWebProfile(profile);
assert.equal(new URL(parsed.public.workerUrl).origin, "http://127.0.0.1:3011");
const directory = new URL("../data/p77-local-web/", import.meta.url);
await mkdir(directory, { recursive: true });
await cp(new URL("../apps/web/dist/browser/", import.meta.url), directory, {
  recursive: true,
});
const policy = {
  schema: "bot-bazaar-public-deployment-policy-v1",
  initial: { networkId: "testnet", contractId: parsed.public.contractId },
  migrations: [],
};
for (const [name, data] of Object.entries({
  "living-town.json": profile,
  "config.json": parsed.public,
  "deployment.json": publicDeploymentDescriptor(parsed.public, policy),
}))
  await writeFile(
    new URL(name, directory),
    JSON.stringify(data, null, 2) + "\n",
  );
const server = createPreviewServer(fileURLToPath(directory));
server.listen(4201, "127.0.0.1", () =>
  console.log(
    `Living Town local Testnet: http://127.0.0.1:4201/ (${parsed.public.contractId})`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
