import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerStore } from "../dist/private/storage/database.js";
import { DiscoveryObserver } from "../dist/private/discovery/observer.js";
import { Scheduler } from "../dist/private/scheduling/scheduler.js";
import { ProviderRunner } from "../dist/private/retries/provider.js";
import {
  buildMerchantPrompt,
  promptVersion,
} from "../dist/private/prompts/merchant-prompt.js";
import { fixture, captured } from "./chain-fixture.mjs";
import { inferenceFixture } from "./policy-fixture.mjs";

export async function setupInferenceFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "bazaar-inference-")),
    chain = fixture(),
    config = {
      dataDir,
      identity: chain.identity,
      policyVersion: "v1",
      create: true,
    };
  let store = new WorkerStore(config);
  await new DiscoveryObserver(chain.client, store).poll();
  const state = store.discoveryState(),
    now = Date.now();
  state.observedAt = now;
  state.block.timestampNs = String(BigInt(now) * 1000000n);
  state.market.block_timestamp_ns = state.block.timestampNs;
  const rex = state.market.data.merchants.find(
    (row) => row.merchant_id === "rex",
  );
  rex.inventory.crystal = "3";
  rex.gold = "228";
  rex.listings[0].quantity = "3";
  const trade = {
    ...structuredClone(captured.steps[1].result.data),
    settled_at_ns: state.block.timestampNs,
  };
  store.commitDiscovery({
    previousHash: state.block.hash,
    state,
    signals: [
      { key: "purchase:1", kind: "player_purchase", merchantId: "rex", trade },
    ],
  });
  new Scheduler(store).tick(now);
  store.db.exec("UPDATE deployment SET recovery_required=0");
  store.recordMerchantCheckpoint("rex", "0", null, true);
  const turn = store.scheduler.nextTurn();
  store.scheduler.claimTurn(turn.id, now);
  const prompt = buildMerchantPrompt(
    state,
    {
      merchantId: "rex",
      phase: "decision",
      rootDeadline: now + 120000,
      modelCallsRemaining: 6,
      mutationsRemaining: 8,
      rexShortageMode: true,
      commitments: [],
      rejectedOfferIds: [],
    },
    now,
  );
  let payload = JSON.stringify({
    model: "fixture-model",
    messages: prompt.messages,
    max_output_tokens: 512,
  });
  const makeRunner = () => {
    const accounting = inferenceFixture(store);
    return new ProviderRunner(store, undefined, {
      prepare: (request) => ({ ...accounting.prepare(request), payload }),
    });
  };
  let runner = makeRunner();
  t.after(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    config,
    chain,
    state,
    now,
    turn,
    prompt,
    request: {
      id: "inference:1",
      turnId: turn.id,
      provider: "near-ai",
      model: "fixture-model",
      promptVersion,
    },
    get store() {
      return store;
    },
    get runner() {
      return runner;
    },
    get payload() {
      return payload;
    },
    setPayload(value) {
      payload = value;
    },
    async reopen() {
      await store.close();
      store = new WorkerStore({ ...config, create: false });
      runner = makeRunner();
    },
  };
}
