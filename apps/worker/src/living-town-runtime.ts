import { LivingTownWorkerGroup } from "./private/living-town/worker-group.js";
import { boundedTownRpc, resilientTownRpc } from "./private/living-town/runtime-rpc.js";
import { mkdirSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  LivingTownClient,
  canonicalLivingTownJson,
} from "@bot-bazaar/chain";
import {
  parseTownRuntimeConfig,
  restrictedFileCredential,
} from "./private/living-town/runtime-config.js";
import { readBoundedFile } from "./private/living-town/config.js";
import {
  LivingTownExecutionStore,
  townLanes,
} from "./private/living-town/execution-store.js";
import { RuntimeFacts } from "./private/living-town/runtime-facts.js";
import { readSharedMerchantFacts, readSharedPlanningFacts, SharedMerchantFactsUnavailable } from "./private/living-town/shared-merchant-facts.js";
import { RuntimeOwner } from "./private/living-town/runtime-owner.js";
import { RuntimeBudget } from "./private/living-town/runtime-budget.js";
import { LivingTownProviderRunner } from "./private/living-town/provider.js";
import {
  nearAiPreflight,
  nearAiProvider,
  nearAiCredential,
} from "./private/living-town/near-ai-cloud.js";
import type { NearAiQuote } from "./private/living-town/near-ai-cloud.js";
import { sameCustomerCheckpointState } from "./private/living-town/customers.js";
import { TownChainAdapter } from "./private/living-town/town-chain.js";
import { CustomerChainAdapter } from "./private/living-town/customer-chain.js";
import { LivingTownCustomerDemand } from "./private/living-town/customers.js";
import { DurableCustomerExecutor } from "./private/living-town/customer-executor.js";
import { LivingTownTickScheduler } from "./private/living-town/ticks.js";
import { LivingTownTickRunner } from "./private/living-town/tick-runner.js";
import { LivingTownSimulationAdapter } from "./private/living-town/simulation-adapter.js";
import { LivingTownMerchantPolicy } from "./private/living-town/merchant-policy.js";
import { TownOperations } from "./private/living-town/operations.js";
import { assertRuntimePermission } from "./private/near-signer.js";
import {
  publishRuntimeOutbox,
  atomicRuntimeJson,
} from "./private/living-town/runtime-outbox.js";
import { requireStorage } from "./private/storage/validation.js";

// Install shutdown hooks before network preflight so a launcher stop is never
// lost while startup is awaiting a provider or RPC response.
let stopping = false;
const stopDelay = new AbortController();
const requestStop = (): void => { stopping = true; stopDelay.abort(); };
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, requestStop);
process.on("message", message => { if (message === "bazaar:stop") requestStop(); });
process.once("disconnect", requestStop);
process.channel?.unref();

const args = process.argv.slice(2);
requireStorage(
  args[0] === "--config" &&
    args[1] &&
    args
      .slice(2)
      .every((a) =>
        [
          "--initialize",
          "--once",
          "--check",
          "--initialize-budget",
          "--enable-provider",
          "--enable-provider-if-needed",
        ].includes(a),
      ),
  "Usage: living-town-runtime --config <absolute-config.json> [--initialize] [--once|--check]",
);
const initialize = args.includes("--initialize"),
  checkOnly = args.includes("--check"),
  once = args.includes("--once");
requireStorage(!checkOnly || !initialize, "check never initializes or signs");
requireStorage(
  !checkOnly ||
    (!args.includes("--initialize-budget") &&
      !args.includes("--enable-provider") && !args.includes("--enable-provider-if-needed")),
  "check cannot enroll a budget/provider",
);
const config = parseTownRuntimeConfig(readBoundedFile(args[1]!, 32768));
const operations = new TownOperations("simulation");
const transport = resilientTownRpc(config.public.rpcUrl);
const rpc = boundedTownRpc((method, params) =>
  operations.measure("chain", () => transport(method, params)),
  1200,
  2,
);
console.log(JSON.stringify({ role: "economic_runtime", event: "rpc_client_config",
  endpoint: new URL(config.public.rpcUrl).host, spacing_ms: 1200,
  max_concurrent_reads: 2, shared_limiter: false }));
const client = new LivingTownClient(config.identity, rpc);
const pinned = await client.finalized();
if (stopping) process.exit(0);
const verifiedNegotiatingLanes = new Set<string>();
for (const lane of [...townLanes, "customer"] as const) {
  const account =
    lane === "operator" || lane === "customer"
      ? config.identity.operatorId
      : config.identity.controllers[lane];
  const key = await pinned.getAccessKey(account, config.keys[lane].publicKey);
  assertRuntimePermission(
    key.permission,
    config.public.contractId,
    lane === "customer"
      ? "customer"
      : lane === "operator"
        ? "town_operator"
        : (key.permission as {FunctionCall?: {method_names?: string[]}})?.FunctionCall?.method_names?.includes("batch_set_listings")
          ? ((key.permission as {FunctionCall?: {method_names?: string[]}})?.FunctionCall?.method_names?.includes("propose_trade")
            ? "town_batch_negotiating_merchant" : "town_batch_merchant")
        : config.identity.deployment.state_schema === "2" &&
            ((
              key.permission as { FunctionCall?: { method_names?: string[] } }
            )?.FunctionCall?.method_names?.includes("propose_trade") ??
              false)
          ? "town_negotiating_merchant"
          : "town_merchant",
  );
  if (lane !== "operator" && lane !== "customer" &&
      (key.permission as {FunctionCall?: {method_names?: string[]}})?.FunctionCall?.method_names?.includes("propose_trade"))
    verifiedNegotiatingLanes.add(lane);
  if (initialize && lane !== "customer") {
    const command = await pinned.getCommand(
      lane === "operator" ? account : `merchant:${lane}`,
      "1",
    );
    requireStorage(
      command.data.high_water === "0",
      "new runtime cannot adopt unexplained previous commands",
    );
  }
}
if (checkOnly) {
  const directory = await mkdtemp(join(tmpdir(), "living-town-observe-"));
  const facts = new RuntimeFacts(directory, config.identity, true);
  try {
    const observed = await facts.collect(pinned);
    console.log(
      JSON.stringify({
        role: "economic_runtime_preflight",
        provider: "disabled",
        identityVerified: true,
        restrictedKeysVerified: true,
        signing: false,
        marketComplete: observed.customer.marketComplete,
        historyComplete: observed.customer.historyComplete,
        factsFresh: observed.customer.fresh,
        playerListings: observed.customer.candidates.length,
        confirmedRecentTrades: observed.merchant.trades.length,
      }),
    );
  } finally {
    facts.close();
    await rm(directory, { recursive: true, force: true });
  }
} else {
  for (const directory of [
    config.executionDir,
    config.witnessDir,
    config.outboxDir,
  ]) {
    if (initialize) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      requireStorage(
        readdirSync(directory).length === 0,
        "initialize requires new empty runtime directories",
      );
    }
    const stat = lstatSync(directory);
    requireStorage(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "regular runtime directories required",
    );
  }
  mkdirSync(dirname(config.activityFile), { recursive: true, mode: 0o700 });
  const store = new LivingTownExecutionStore(
    config.executionDir,
    config.identity,
    config.seed,
    initialize,
    true,
  );
  const facts = new RuntimeFacts(
    config.executionDir,
    config.identity,
    initialize,
    reader => readSharedMerchantFacts(config.public.workerUrl, reader),
  );
  requireStorage(
    !args.includes("--initialize-budget") || store.rulesOnlyHistory(),
    "new budget cannot replace prior provider history",
  );
  const authority =
    config.provider.kind === "near-ai"
      ? new RuntimeBudget(
          config.provider.budgetDir,
          config.provider.budgetWitnessDir,
          args.includes("--initialize-budget"),
        )
      : undefined;
  const owner = new RuntimeOwner(
    store,
    facts,
    config.witnessDir,
    Object.fromEntries(
      Object.entries(config.keys).map(([lane, key]) => [lane, key.publicKey]),
    ),
    initialize,
    authority,
  );
  owner.verify();
  store.enableBatchListings();
  if (store.negotiatedTrading) store.enableIndependentWorkers();
  if (args.includes("--enable-provider")) owner.enableProvider();
  if (args.includes("--enable-provider-if-needed") && !owner.providerEnabled) owner.enableProvider();
  store.providerAttempts.recoverInterrupted();
  const continuity = owner.attest.bind(owner);
  const adapters = {} as Record<(typeof townLanes)[number], TownChainAdapter>;
  for (const lane of townLanes) {
    const account =
      lane === "operator"
        ? config.identity.operatorId
        : config.identity.controllers[lane];
    adapters[lane] = new TownChainAdapter(
      config.identity,
      rpc,
      restrictedFileCredential(config.keys[lane], account),
      lane,
      "town_operator",
    );
  }
  const customerAdapter = new CustomerChainAdapter(
    config.identity,
    rpc,
    restrictedFileCredential(config.keys.customer, config.identity.operatorId),
  );
  // Economy is pinned in the distributed application config; providers cannot replace it.
  const economy = JSON.parse(
    readFileSync(
      new URL("../../../config/living-town-v1.json", import.meta.url),
      "utf8",
    ),
  ) as unknown;
  const demand = new LivingTownCustomerDemand(economy),
    policy = new LivingTownMerchantPolicy(economy);
  const customers = new DurableCustomerExecutor(
    store,
    demand,
    customerAdapter,
    continuity,
  );
  const scheduler = new LivingTownTickScheduler(
    store,
    demand,
    config.cadenceMs,
    true,
  );
  const collect = async (reader: Parameters<RuntimeFacts["collect"]>[0]) => {
    owner.verify();
    const result = await facts.collect(reader);
    result.merchant.externalPurchases = facts.purchasesAfter(
      store.reactions.cursor(),
    );
    // Customer turns also collect trades. Persist their merchant triggers here
    // before a higher-priority turn can return from the simulation loop.
    if (store.planningReady && store.unresolved().length === 0 && store.negotiatedTrading && result.merchant.fresh && result.merchant.historyComplete)
      store.reactions.observe(result.merchant);
    return result;
  };
  const runner = new LivingTownTickRunner(
    store,
    scheduler,
    customers,
    client,
    async (reader) => (await collect(reader)).customer,
    operations,
  );
  let providerConfiguration = null;
  let activeQuote: NearAiQuote | undefined;
  let lastQuoteRefresh = 0;
  const loadAiKey = config.provider.kind === "near-ai" ? nearAiCredential(config.provider.keyFile) : undefined;
  const admission = (): boolean => {
    const control = readBoundedFile(config.controlFile, 1024) as Record<
      string,
      unknown
    >;
    requireStorage(
      Object.keys(control).sort().join() === "mode,schema" &&
        control["schema"] === "living-town-runtime-control-v1" &&
        ["active", "paused", "recovery_only"].includes(String(control["mode"])),
      "invalid operator control file",
    );
    if (control["mode"] !== "active")
      operations.setMode(control["mode"] as "paused" | "recovery_only");
    return !stopping && control["mode"] === "active" && operations.mode === "active";
  };
  if (authority && config.provider.kind === "near-ai") {
    const loadKey = loadAiKey!;
    try {
      activeQuote = await nearAiPreflight(loadKey);
      lastQuoteRefresh = Date.now();
      providerConfiguration = nearAiProvider(
        policy,
        authority,
        activeQuote,
        loadKey,
      );
    } catch {
      operations.observeProvider("unavailable", authority.budget.status());
    }
  }
  const providerRunner = authority
    ? new LivingTownProviderRunner(
        store,
        policy,
        authority.budget,
        authority.binding,
        providerConfiguration,
        async (context) => {
          owner.verify();
          if (!admission()) return false;
          const current = await client.finalized();
          if (context.reaction)
            return (
              store.reactions.modelContext(
                context.reaction.rootId,
                context.reaction.stepId,
                context.merchant,
              ) && BigInt((await current.getTown()).block_timestamp_ns) <
                BigInt(store.reactions.work(context.reaction.stepId)!.deadlineNs)
            );
          return sameCustomerCheckpointState(
            context.facts.town,
            await current.getTown(),
          );
        },
        15000,
        "policy",
        undefined,
        operations,
        () =>
          publishRuntimeOutbox(store, config.outboxDir, config.activityFile),
      )
    : undefined;
  const simulation = new LivingTownSimulationAdapter(
    store,
    scheduler,
    customers,
    runner,
    adapters,
    policy,
    async (reader) => (await collect(reader)).merchant,
    continuity,
    providerRunner ? (context) => providerRunner.propose(context) : undefined,
    undefined,
    operations,
    {
      skipEmptySources: true,
      skipIdleMerchantTurns: true,
      merchantOpportunities: true,
      independentSupply: true,
      independentWorkers: store.negotiatedTrading && !once,
      planningCollect: async () => {
        owner.verify();
        const view = await readSharedPlanningFacts(config.public.workerUrl, config.identity);
        const input = facts.planningInput(view);
        input.externalPurchases = facts.purchasesAfter(store.reactions.cursor());
        input.pricingHistory = store.merchantPricingHistory();
        // Capabilities were pinned at startup. The executor repeats fresh key
        // permission and nonce checks before every signature.
        if (verifiedNegotiatingLanes.size === 3) input.negotiationAuthority = {
          journal: "ready", signerScopes: { rex: "town_negotiating_merchant", luna: "town_negotiating_merchant", bolt: "town_negotiating_merchant" },
        };
        return input;
      },
      // Negotiated V2 reactions invoke AI separately; legacy tick turns
      // submit only audited model decisions or wait.
      minimumTickWindowMs: authority && !store.negotiatedTrading ? 45000 : 10000,
      admission,
      ...(providerRunner ? { modelReady: () => providerRunner.canInvoke() } : {}),
    },
  );
  const planningWorkers = new LivingTownWorkerGroup(async (worker, error) => {
    await atomicRuntimeJson(join(config.executionDir, `${worker}-error.json`), {
      captured_at: Date.now(), name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });
  if (store.negotiatedTrading && !once) {
    // Retain the durable worker name, but planMaintenance now queues raw supply only.
    planningWorkers.start({ name: "maintenance", intervalMs: 10000, tick: () => simulation.planMaintenance() });
    planningWorkers.start({ name: "merchant-ai", intervalMs: 5000, tick: () => simulation.planReactions() });
    if (authority && loadAiKey && providerRunner) {
      let refreshedQuote: NearAiQuote | undefined;
      planningWorkers.start({ name: "provider-rates", intervalMs: 5000, tick: async () => {
        if (stopping || !admission()) return { kind: "deferred" };
        if (!refreshedQuote) {
          if (activeQuote && Date.now() < activeQuote.verifiedUntil - 60000) return { kind: "idle" };
          if (Date.now() - lastQuoteRefresh < 60000) return { kind: "deferred" };
          lastQuoteRefresh = Date.now();
          refreshedQuote = await nearAiPreflight(loadAiKey);
        }
        if (!providerRunner.replaceProvider(nearAiProvider(policy, authority, refreshedQuote, loadAiKey)))
          return { kind: "deferred", reason: "inference_in_progress" };
        activeQuote = refreshedQuote;
        refreshedQuote = undefined;
        return { kind: "ready" };
      } });
    }
  }
  let failures = 0;
  try {
    do {
      if (stopping) break;
      let result: unknown;
      try {
        owner.verify();
        const control = readBoundedFile(config.controlFile, 1024) as Record<
          string,
          unknown
        >;
        requireStorage(
          Object.keys(control).sort().join() === "mode,schema" &&
            control["schema"] === "living-town-runtime-control-v1" &&
            ["active", "paused", "recovery_only"].includes(
              String(control["mode"]),
            ),
          "invalid operator control file",
        );
        operations.observeDisk(config.executionDir);
        operations.setMode(
          stopping
            ? "recovery_only"
            : (control["mode"] as "active" | "paused" | "recovery_only"),
        );
        if (!authority) operations.observeProvider("disabled", null);
        await publishRuntimeOutbox(
          store,
          config.outboxDir,
          config.activityFile,
        );
        result = await simulation.poll();
        await publishRuntimeOutbox(
          store,
          config.outboxDir,
          config.activityFile,
        );
        failures = 0;
      } catch (error) {
        if (error instanceof SharedMerchantFactsUnavailable) {
          failures = 0;
          result = { kind: "deferred", reasons: ["shared_merchant_projection_not_ready"], diagnostic: error.reason };
        } else {
          failures++;
          await atomicRuntimeJson(join(config.executionDir, "runtime-error.json"), {
            captured_at: Date.now(), name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          store.invalidate();
          operations.setMode("recovery_only");
          result = {
            kind: "blocked",
            reasons: ["runtime_boundary_or_dependency_failed"],
            diagnostic:
              error instanceof Error &&
              ["StorageError", "ChainValidationError", "ChainRpcError"].includes(
                error.name,
              )
                ? error.message
                : "runtime_dependency_failed",
          };
        }
      }
      operations.observeRuntime(store.operations());
      await operations.persist(config.executionDir);
      await atomicRuntimeJson(
        join(config.executionDir, "runtime-status.json"),
        {
          schema: "living-town-runtime-status-v1",
          role: "economic_runtime",
          provider: authority ? "near-ai" : "disabled",
          merchant_context_source: "reader_projection",
          budget: authority?.budget.status() ?? null,
          captured_at: Date.now(),
          result,
          last_customer_decision: store.lastCustomerDecision(),
          last_model_action: store.latestModelAction(),
          provider_attempts: store.providerHistory().length,
          unresolved_transactions: store.unresolved().length,
          workers: planningWorkers.status(),
          queues: store.negotiatedTrading ? simulation.workerStatus() : null,
        },
      );
      console.log(
        canonicalLivingTownJson({ role: "economic_runtime", result }),
      );
      if (!once && !stopping)
        await delay(
          Math.min(
            60000,
            ((result as { kind?: string })?.kind === "advanced"
              ? config.pollMs
              : (result as { kind?: string })?.kind === "blocked"
                ? Math.max(config.pollMs, 30000)
                : Math.max(config.pollMs, 2500)) *
              2 ** Math.min(failures, 4),
          ), undefined, { signal: stopDelay.signal },
        ).catch(error => { if (!stopping) throw error; });
    } while (!once && !stopping);
  } finally {
    operations.setMode("paused");
    await planningWorkers.stop();
    await simulation.drainPlanning();
    owner.close();
    facts.close();
    store.close();
    authority?.close();
  }
}
