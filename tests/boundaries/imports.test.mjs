import assert from "node:assert/strict";
import test from "node:test";

import { ESLint } from "eslint";

const eslint = new ESLint({
  overrideConfig: {
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
});
const publicFiles = [
  "apps/web/src/boundary-probe.ts",
  "packages/shared/src/boundary-probe.ts",
  "packages/chain/src/boundary-probe.ts",
];

const forbidden = [
  'import "@bot-bazaar/worker";',
  'import type { Signer } from "@bot-bazaar/worker/private/signer";',
  'type Signer = import("@bot-bazaar/worker/private/signer").Signer;',
  'export * from "near-api-js";',
  'export { default } from "openai";',
  'import("near-api-js");',
  'require("node:fs");',
  'import "crypto";',
  'import "@near-js/signers";',
  'const name = "near-api-js"; import(name);',
  "console.log(process.env.OPENAI_API_KEY);",
  "console.log(globalThis.process.env);",
  "console.log(import.meta.env);",
  '/* eslint-disable architecture/public-imports */ import "near-api-js";',
];

for (const filePath of publicFiles) {
  test(`${filePath}: rejects private imports and environment reads`, async () => {
    for (const source of forbidden) {
      const [result] = await eslint.lintText(source, { filePath });
      assert.ok(
        result.messages.some((message) =>
          [
            "architecture/public-imports",
            "no-restricted-globals",
            "no-restricted-properties",
          ].includes(message.ruleId),
        ),
        `Expected boundary rejection: ${source}`,
      );
      assert.ok(
        result.messages.every((message) => !message.fatal),
        "Rule must reject valid syntax",
      );
    }
  });
}

test("rejects a relative import into worker source", async () => {
  const [result] = await eslint.lintText(
    'import "../../worker/src/private/near-signer.js";',
    { filePath: publicFiles[0] },
  );
  assert.ok(result.messages.some((message) => message.messageId === "private"));
});

test("permits public chain and shared imports", async () => {
  const [result] = await eslint.lintText(
    'import { createViewRequest } from "@bot-bazaar/chain"; import { merchantNames } from "@bot-bazaar/shared"; type Merchant = import("@bot-bazaar/chain").MerchantId;',
    { filePath: publicFiles[0] },
  );
  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
});
