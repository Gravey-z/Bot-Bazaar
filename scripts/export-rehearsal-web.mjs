import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parsePublicConfig,
  parseWebDeployment,
} from "../packages/shared/dist/index.js";
import { validateRehearsalManifest } from "./rehearsal-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function exportRehearsalWeb(
  manifestPath,
  {
    sourceDirectory = join(root, "apps/web/dist/browser"),
    rehearsalRoot = join(root, "target/rehearsals"),
  } = {},
) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateRehearsalManifest(manifest);
  const directory = dirname(resolve(manifestPath));
  assert.equal(
    directory,
    resolve(rehearsalRoot, manifest.runId),
    "Rehearsal export must remain in its separate run namespace",
  );
  const output = join(directory, "web");
  assert.ok(
    relative(resolve(sourceDirectory), output).startsWith(".."),
    "Cannot overwrite a public web artifact",
  );
  const source = parseWebDeployment(
    JSON.parse(
      await readFile(join(sourceDirectory, "deployment.json"), "utf8"),
    ),
  );
  assert.equal(source.mode, "public");
  const files = await readdir(sourceDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  assert.ok(
    !files.some((file) => file.isSymbolicLink()),
    "Static artifact cannot contain symlinks",
  );
  const config = parsePublicConfig({
    networkId: "testnet",
    contractId: manifest.identity.contractId,
    rpcUrl: manifest.rpcUrl,
    workerUrl: manifest.workerUrl,
    explorerUrl: "https://testnet.nearblocks.io/",
  });
  const deployment = parseWebDeployment({
    schema: "bot-bazaar-web-deployment-v1",
    mode: "rehearsal",
    current: config,
    retained: [],
    announcement:
      "Separate rehearsal market. Public balances and grants are not transferred; AI readiness is not verified.",
  });
  await mkdir(output); // No overwrite, no public config edit, no server startup.
  await cp(sourceDirectory, output, { recursive: true });
  await writeFile(join(output, "config.json"), JSON.stringify(config) + "\n");
  await writeFile(
    join(output, "deployment.json"),
    JSON.stringify(deployment) + "\n",
  );
  return { output, mode: deployment.mode, contractId: config.contractId };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    assert.equal(process.argv.length, 3);
    console.info(JSON.stringify(await exportRehearsalWeb(process.argv[2])));
  } catch {
    console.error(
      "Rehearsal web export stopped. Build the reviewed public artifact and use a fresh isolated rehearsal directory; no public configuration was replaced.",
    );
    process.exitCode = 1;
  }
}
