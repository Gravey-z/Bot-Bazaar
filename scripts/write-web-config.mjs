import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { publicDeploymentDescriptor } from "./public-deployment-policy.mjs";
import {
  releaseProfileUrl,
  validateTownRelease,
  townDeployment,
} from "./living-town-web-release.mjs";

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
  const profilePath = path.join(path.dirname(outputFile), "living-town.json");
  await rm(profilePath, { force: true });
  const experience = environment.WEB_EXPERIENCE ?? "living-town";
  if (experience === "living-town") {
    const raw = JSON.parse(await readFile(releaseProfileUrl, "utf8"));
    if (environment.V2_WORKER_URL)
      raw.public.workerUrl = environment.V2_WORKER_URL;
    const profile = await validateTownRelease(
      raw,
      environment.LIVING_TOWN_TARGET ?? "local",
    );
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(
      profilePath,
      JSON.stringify({ ...raw, public: profile.public }, null, 2) + "\n",
    );
    await writeFile(outputFile, JSON.stringify(profile.public) + "\n");
    await writeFile(
      descriptorPath,
      JSON.stringify(townDeployment(profile.public)) + "\n",
    );
    return;
  }
  if (experience !== "classic")
    throw new ConfigurationError(
      "Select WEB_EXPERIENCE classic or living-town",
    );
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
      "Living Town uses config/living-town-testnet.json; public builds also require V2_WORKER_URL. Classic configuration requires explicit WEB_EXPERIENCE=classic and its public environment settings.",
    );
    process.exitCode = 1;
  }
}
