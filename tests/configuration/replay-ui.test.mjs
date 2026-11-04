import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { controlledReplay } from "../fixtures/replay-session.mjs";
import { sha256 } from "../../scripts/replay-data.mjs";
import {
  parseReplayCollection,
  replayFileLimit,
} from "../../packages/chain/dist/index.js";

const compiled = await build({
  stdin: {
    contents: `export * from './apps/web/src/app/replay-loader.ts'; export * from './apps/web/src/app/replay-playback.ts'; export * from './apps/web/src/app/replay-navigation.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const {
  ReplayLoader,
  ReplayPlayback,
  replayFrames,
  isReplayPage,
  replayPageUrl,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const base = new URL("https://bazaar.example/demo/");
const signal = () => new AbortController().signal;
const collection = (entries = []) => ({
  schema: "bot-bazaar-replay-collection-v1",
  entries,
});
async function archive() {
  const replay = await controlledReplay();
  // Test-only simulated provenance. Never written into public replay assets.
  replay.mode = "historical_replay";
  for (const decision of replay.decisions) decision.provider = "near-ai";
  return encoded(replay);
}
function encoded(replay) {
  const bytes = Buffer.from(JSON.stringify(replay));
  const digest = sha256(bytes);
  return {
    replay,
    bytes,
    entry: {
      file: `${replay.runId}.json`,
      runId: replay.runId,
      bytes: bytes.length,
      sha256: digest,
      recordedFrom: replay.recordedFrom,
      recordedTo: replay.recordedTo,
      contractId: replay.identity.contractId,
      review: {
        reviewedAt: "2026-11-01T00:00:00.000Z",
        reviewer: "Controlled test review",
        contentSha256: digest,
      },
    },
  };
}
function source(data, transform = (value) => value) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(new URL(url).origin, base.origin);
      assert.equal(options.method, "GET");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      if (String(url).endsWith("index.json"))
        return Response.json(collection(data ? [data.entry] : []));
      assert.equal(
        String(url),
        new URL(`replays/${data.entry.file}`, base).href,
      );
      return new Response(transform(data.bytes));
    },
  };
}

test("browser replay loader reads only static same-origin archive files and handles the real empty index", async () => {
  const { calls, fetcher } = source(null);
  const loader = new ReplayLoader(base, fetcher);
  assert.deepEqual(await loader.index(signal()), collection());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bazaar.example/demo/replays/index.json");
  const committed = JSON.parse(
    await readFile("apps/web/public/replays/index.json", "utf8"),
  );
  assert.deepEqual(committed.entries, []);
});

test("browser validates exact bytes, review hash, original deployment and full evidence before display", async () => {
  const data = await archive(),
    { calls, fetcher } = source(data);
  const loader = new ReplayLoader(base, fetcher);
  const index = await loader.index(signal());
  assert.deepEqual(await loader.load(index.entries[0], signal()), data.replay);
  assert.equal(calls.length, 2);
});

test("replay manifests reject unsafe paths, wrong network, unreviewed hashes, duplicate runs and collection overflow", async () => {
  const { entry } = await archive();
  for (const mutate of [
    (e) => (e.file = "../worker.env"),
    (e) => (e.file = "https://other.example/run.json"),
    (e) => (e.contractId = "market.near"),
    (e) => (e.review.contentSha256 = "0".repeat(64)),
    (e) => (e.extra = "private-field"),
    (e) => (e.bytes = replayFileLimit + 1),
    (e) => (e.review.reviewer = "Bearer test-private-canary"),
    (e) => (e.recordedFrom = "invalid-time"),
  ]) {
    const changed = structuredClone(entry);
    mutate(changed);
    assert.throws(() => parseReplayCollection(collection([changed]), 100));
    let calls = 0;
    const loader = new ReplayLoader(base, () => {
      calls++;
      throw new Error("No fetch expected");
    });
    await assert.rejects(loader.load(changed, signal()));
    assert.equal(calls, 0);
  }
  assert.throws(() => parseReplayCollection(collection([entry, entry]), 100));
  const large = Array.from({ length: 4 }, (_, index) => ({
    ...entry,
    runId: `run-${index}`,
    file: `run-${index}.json`,
    bytes: replayFileLimit,
  }));
  assert.throws(() => parseReplayCollection(collection(large), 100), /20 MiB/);
});

test("browser refuses corrupt hashes before parsing and does not expose raw archive content in errors", async () => {
  const data = await archive();
  for (const body of [
    Buffer.from("{test-private-canary"),
    Buffer.alloc(data.bytes.length, 32),
  ]) {
    const loader = new ReplayLoader(base, source(data, () => body).fetcher);
    await assert.rejects(
      loader.load(data.entry, signal()),
      (error) => !error.message.includes("test-private-canary"),
    );
  }
});

test("recomputed hashes cannot bypass receipt, ledger, policy, text or fixture validation", async () => {
  const { replay } = await archive();
  for (const mutate of [
    (r) => {
      r.checkpoints[3].market.data.merchants[0].gold = "205";
      r.checkpoints[3].market.data.merchants[1].gold = "243";
    },
    (r) => (r.actions[0].receipt.final_execution_status = "EXECUTED"),
    (r) => (r.decisions[0].policyOutcome = "rejected"),
    (r) => (r.decisions[0].explanation = "<img src=x onerror=evil>"),
    (r) => (r.actions[0].explorerUrl = "javascript:alert(1)"),
    (r) => {
      r.mode = "test_fixture";
      for (const decision of r.decisions)
        decision.provider = "controlled-fixture";
    },
  ]) {
    const changed = structuredClone(replay);
    mutate(changed);
    const data = encoded(changed);
    await assert.rejects(
      new ReplayLoader(base, source(data).fetcher).load(data.entry, signal()),
    );
  }
});

test("streaming loader cancels oversized responses and refuses invalid UTF-8 and unsuccessful reads", async () => {
  let cancelled = false;
  const huge = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(replayFileLimit + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    new ReplayLoader(base, async () => new Response(huge)).index(signal()),
  );
  assert.equal(cancelled, true);
  for (const response of [
    new Response(new Uint8Array([255])),
    new Response("unavailable", { status: 503 }),
  ])
    await assert.rejects(
      new ReplayLoader(base, async () => response).index(signal()),
    );
});

test("recorded decisions leave balances unchanged until the corresponding confirmed transaction step", async () => {
  const { replay } = await archive(),
    frames = replayFrames(replay);
  assert.equal(frames.length, 6);
  assert.equal(frames[0].checkpoint.player.data.gold, "100");
  assert.equal(frames[1].checkpoint.player.data.gold, "52");
  const proposal = frames[2],
    acceptedDecision = frames[4],
    settlement = frames[5];
  assert.equal(proposal.kind, "decision");
  assert.match(proposal.label, /no transfer/);
  assert.equal(proposal.checkpoint.market.data.merchants[0].gold, "228");
  assert.equal(acceptedDecision.kind, "decision");
  assert.equal(
    acceptedDecision.checkpoint.market.data.merchants[0].gold,
    "228",
  );
  assert.equal(settlement.checkpoint.market.data.merchants[0].gold, "204");
  assert.match(settlement.terms, /24 total gold/);
  assert.equal(settlement.timestamp, replay.checkpoints[3].block.timestampNs);
  assert.equal(settlement.action.explorerUrl, replay.actions[2].explorerUrl);
});

test("playback supports empty/unavailable archive states without a wallet or provider port", async () => {
  const states = [];
  const playback = new ReplayPlayback(
    {
      index: async () => collection(),
      load: () => {
        throw new Error("No runs");
      },
    },
    (state) => states.push(state),
  );
  await playback.start();
  assert.equal(playback.state.phase, "empty");
  playback.play();
  assert.equal(playback.state.playing, false);
  const failed = new ReplayPlayback(
    {
      index: async () => {
        throw new Error("private backend error");
      },
    },
    () => {},
  );
  await failed.start();
  assert.equal(failed.state.phase, "error");
  assert.equal(failed.state.message.includes("private backend"), false);
  playback.stop();
  failed.stop();
});

test("seeking, playing and leaving replay never modify supplied archive or live state", async () => {
  const data = await archive(),
    original = JSON.stringify(data.replay);
  const live = Object.freeze({
    gold: "52",
    inventory: Object.freeze({ crystal: "12" }),
    pending: "original-intent",
    cursor: "live-cursor",
  });
  const snapshot = JSON.stringify(live);
  const playback = new ReplayPlayback(
    {
      index: async () => collection([data.entry]),
      load: async () => data.replay,
    },
    () => {},
  );
  await playback.start();
  await playback.select(data.entry.runId);
  playback.seek(5);
  playback.play();
  assert.equal(playback.state.position, 0);
  assert.equal(playback.state.playing, true);
  playback.pause();
  playback.seek(-1);
  assert.equal(playback.state.position, 0);
  playback.seek(999);
  assert.equal(playback.state.position, 0);
  playback.seek(5);
  assert.equal(playback.state.position, 5);
  playback.stop();
  assert.equal(playback.state.playing, false);
  assert.equal(JSON.stringify(data.replay), original);
  assert.equal(JSON.stringify(live), snapshot);
});

test("late replay loads are ignored after another selection or page teardown", async () => {
  const data = await archive(),
    other = { ...data.entry, runId: "other-run", file: "other-run.json" };
  const pending = [];
  const playback = new ReplayPlayback(
    {
      index: async () => collection([data.entry, other]),
      load: (entry, signal) =>
        new Promise((resolve) => pending.push({ entry, signal, resolve })),
    },
    () => {},
  );
  await playback.start();
  const first = playback.select(data.entry.runId),
    second = playback.select(other.runId);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(data.replay);
  await first;
  assert.equal(playback.state.replay, null);
  pending[1].resolve({ ...data.replay, runId: other.runId });
  await second;
  assert.equal(playback.state.replay.runId, other.runId);
  const third = playback.select(data.entry.runId);
  playback.stop();
  pending[2].resolve(data.replay);
  await third;
  assert.equal(playback.state.replay, null);
});

test("timed playback advances recorded steps, pauses and stops at the last frame", async (context) => {
  const data = await archive();
  const playback = new ReplayPlayback(
    {
      index: async () => collection([data.entry]),
      load: async () => data.replay,
    },
    () => {},
  );
  await playback.start();
  await playback.select(data.entry.runId);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  playback.play();
  context.mock.timers.tick(3000);
  assert.equal(playback.state.position, 1);
  playback.pause();
  context.mock.timers.tick(9000);
  assert.equal(playback.state.position, 1);
  playback.seek(playback.state.frames.length - 2);
  playback.play();
  context.mock.timers.tick(3000);
  assert.equal(playback.state.position, playback.state.frames.length - 1);
  assert.equal(playback.state.playing, false);
  playback.play();
  assert.equal(playback.state.position, 0);
  playback.stop();
  context.mock.timers.tick(9000);
  assert.equal(playback.state.position, 0);
});

test("historical navigation preserves the original live route and pending wallet callback parameters", () => {
  const live =
    "https://bazaar.example/demo/?bbWalletState=original&transactionHashes=original-hash#buy-title";
  const replay = replayPageUrl(live, true),
    returned = new URL(replayPageUrl(replay, false));
  assert.equal(isReplayPage(replay), true);
  assert.equal(isReplayPage(live), false);
  assert.equal(returned.pathname, "/demo/");
  assert.equal(returned.searchParams.get("bbWalletState"), "original");
  assert.equal(returned.searchParams.get("transactionHashes"), "original-hash");
  assert.equal(returned.searchParams.has("view"), false);
});

test("the actual replay bootstrap does not initialize live config, deployment storage or live components", async () => {
  const stubs = {
    "@angular/platform-browser":
      "export async function bootstrapApplication(component){ globalThis.bootComplete(component.name); }",
    "./app/replay.component": "export class ReplayComponent {}",
    "./app/app.component":
      "throw new Error('Live component loaded'); export class AppComponent {}",
    "./load-public-config":
      "export async function loadPublicDeployment(){throw new Error('Live configuration read');}",
    "./app/deployment-session":
      "export class DeploymentSession{constructor(){throw new Error('Live storage accessed');}}",
    "./app/public-config": "export const PUBLIC_CONFIG={};",
    "./app/deployment.service": "export const DEPLOYMENT_SESSION={};",
  };
  const bundle = await build({
    entryPoints: ["apps/web/src/main.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    plugins: [
      {
        name: "controlled-bootstrap-ports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            stubs[args.path]
              ? { path: args.path, namespace: "bootstrap-test" }
              : undefined,
          );
          builder.onLoad(
            { filter: /.*/, namespace: "bootstrap-test" },
            (args) => ({ contents: stubs[args.path], loader: "js" }),
          );
        },
      },
    ],
  });
  let complete;
  const done = new Promise((resolve) => (complete = resolve));
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error("Wallet storage accessed");
      },
    },
  );
  runInNewContext(bundle.outputFiles[0].text, {
    URL,
    location: { href: "https://bazaar.example/?view=replay" },
    document: {
      baseURI: base.href,
      querySelector() {
        throw new Error("Bootstrap failed");
      },
    },
    sessionStorage: forbidden,
    localStorage: forbidden,
    fetch() {
      throw new Error("Unexpected live network call");
    },
    bootComplete: complete,
    console: {
      error() {
        complete("error");
      },
    },
  });
  assert.equal(await done, "ReplayComponent");
});
