import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

/** Prepare local launch files only; never sign, call a model, or reset journals. */
export async function prepareDevMerchantRuntime(root, reader, environment = process.env) {
  if (environment.DEV_AI_MERCHANTS === "0") return null;
  const { parseTownRuntimeConfig } = await import("../apps/worker/dist/private/living-town/runtime-config.js");
  const { nearAiModel } = await import("../apps/worker/dist/private/living-town/near-ai-cloud.js");
  const { canonicalLivingTownJson } = await import("../packages/chain/dist/index.js");
  const read = file => JSON.parse(readFileSync(file, "utf8"));
  const deployments = path.join(root, "data/deployments");
  const candidates = environment.DEV_RUNTIME_CONFIG
    ? [path.resolve(root, environment.DEV_RUNTIME_CONFIG)]
    : [path.join(root, "data/phase7-demo/runtime.json"),
      ...(existsSync(deployments) ? readdirSync(deployments).map(name => path.join(deployments, name, "runtime.json")) : []),
      path.join(root, "data/living-town-runtime.ai.local.json")];
  const source = candidates.find(file => existsSync(file) &&
    canonicalLivingTownJson(read(file).identity) === canonicalLivingTownJson(reader.identity));
  if (!source) throw Error("No merchant runtime matches this town. Set DEV_RUNTIME_CONFIG to its existing runtime configuration.");
  const raw = read(source);
  if (raw.provider === "disabled") {
    const aiFile = path.join(root, "data/living-town-runtime.ai.local.json");
    if (!existsSync(aiFile) || read(aiFile).provider?.kind !== "near-ai")
      throw Error("Merchant AI credentials and shared budget need setup before dev:web can start merchants.");
    raw.provider = read(aiFile).provider;
  }
  const config = parseTownRuntimeConfig(raw);
  if (config.provider.kind !== "near-ai") throw Error("Local merchant AI requires the configured NEAR AI provider.");
  if (!reader.receipt_inbox || path.resolve(reader.receipt_inbox) !== config.outboxDir ||
    !reader.agent_activity_inbox || path.resolve(reader.agent_activity_inbox) !== config.activityFile)
    throw Error("Reader and merchant runtime must share receipt and activity inboxes.");
  for (const file of [path.join(config.executionDir, "worker.sqlite"), path.join(config.executionDir, "facts.sqlite"),
    path.join(config.witnessDir, "continuity.sqlite"), path.join(config.provider.budgetDir, "shared-inference.sqlite"),
    path.join(config.provider.budgetWitnessDir, "inference-continuity.sqlite")])
    if (!existsSync(file)) throw Error(`Existing merchant state is required; no automatic reset or initialization: ${file}`);
  const directory = path.join(root, "data/dev");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Dev has its own pause control. Preserve the original runtime's control file.
  const control = path.join(directory, "merchant-control.json");
  if (!existsSync(control)) writeFileSync(control,
    JSON.stringify({ schema: "living-town-runtime-control-v1", mode: "active" }) + "\n", { flag: "wx", mode: 0o600 });
  raw.control_file = control;
  const file = path.join(root, "data/living-town-runtime.dev-ai.local.json");
  parseTownRuntimeConfig(raw);
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  return { file, control, model: nearAiModel,
    args: ["--config", file, "--enable-provider-if-needed"] };
}
