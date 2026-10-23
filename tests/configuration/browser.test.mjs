import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { build } from "esbuild";

const fixture = {
  networkId: "testnet",
  contractId: "market.testnet",
  rpcUrl: "https://test.rpc.fastnear.com",
  explorerUrl: "https://testnet.nearblocks.io",
  workerUrl: "http://127.0.0.1:3001",
};

test("browser validates configuration before startup and reports unavailable or invalid configuration", async () => {
  const result = await build({
    entryPoints: ["apps/web/src/load-public-config.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "loader",
    write: false,
  });
  let request;
  let response = { ok: true, json: async () => fixture };
  const context = vm.createContext({
    URL,
    AbortSignal,
    fetch: async (...args) => {
      request = args;
      if (response instanceof Error) throw response;
      return response;
    },
  });
  vm.runInContext(result.outputFiles[0].text, context);
  const url = new URL("https://web.example/config.json");
  const config = await context.loader.loadPublicConfig(url);
  assert.equal(config.contractId, fixture.contractId);
  assert.equal(request[1].cache, "no-store");
  assert.ok(request[1].signal instanceof AbortSignal);

  response = { ok: false };
  await assert.rejects(context.loader.loadPublicConfig(url), /unavailable/);
  response = new Error("private transport detail");
  await assert.rejects(
    context.loader.loadPublicConfig(url),
    /could not load config.json/,
  );
  response = {
    ok: true,
    json: async () => {
      throw new Error("private JSON detail");
    },
  };
  await assert.rejects(context.loader.loadPublicConfig(url), /valid JSON/);
  response = {
    ok: true,
    json: async () => ({ ...fixture, networkId: "mainnet" }),
  };
  await assert.rejects(context.loader.loadPublicConfig(url), /testnet/);
});
