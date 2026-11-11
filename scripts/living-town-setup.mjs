import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalLivingTownJson, parseLivingTownWebProfile } from "../packages/chain/dist/index.js";
import { releaseProfileUrl } from "./living-town-web-release.mjs";
import { townNegotiatingMerchantMethods, townOperatorMethods, customerRuntimeMethods,
  maximumRuntimeAllowance } from "../apps/worker/dist/private/near-signer.js";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const runtimePublicKeysUrl = new URL("../config/living-town-runtime-public.json", import.meta.url);
const exact = (value, keys) => assert(value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join(), "Unexpected public setup fields");

export async function activeTownProfile() {
  return parseLivingTownWebProfile(JSON.parse(await readFile(releaseProfileUrl, "utf8")));
}
export function townSetupPaths(profile) {
  const identityHash = createHash("sha256").update(canonicalLivingTownJson(profile.identity)).digest("hex").slice(0, 16);
  const name = `${profile.identity.deployment.contract_id}-${identityHash}`;
  const directory = join(projectRoot, "data", "deployments", name);
  return { directory, name, reader: join(directory, "reader.json"), runtime: join(directory, "runtime.json"),
    projection: join(directory, "projection"), execution: join(directory, "execution"),
    witness: join(directory, "witness"), outbox: join(directory, "receipts"),
    activity: join(directory, "agent-activity.json"), control: join(directory, "control.json") };
}
export async function publicRuntimeKeys(profile, filename = runtimePublicKeysUrl) {
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  exact(manifest, ["identity", "keys"]);
  assert.equal(canonicalLivingTownJson(manifest.identity), canonicalLivingTownJson(profile.identity),
    "Public runtime keys belong to a different deployment; supply its reviewed public manifest");
  exact(manifest.keys, ["rex", "luna", "bolt", "operator", "customer"]);
  for (const [lane, key] of Object.entries(manifest.keys)) {
    exact(key, ["account_id", "public_key", "receiver_id", "method_names", "allowance_yocto"]);
    assert.equal(key.account_id, profile.identity.controllers[lane] ?? profile.identity.operatorId);
    assert.equal(key.receiver_id, profile.public.contractId);
    assert(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key.public_key));
    assert(typeof key.allowance_yocto === "string" && /^[1-9][0-9]{0,38}$/.test(key.allowance_yocto) &&
      BigInt(key.allowance_yocto) <= maximumRuntimeAllowance, "Finite restricted-key allowance required");
    const methods = lane === "customer" ? customerRuntimeMethods : lane === "operator" ? townOperatorMethods : townNegotiatingMerchantMethods;
    assert(Array.isArray(key.method_names) && key.method_names.every(v => typeof v === "string"));
    assert.deepEqual([...key.method_names].sort(), [...methods].sort(), "Public key method scope differs from runtime");
  }
  assert.equal(new Set(Object.values(manifest.keys).map(k => k.public_key)).size, 5);
  return manifest.keys;
}
