import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { build } from "esbuild";

test("public view helpers bundle and run without Node or worker infrastructure", async () => {
  const result = await build({
    stdin: {
      contents: `
        import { createViewRequest } from "./packages/chain/dist/index.js";
        import { merchantNames } from "./packages/shared/dist/index.js";
        globalThis.proof = { merchant: merchantNames.rex, request: createViewRequest(
          "market.testnet", "get_market", { label: "雪" }
        ) };
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(input, /apps[\\/]worker|near-api-js|@near-js|openai/);
  }
  const context = vm.createContext({ TextEncoder, btoa });
  vm.runInContext(result.outputFiles[0].text, context);
  assert.equal(context.proof.merchant, "Rex");
  assert.equal(context.proof.request.method, "query");
  assert.equal(context.proof.request.params.finality, "final");
  assert.equal(
    Buffer.from(context.proof.request.params.args_base64, "base64").toString(
      "utf8",
    ),
    JSON.stringify({ label: "雪" }),
  );
});
