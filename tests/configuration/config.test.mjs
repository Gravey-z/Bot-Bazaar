import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePublicConfig } from "../../packages/shared/dist/index.js";
import { parseWorkerConfig } from "../../apps/worker/dist/private/config.js";
import { writeWebConfig } from "../../scripts/write-web-config.mjs";

export const publicFixture = {
  networkId: "testnet",
  contractId: "market.testnet",
  rpcUrl: "https://test.rpc.fastnear.com",
  explorerUrl: "https://testnet.nearblocks.io",
  workerUrl: "http://127.0.0.1:3001",
};

export const workerFixture = {
  NEAR_NETWORK_ID: publicFixture.networkId,
  NEAR_CONTRACT_ID: publicFixture.contractId,
  NEAR_RPC_URL: publicFixture.rpcUrl,
  NEAR_EXPLORER_URL: publicFixture.explorerUrl,
  WORKER_URL: publicFixture.workerUrl,
  HOST: "127.0.0.1",
  PORT: "3001",
  MODEL_PROVIDER: "disabled",
  WORKER_DISCOVERY_ENABLED: "false",
  WORKER_DATA_DIR: path.join(os.tmpdir(), "bazaar-config-test"),
  WORKER_POLICY_VERSION: "v1",
  NEAR_OWNER_ID: "market.testnet",
  NEAR_EXPECTED_CODE_HASH: "CcU8qzpFzXy9BstkGqLCnK7Uxam8tymqZyaDK92nzYkW",
  REX_CONTROLLER_ID: "rex-bazaar.testnet",
  LUNA_CONTROLLER_ID: "luna-bazaar.testnet",
  BOLT_CONTROLLER_ID: "bolt-bazaar.testnet",
};

test("public configuration is normalized and immutable", () => {
  const config = parsePublicConfig(publicFixture);
  assert.equal(config.networkId, "testnet");
  assert.equal(config.rpcUrl, publicFixture.rpcUrl + "/");
  assert.equal(config.workerUrl, publicFixture.workerUrl + "/");
  assert.ok(Object.isFrozen(config));
  assert.equal(
    parsePublicConfig({
      ...publicFixture,
      rpcUrl: "https://archival-rpc.testnet.near.org",
    }).networkId,
    "testnet",
  );
});

test("reviewed Intear Testnet RPC is explicit and rejects similar-host substitutions", () => {
  assert.equal(
    parsePublicConfig({
      ...publicFixture,
      rpcUrl: "https://testnet-rpc.intea.rs",
    }).rpcUrl,
    "https://testnet-rpc.intea.rs/",
  );
  for (const rpcUrl of [
    "https://testnet-rpc.intea.rs.attacker.example",
    "https://rpc.intea.rs",
    "http://testnet-rpc.intea.rs",
  ])
    assert.throws(() => parsePublicConfig({ ...publicFixture, rpcUrl }));
});

for (const field of Object.keys(publicFixture)) {
  test(`public configuration rejects missing and placeholder ${field}`, () => {
    for (const value of [undefined, "", "  ", "<replace-me>"]) {
      assert.throws(
        () => parsePublicConfig({ ...publicFixture, [field]: value }),
        /required/,
      );
    }
  });
}

const invalidPublic = [
  ["mainnet network", { networkId: "mainnet" }],
  ["mainnet account", { contractId: "market.near" }],
  ["malformed account", { contractId: "market..testnet" }],
  ["uppercase account", { contractId: "Market.testnet" }],
  ["oversized account", { contractId: "a".repeat(60) + ".testnet" }],
  ["mainnet RPC", { rpcUrl: "https://free.rpc.fastnear.com" }],
  [
    "RPC host suffix spoof",
    { rpcUrl: "https://test.rpc.fastnear.com.evil.example" },
  ],
  ["RPC token path", { rpcUrl: "https://test.rpc.fastnear.com/private-token" }],
  ["mainnet explorer", { explorerUrl: "https://nearblocks.io" }],
  ["invalid URL", { workerUrl: "not-a-url" }],
  ["remote HTTP", { workerUrl: "http://worker.example" }],
  [
    "worker credential path",
    { workerUrl: "https://worker.example/private-token" },
  ],
  ["loopback suffix spoof", { workerUrl: "http://localhost.evil.example" }],
  [
    "URL user credentials",
    { workerUrl: "https://operator:private-value@worker.example" },
  ],
  [
    "URL query credentials",
    { rpcUrl: "https://test.rpc.fastnear.com?token=private-value" },
  ],
  ["URL fragment", { explorerUrl: "https://testnet.nearblocks.io/#secret" }],
  ["unknown private field", { apiKey: "test-only-secret" }],
];
for (const [name, change] of invalidPublic) {
  test(`public configuration rejects ${name}`, () => {
    assert.throws(
      () => parsePublicConfig({ ...publicFixture, ...change }),
      /Configuration:/,
    );
  });
}

test("public configuration accepts HTTPS workers and exact loopback HTTP origins", () => {
  for (const workerUrl of [
    "https://worker.example",
    "http://localhost:3001",
    "http://[::1]:3001",
  ]) {
    assert.ok(parsePublicConfig({ ...publicFixture, workerUrl }).workerUrl);
  }
  for (const value of [null, [], "testnet"]) {
    assert.throws(() => parsePublicConfig(value), /object/);
  }
});

test("worker disabled mode requires no provider key and still validates chain settings", () => {
  const config = parseWorkerConfig(workerFixture);
  assert.deepEqual(config.provider, { kind: "disabled" });
  assert.equal(config.port, 3001);
  assert.equal(config.public.contractId, "market.testnet");
  assert.throws(
    () => parseWorkerConfig({ ...workerFixture, NEAR_NETWORK_ID: "mainnet" }),
    /testnet/,
  );
});

test("worker requires explicit provider and listener configuration", () => {
  for (const name of ["HOST", "PORT", "MODEL_PROVIDER"]) {
    assert.throws(
      () => parseWorkerConfig({ ...workerFixture, [name]: undefined }),
      /required/,
    );
  }
  for (const PORT of ["0", "-1", "65536", "3001x", "3.5", "03001"]) {
    assert.throws(() => parseWorkerConfig({ ...workerFixture, PORT }), /PORT/);
  }
  assert.throws(
    () => parseWorkerConfig({ ...workerFixture, HOST: "external.example" }),
    /HOST/,
  );
  assert.throws(
    () => parseWorkerConfig({ ...workerFixture, MODEL_PROVIDER: "other" }),
    /MODEL_PROVIDER/,
  );
});

test("worker requires durable storage identity and explicit initialization", () => {
  for (const name of [
    "WORKER_DATA_DIR",
    "WORKER_POLICY_VERSION",
    "NEAR_OWNER_ID",
    "NEAR_EXPECTED_CODE_HASH",
    "REX_CONTROLLER_ID",
    "LUNA_CONTROLLER_ID",
    "BOLT_CONTROLLER_ID",
  ])
    assert.throws(
      () => parseWorkerConfig({ ...workerFixture, [name]: undefined }),
      /required/,
    );
  assert.equal(parseWorkerConfig(workerFixture).storage.create, false);
  assert.equal(
    parseWorkerConfig({ ...workerFixture, WORKER_INITIALIZE_DATABASE: "true" })
      .storage.create,
    true,
  );
  for (const change of [
    { WORKER_DATA_DIR: "relative/path" },
    { WORKER_INITIALIZE_DATABASE: "yes" },
    { WORKER_BACKUP_DIR: workerFixture.WORKER_DATA_DIR },
    { REX_CONTROLLER_ID: workerFixture.NEAR_OWNER_ID },
  ])
    assert.throws(() => parseWorkerConfig({ ...workerFixture, ...change }));
});

test("read-only discovery defaults on and requires an explicit boolean switch", () => {
  assert.equal(
    parseWorkerConfig({ ...workerFixture, WORKER_DISCOVERY_ENABLED: undefined })
      .discoveryEnabled,
    true,
  );
  assert.equal(parseWorkerConfig(workerFixture).discoveryEnabled, false);
  assert.throws(
    () =>
      parseWorkerConfig({ ...workerFixture, WORKER_DISCOVERY_ENABLED: "yes" }),
    /WORKER_DISCOVERY_ENABLED/,
  );
});

test("OpenAI mode requires the approved model and a private key without leaking values", () => {
  const fixture = {
    ...workerFixture,
    MODEL_PROVIDER: "openai",
    MODEL_ID: "gpt-6-luna",
  };
  assert.throws(() => parseWorkerConfig(fixture), /OPENAI_API_KEY/);
  assert.throws(
    () => parseWorkerConfig({ ...fixture, OPENAI_API_KEY: "<private-value>" }),
    (error) => {
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    },
  );
  assert.throws(
    () =>
      parseWorkerConfig({
        ...fixture,
        MODEL_ID: "different-model",
        OPENAI_API_KEY: "test-only-secret",
      }),
    /MODEL_ID/,
  );
  const config = parseWorkerConfig({
    ...fixture,
    OPENAI_API_KEY: "test-only-secret",
  });
  assert.equal(config.provider.apiKey, "test-only-secret");
  assert.ok(Object.isFrozen(config.provider));
  assert.equal("apiKey" in config.public, false);
});

test("web generator whitelists public fields, honors environment precedence and removes stale output on failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bot-bazaar-config-"));
  try {
    const envFile = path.join(dir, ".env");
    const output = path.join(dir, "public/config.json");
    await writeFile(
      envFile,
      Object.entries({
        ...workerFixture,
        OPENAI_API_KEY: "test-only-private-sentinel",
        REX_SECRET_KEY: "test-only-signer-sentinel",
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    await writeWebConfig(
      envFile,
      output,
      {
        NEAR_CONTRACT_ID: "override.testnet",
      },
      {
        schema: "bot-bazaar-public-deployment-policy-v1",
        initial: { networkId: "testnet", contractId: "override.testnet" },
        migrations: [],
      },
    );
    const text = await readFile(output, "utf8");
    assert.doesNotMatch(
      text,
      /test-only-|OPENAI|REX_SECRET|MODEL_PROVIDER|HOST|PORT/,
    );
    const config = JSON.parse(text);
    assert.equal(config.contractId, "override.testnet");
    assert.deepEqual(
      Object.keys(config).sort(),
      Object.keys(publicFixture).sort(),
    );
    await assert.rejects(
      writeWebConfig(envFile, output, { NEAR_NETWORK_ID: "mainnet" }),
      /testnet/,
    );
    await assert.rejects(readFile(output), { code: "ENOENT" });
    await assert.rejects(
      writeWebConfig(path.join(dir, "missing.env"), output, {}),
      /required/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
