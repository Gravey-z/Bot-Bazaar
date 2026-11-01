import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const env = {
  ...process.env,
  NEAR_NETWORK_ID: "testnet",
  NEAR_CONTRACT_ID: "market.testnet",
  NEAR_RPC_URL: "https://test.rpc.fastnear.com",
  NEAR_EXPLORER_URL: "https://testnet.nearblocks.io",
  WORKER_URL: "http://127.0.0.1:3001",
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

test("worker exits before listening on missing or mainnet configuration, with sanitized errors", () => {
  for (const change of [
    { NEAR_NETWORK_ID: undefined },
    { NEAR_NETWORK_ID: "mainnet" },
    {
      MODEL_PROVIDER: "openai",
      MODEL_ID: "gpt-6-luna",
      OPENAI_API_KEY: "<do-not-print-this>",
    },
  ]) {
    const child = spawnSync(process.execPath, ["apps/worker/dist/index.js"], {
      env: { ...env, ...change },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 1, child.error?.message);
    assert.match(child.stderr, /Configuration:/);
    assert.doesNotMatch(child.stdout, /listening/);
    assert.doesNotMatch(child.stderr, /do-not-print-this/);
  }
});

test(
  "configured worker starts locally and reports scaffold readiness honestly",
  { timeout: 15_000 },
  async () => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "bot-bazaar-worker-env-"),
    );
    const envFile = path.join(directory, ".env");
    const settings = {
      ...env,
      PORT: String(port),
      WORKER_DATA_DIR: directory,
      WORKER_INITIALIZE_DATABASE: "true",
      WORKER_ALLOWED_ORIGINS: "https://bazaar.example",
      WORKER_TRUSTED_PROXY_IPS: "",
      WORKER_READS_PER_MINUTE: "60",
      WORKER_READS_PER_SECOND: "10",
      NEAR_AI_API_KEY: "PRIVATE_NEAR_AI_CANARY",
    };
    const names = [
      "NEAR_NETWORK_ID",
      "NEAR_CONTRACT_ID",
      "NEAR_RPC_URL",
      "NEAR_EXPLORER_URL",
      "WORKER_URL",
      "HOST",
      "PORT",
      "MODEL_PROVIDER",
      "WORKER_DISCOVERY_ENABLED",
      "WORKER_DATA_DIR",
      "WORKER_INITIALIZE_DATABASE",
      "WORKER_ALLOWED_ORIGINS",
      "WORKER_TRUSTED_PROXY_IPS",
      "WORKER_READS_PER_MINUTE",
      "WORKER_READS_PER_SECOND",
      "NEAR_AI_API_KEY",
      "WORKER_POLICY_VERSION",
      "NEAR_OWNER_ID",
      "NEAR_EXPECTED_CODE_HASH",
      "REX_CONTROLLER_ID",
      "LUNA_CONTROLLER_ID",
      "BOLT_CONTROLLER_ID",
    ];
    await writeFile(
      envFile,
      names.map((name) => `${name}=${settings[name]}`).join("\n"),
    );
    const inherited = { ...process.env };
    for (const name of names) delete inherited[name];
    const child = spawn(
      process.execPath,
      [`--env-file=${envFile}`, "apps/worker/dist/index.js"],
      {
        env: inherited,
        stdio: "ignore",
      },
    );
    const closed = once(child, "close");
    try {
      let response;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          break;
        } catch {
          if (child.exitCode !== null) break;
          await delay(50);
        }
      }
      assert.ok(response, "Worker must listen after configuration validation");
      assert.equal(response.status, 503);
      const health = await response.json();
      assert.doesNotMatch(
        JSON.stringify(health),
        /PRIVATE_NEAR_AI_CANARY|NEAR_AI_API_KEY/,
      );
      const { status, database, recovery, backup, discovery, scheduling, ai } =
        health;
      assert.deepEqual(
        { status, database, recovery, backup, discovery, scheduling, ai },
        {
          status: "not_ready",
          database: "ready",
          recovery: "required",
          backup: "verified",
          discovery: "disabled",
          scheduling: "waiting_for_recovery",
          ai: {
            status: "unavailable",
            label: "AI unavailable",
            code: "provider_disabled",
            observedAt: null,
            currentSession: false,
            mode: "disabled",
            liveAiEvidence: false,
            lastInference: null,
            lastAdmission: null,
          },
        },
      );
      assert.equal(health.api_version, "1");
      assert.equal(health.deployment.contract_id, "market.testnet");
      assert.equal(health.deployment.network_id, "testnet");
      assert.equal(health.deployment.identity_kind, "configured");
      assert.equal(typeof health.feed_generation, "string");
      assert.equal(health.chain.stale, true);
      assert.equal(health.chain.observed_at, null);
      assert.ok(Number.isSafeInteger(health.heartbeat_at));
      const activity = await fetch(`http://127.0.0.1:${port}/activity`);
      assert.equal(activity.status, 200);
      const page = await activity.json();
      assert.deepEqual(page.entries, []);
      assert.equal(page.has_more, false);
      assert.equal(page.history_gap, false);
      assert.equal(page.feed_generation, health.feed_generation);
      assert.equal(typeof page.next_after, "string");
      assert.doesNotMatch(
        JSON.stringify(page),
        /PRIVATE_NEAR_AI_CANARY|NEAR_AI_API_KEY/,
      );
      const cors = await fetch(`http://127.0.0.1:${port}/activity`, {
        headers: { Origin: "https://bazaar.example" },
      });
      assert.equal(cors.status, 200);
      assert.equal(
        cors.headers.get("access-control-allow-origin"),
        "https://bazaar.example",
      );
      const deniedOrigin = await fetch(`http://127.0.0.1:${port}/activity`, {
        headers: { Origin: "https://untrusted.example" },
      });
      assert.equal(deniedOrigin.status, 403);
      const head = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "HEAD",
      });
      assert.equal(head.status, 503);
      assert.equal(await head.text(), "");
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/activity`, { method: "POST" }))
          .status,
        405,
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/unknown`)).status,
        404,
      );
    } finally {
      child.kill();
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
