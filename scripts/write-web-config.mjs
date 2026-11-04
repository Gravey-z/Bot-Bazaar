import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { publicDeploymentDescriptor } from "./public-deployment-policy.mjs";

import {
  ConfigurationError,
  parsePublicConfig,
} from "../packages/shared/dist/index.js";

export async function writeWebConfig(
  envFile,
  outputFile,
  environment = process.env,
  policy,
) {
  await rm(outputFile, { force: true });
  const descriptorPath = path.join(path.dirname(outputFile), "deployment.json");
  await rm(descriptorPath, { force: true });
  let local = {};
  try {
    local = parseEnv(await readFile(envFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new ConfigurationError("could not read the web .env file");
    }
  }
  const env = { ...local, ...environment };
  const config = parsePublicConfig({
    networkId: env.NEAR_NETWORK_ID,
    contractId: env.NEAR_CONTRACT_ID,
    rpcUrl: env.NEAR_RPC_URL,
    explorerUrl: env.NEAR_EXPLORER_URL,
    workerUrl: env.WORKER_URL,
  });
  const deployment = publicDeploymentDescriptor(
    config,
    policy ??
      JSON.parse(
        await readFile(
          new URL("../config/public-deployment.json", import.meta.url),
          "utf8",
        ),
      ),
  );
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(config) + "\n", "utf8");
  await writeFile(descriptorPath, JSON.stringify(deployment) + "\n", "utf8");
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
  try {
    await writeWebConfig(
      path.join(webRoot, ".env"),
      path.join(webRoot, "public/config.json"),
    );
  } catch (error) {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : "Unable to write public configuration",
    );
    console.error(
      "Set the public variables in apps/web/.env or the build environment; see apps/web/.env.example.",
    );
    process.exitCode = 1;
  }
}
