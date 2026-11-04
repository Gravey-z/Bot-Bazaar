import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import {
  parsePublicConfig,
  parseWebDeployment,
} from "../../packages/shared/dist/index.js";
import { publicDeploymentDescriptor } from "../../scripts/public-deployment-policy.mjs";
import { writeWebConfig } from "../../scripts/write-web-config.mjs";
import { exportRehearsalWeb } from "../../scripts/export-rehearsal-web.mjs";
import { makeRehearsalPlan } from "../../scripts/rehearsal-plan.mjs";

const bundled = await build({
  stdin: {
    contents: `export * from './apps/web/src/app/deployment-session.ts'; export * from './apps/web/src/app/wallet-context.ts'; export * from './apps/web/src/app/transaction-lifecycle.ts'; export * from './apps/web/src/load-public-config.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const {
  DeploymentSession,
  WalletContextStore,
  TransactionLifecycle,
  loadPublicDeployment,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const fixture = JSON.parse(
  await readFile("tests/fixtures/chain/market.json", "utf8"),
);
const old = parsePublicConfig({
  networkId: "testnet",
  contractId: "original.testnet",
  rpcUrl: "https://test.rpc.fastnear.com",
  explorerUrl: "https://testnet.nearblocks.io",
  workerUrl: "https://old-worker.example",
});
const next = parsePublicConfig({
  ...old,
  contractId: "replacement.testnet",
  workerUrl: "https://new-worker.example",
});
const page = "https://bazaar.example/";
const descriptor = (current = old, retained = [], mode = "public") =>
  parseWebDeployment({
    schema: "bot-bazaar-web-deployment-v1",
    mode,
    current,
    retained,
    announcement: null,
  });
function memory() {
  const values = new Map();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function pending(storage, config = old) {
  const context = new WalletContextStore(config, storage, page);
  const value = context.prepareTransaction(
    "player.testnet",
    "buy_from_merchant",
    fixture.steps[1].args,
    fixture.seed.market.block_height,
  );
  context.recordPurchaseHash(value.id, fixture.steps[1].transaction_hash);
  return context;
}
const identity = (config) => ({
  networkId: config.networkId,
  contractId: config.contractId,
});
const policy = () => ({
  schema: "bot-bazaar-public-deployment-policy-v1",
  initial: identity(old),
  migrations: [],
});
const migration = () => ({
  from: old,
  to: identity(next),
  announcedAt: "2026-11-04T00:00:00.000Z",
  message:
    "A separate market is available. Original progress stays on its original contract.",
});

test("public output cannot be repointed by an environment override without a reviewed migration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bazaar-public-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "web.env"),
    output = join(directory, "config.json");
  await writeFile(envFile, "");
  const environment = {
    NEAR_NETWORK_ID: "testnet",
    NEAR_CONTRACT_ID: old.contractId,
    NEAR_RPC_URL: old.rpcUrl,
    NEAR_EXPLORER_URL: old.explorerUrl,
    WORKER_URL: old.workerUrl,
  };
  await writeWebConfig(envFile, output, environment, policy());
  assert.equal(
    JSON.parse(await readFile(join(directory, "deployment.json"), "utf8")).mode,
    "public",
  );
  await assert.rejects(
    writeWebConfig(
      envFile,
      output,
      { ...environment, NEAR_CONTRACT_ID: next.contractId },
      policy(),
    ),
    /reviewed migration/,
  );
  await assert.rejects(readFile(output), { code: "ENOENT" });
  await assert.rejects(readFile(join(directory, "deployment.json")), {
    code: "ENOENT",
  });
});

test("intentional migrations retain original configuration and require a dated announcement", () => {
  const p = policy();
  p.migrations = [migration()];
  const result = publicDeploymentDescriptor(next, p);
  assert.equal(result.retained[0].contractId, old.contractId);
  assert.equal(result.retained[0].workerUrl, old.workerUrl);
  assert.match(result.announcement, /Original progress/);
  for (const change of [
    { message: "" },
    { announcedAt: "invalid" },
    { announcedAt: "2999-01-01T00:00:00.000Z" },
    { from: next },
    { to: identity(old) },
  ]) {
    assert.throws(() =>
      publicDeploymentDescriptor(next, {
        ...p,
        migrations: [{ ...migration(), ...change }],
      }),
    );
  }
});

test("descriptor rejects private fields, duplicate identities, mode spoofing and rehearsals carrying public history", () => {
  const d = descriptor();
  for (const fields of [
    { mode: ["public"] },
    { apiKey: "private" },
    { retained: [old] },
    { mode: "rehearsal", current: next, retained: [old] },
  ])
    assert.throws(() => parseWebDeployment({ ...d, ...fields }));
});

test("new tabs select the offered market; existing tabs stay pinned after a published replacement", () => {
  const storage = memory();
  const original = new DeploymentSession(descriptor(), storage, page);
  const replacement = new DeploymentSession(
    descriptor(next, [old]),
    storage,
    page,
  );
  assert.equal(original.selected.contractId, old.contractId);
  assert.equal(replacement.selected.contractId, old.contractId);
  assert.equal(replacement.view().canSwitch, true);
  assert.equal(
    new DeploymentSession(descriptor(next, [old]), memory(), page).selected
      .contractId,
    next.contractId,
  );
});

test("pending transactions block explicit switching and remain on the original contract through reload", () => {
  const storage = memory();
  new DeploymentSession(descriptor(), storage, page);
  const context = pending(storage),
    original = JSON.stringify([...storage.values]);
  const session = new DeploymentSession(descriptor(next, [old]), storage, page);
  assert.equal(session.view().pending, true);
  assert.equal(session.view().canSwitch, false);
  assert.throws(() => session.selectPublished());
  assert.equal(context.read().contractId, old.contractId);
  assert.equal(JSON.stringify([...storage.values]), original);
});

test("legacy pending contexts without a selection pin recover their original published configuration", () => {
  const storage = memory();
  const context = pending(storage);
  const session = new DeploymentSession(descriptor(next, [old]), storage, page);
  assert.equal(session.selected.contractId, old.contractId);
  assert.equal(
    context.read().transactionHash,
    fixture.steps[1].transaction_hash,
  );
});

test("missing historical config blocks startup without discarding original wallet work", () => {
  const storage = memory();
  new DeploymentSession(descriptor(), storage, page);
  pending(storage);
  const before = JSON.stringify([...storage.values]);
  assert.throws(
    () => new DeploymentSession(descriptor(next), storage, page),
    /original market is missing/,
  );
  assert.equal(JSON.stringify([...storage.values]), before);
});

test("original receipts settle against the original contract before an explicit market change", async () => {
  const storage = memory();
  new DeploymentSession(descriptor(), storage, page);
  const context = pending(storage);
  const session = new DeploymentSession(descriptor(next, [old]), storage, page);
  let reads = 0;
  const lifecycle = new TransactionLifecycle(
    context,
    async (record) => {
      reads++;
      assert.equal(record.contractId, old.contractId);
      return { kind: "succeeded" };
    },
    () => {},
  );
  await lifecycle.refresh();
  assert.equal(reads, 1);
  assert.equal(context.read(), null);
  assert.equal(session.view().canSwitch, true);
  session.selectPublished();
  assert.throws(() => session.assertSelected());
  const reloaded = new DeploymentSession(
    descriptor(next, [old]),
    storage,
    page,
  );
  assert.equal(reloaded.selected.contractId, next.contractId);
  assert.equal(new WalletContextStore(next, storage, page).read(), null);
  assert.equal(
    context.lastTransaction().transactionHash,
    fixture.steps[1].transaction_hash,
  );
  const archive = reloaded.view().archives[0];
  assert.equal(archive.contractId, old.contractId);
  assert.equal(
    archive.url,
    `https://testnet.nearblocks.io/txns/${fixture.steps[1].transaction_hash}`,
  );
});

test("a wallet request starting during the switch review closes the switch opportunity", () => {
  const storage = memory();
  new DeploymentSession(descriptor(), storage, page);
  const session = new DeploymentSession(descriptor(next, [old]), storage, page);
  assert.equal(session.view().canSwitch, true);
  pending(storage);
  assert.throws(() => session.selectPublished());
  assert.equal(
    new DeploymentSession(descriptor(next, [old]), storage, page).selected
      .contractId,
    old.contractId,
  );
});

test("rehearsal mode cannot replace a public tab on the same route", () => {
  const storage = memory();
  new DeploymentSession(descriptor(), storage, page);
  const original = JSON.stringify([...storage.values]);
  assert.throws(
    () =>
      new DeploymentSession(descriptor(next, [], "rehearsal"), storage, page),
    /separate browser origins or paths/,
  );
  assert.equal(JSON.stringify([...storage.values]), original);
  assert.equal(
    new DeploymentSession(
      descriptor(next, [], "rehearsal"),
      memory(),
      "https://rehearsal.example/",
    ).selected.contractId,
    next.contractId,
  );
});

test("denied storage is spectator-only and corrupted selection/contexts never authorize signing", () => {
  const denied = {
    get length() {
      throw new Error("denied");
    },
    key() {
      throw new Error();
    },
    getItem() {
      throw new Error();
    },
    setItem() {
      throw new Error();
    },
    removeItem() {
      throw new Error();
    },
  };
  const session = new DeploymentSession(descriptor(), denied, page);
  assert.equal(session.view().locked, true);
  assert.throws(() => session.assertSelected());
  const storage = memory();
  new DeploymentSession(descriptor(), storage, page);
  const key = [...storage.values.keys()][0];
  storage.values.set(key, "corrupt");
  assert.throws(() => new DeploymentSession(descriptor(), storage, page));
  assert.equal(storage.values.get(key), "corrupt");
});

test("tampered selection blocks an already-loaded tab from creating new wallet context", () => {
  const storage = memory();
  const session = new DeploymentSession(descriptor(next, [old]), storage, page);
  const key = [...storage.values.keys()][0];
  storage.values.set(
    key,
    JSON.stringify({
      version: 1,
      mode: "public",
      networkId: "testnet",
      contractId: old.contractId,
    }),
  );
  assert.throws(() => session.assertSelected());
  assert.equal(session.view().locked, true);
});

test("deployment/config disagreement and oversized descriptors fail before selection", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("config.json") ? old : descriptor(next, [old]),
      ),
    );
  await assert.rejects(
    loadPublicDeployment(new URL("https://bazaar.example/config.json")),
    /disagree/,
  );
  globalThis.fetch = async (url) =>
    new Response(
      String(url).endsWith("config.json")
        ? JSON.stringify(old)
        : "x".repeat(65537),
    );
  await assert.rejects(
    loadPublicDeployment(new URL("https://bazaar.example/config.json")),
    /unavailable or invalid/,
  );
});

test("static rehearsal export is separate, explicitly labelled and preserves the public artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bazaar-rehearsal-web-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceDirectory = join(directory, "public"),
    rehearsalRoot = join(directory, "runs");
  const input = JSON.parse(
    await readFile("tests/scenarios/rehearsal.example.json", "utf8"),
  );
  const plan = makeRehearsalPlan(input);
  const run = join(rehearsalRoot, plan.runId);
  await mkdir(run, { recursive: true });
  await mkdir(sourceDirectory);
  await writeFile(
    join(sourceDirectory, "index.html"),
    "<p>Reviewed static artifact</p>",
  );
  const original = JSON.stringify(descriptor());
  await writeFile(join(sourceDirectory, "deployment.json"), original);
  await writeFile(join(sourceDirectory, "config.json"), JSON.stringify(old));
  const manifestPath = join(run, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(plan));
  const result = await exportRehearsalWeb(manifestPath, {
    sourceDirectory,
    rehearsalRoot,
  });
  assert.equal(result.mode, "rehearsal");
  assert.equal(
    await readFile(join(sourceDirectory, "deployment.json"), "utf8"),
    original,
  );
  const exported = JSON.parse(
    await readFile(join(result.output, "deployment.json"), "utf8"),
  );
  assert.equal(exported.current.contractId, plan.identity.contractId);
  assert.equal(exported.retained.length, 0);
  await assert.rejects(
    exportRehearsalWeb(manifestPath, { sourceDirectory, rehearsalRoot }),
    /EEXIST/,
  );
});
