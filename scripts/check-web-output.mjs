import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePublicConfig } from "../packages/shared/dist/index.js";

const output = fileURLToPath(
  new URL("../apps/web/dist/browser/", import.meta.url),
);
const forbidden = [
  "OPENAI_API_KEY",
  "MODEL_PROVIDER",
  "near-api-js",
  "apps/worker",
  ...["OPENAI_API_KEY", "REX_SECRET_KEY", "LUNA_SECRET_KEY", "BOLT_SECRET_KEY"]
    .map((name) => process.env[name])
    .filter((value) => value && value.length >= 8),
];

const files = await readdir(output, { recursive: true, withFileTypes: true });
if (!files.some((file) => file.isFile() && file.name.endsWith(".js"))) {
  throw new Error("Build the Angular application before checking its output");
}
for (const file of files.filter((entry) => entry.isFile())) {
  const contents = await readFile(
    path.join(file.parentPath, file.name),
    "utf8",
  );
  if (forbidden.some((value) => contents.includes(value))) {
    throw new Error(
      "Public build contains private worker configuration or a supplied secret value",
    );
  }
}
parsePublicConfig(
  JSON.parse(await readFile(path.join(output, "config.json"), "utf8")),
);
console.info(
  "Public build configuration is valid; no private worker markers or supplied secret values found",
);
