import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
assert(
  args.length === 4 &&
    args[0] === "--runtime-config" &&
    isAbsolute(args[1]) &&
    args[2] === "--key-file" &&
    isAbsolute(args[3]),
  "Use --runtime-config <existing-absolute-config> --key-file <absolute-private-key-file>",
);
const original = JSON.parse(await readFile(args[1], "utf8"));
assert.equal(
  original.provider,
  "disabled",
  "One-way conversion starts from the reviewed rules configuration",
);
const output = resolve("data/living-town-runtime.ai.local.json");
const ai = {
  ...original,
  provider: {
    kind: "near-ai",
    key_file: args[3],
    budget_dir: resolve("data/project-inference"),
    budget_witness_dir: resolve("data/project-inference-witness"),
  },
};
await writeFile(output, JSON.stringify(ai, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  JSON.stringify({
    config: output,
    provider: "near-ai",
    daily_limit_usd: null,
    rolling_30_day_limit_usd: null,
    total_hackathon_limit_usd: 10,
    credential_value_read: false,
  }),
);
