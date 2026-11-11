import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseLivingTownWebProfile } from "../packages/chain/dist/index.js";
import { publicDeploymentDescriptor } from "./public-deployment-policy.mjs";

export const releaseProfileUrl = new URL(
  "../config/living-town-testnet.json",
  import.meta.url,
);

export async function validateTownRelease(value, target) {
  if (!["local", "public"].includes(target))
    throw Error("Select V2 target: local or public");
  const profile = parseLivingTownWebProfile(value);
  const expected = parseLivingTownWebProfile(
    JSON.parse(await readFile(releaseProfileUrl, "utf8")),
  );
  if (!isDeepStrictEqual(profile.identity, expected.identity))
    throw Error(
      "V2 release identity differs from the reviewed Testnet deployment",
    );
  const worker = new URL(profile.public.workerUrl);
  if (target === "local") {
    if (worker.origin !== "http://127.0.0.1:3011")
      throw Error("Local V2 reader must use http://127.0.0.1:3011");
  } else {
    // A public build must not send judges to loopback or a private-network host.
    const host = worker.hostname;
    if (
      worker.protocol !== "https:" ||
      !host.includes(".") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      /^[\d.]+$/.test(host) ||
      host.includes(":")
    )
      throw Error("Public V2 reader requires a public HTTPS DNS origin");
  }
  return profile;
}

export function townDeployment(publicConfig) {
  return publicDeploymentDescriptor(publicConfig, {
    schema: "bot-bazaar-public-deployment-policy-v1",
    initial: {
      networkId: publicConfig.networkId,
      contractId: publicConfig.contractId,
    },
    migrations: [],
  });
}
