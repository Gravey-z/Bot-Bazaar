import { boundedTownRpc, resilientTownRpc } from "./private/living-town/runtime-rpc.js";
import { mkdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { drainRuntimeOutbox } from "./private/living-town/runtime-outbox.js";
import { TownOperations } from "./private/living-town/operations.js";
import { verifyTownBackup } from "./private/living-town/backup.js";
import { LivingTownClient } from "@bot-bazaar/chain";
import {
  readBoundedFile,
  parseLivingTownWorkerConfig,
  readReceiptInbox,
  readAgentActivityInbox,
} from "./private/living-town/config.js";
import { LivingTownProjectionStore } from "./private/living-town/store.js";
import { LivingTownProjector } from "./private/living-town/projector.js";
import { readLivingTownHealth } from "./private/living-town/health.js";
import { createReadServer } from "./private/read-api/server.js";
import { ReadApiError } from "./private/activity/repository.js";
import { PlayerReceipts } from "./private/living-town/player-receipts.js";
import { LivingTownGameViews } from "./private/living-town/game-views.js";
import { playerReceiptHandler } from "./private/living-town/player-receipt-handler.js";

// Projection and untrusted receipt hints only: no signer, inference, scheduler or runtime env.
const args = process.argv.slice(2),
  initialize = args.length === 3 && args[2] === "--initialize";
if (args[0] !== "--config" || !args[1] || (args.length !== 2 && !initialize))
  throw new Error(
    "Usage: living-town --config <absolute-public-config.json> [--initialize]",
  );
const config = parseLivingTownWorkerConfig(readBoundedFile(args[1], 32768));
const operations = new TownOperations("read_projection");
// Reader and signing worker are separate processes: each has its own limiter.
// Conservative per-process pacing reduces aggregate load on public Testnet RPC.
const rpc = boundedTownRpc(resilientTownRpc(config.public.rpcUrl), 1200, 2);
console.log(JSON.stringify({ role: "read_projection", event: "rpc_client_config",
  endpoint: new URL(config.public.rpcUrl).host, spacing_ms: 1200,
  max_concurrent_reads: 2, shared_limiter: false }));
if (initialize) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const store = new LivingTownProjectionStore(
    config.dataDir,
    config.identity,
    initialize,
  ),
  client = new LivingTownClient(config.identity, (method, params) =>
    operations.measure("chain", () => rpc(method, params)),
  ),
  projector = new LivingTownProjector(client, store);
const playerReceipts = new PlayerReceipts(config.dataDir, config.identity);
const gameViews = new LivingTownGameViews(config.dataDir, config.identity, store);
projector.observeReceipts(receipt => gameViews.applyReceipt(receipt));
let stopping = false,
  running: Promise<void> | undefined;
let backupCheckAt = 0,
  lastSyncDiagnosticAt = 0,
  lastReportDiagnosticAt = 0,
  rpcRetryAt = 0;
const cycle = (): Promise<void> => {
  if (running) return running;

  running = (async () => {
    const started = performance.now();
    let failed = false;

    try {
      if (Date.now() < rpcRetryAt) {
        return;
      }

      const initialSyncNeeded = !store.cursor() || store.town().stale;

  if (initialSyncNeeded) {
    await projector.sync();
  }

  await playerReceipts.drain(projector);

  if (config.inbox) {
        if ((await lstat(config.inbox)).isDirectory())
          await drainRuntimeOutbox(config.inbox, config.identity, projector);
        else
          for (const proof of readReceiptInbox(config.inbox, config.identity))
            await projector.ingest(proof);
      }
if (!initialSyncNeeded) {
  await projector.sync();
}

if (config.activityInbox)
        store.agentActivity(
          readAgentActivityInbox(config.activityInbox, config.identity),
        );
      const town = store.town();
      operations.observeSnapshot(
        Number(town.observed_at_ms),
        town.snapshot.block_timestamp_ns,
      );
    } catch (error) {
  failed = true;

  if (
    error instanceof Error &&
    error.name === "ChainRpcError" &&
    error.message === "Chain RPC: RATE_LIMITED"
  ) {
    rpcRetryAt = Date.now() + 30000;
  }

  store.invalidate();

  if (Date.now() - lastSyncDiagnosticAt >= 60000) {
        console.error(
          "V2 projection sync failed; inspect the private operations report",
        );
        if (
          error instanceof Error &&
          ["ChainRpcError", "ChainValidationError", "StorageError"].includes(
            error.name,
          )
        )
          console.error(error.message);
        lastSyncDiagnosticAt = Date.now();
      }
    } finally {
      operations.record("poll", performance.now() - started, failed);
      operations.observeDisk(config.dataDir);
      if (config.backupDirectory && Date.now() - backupCheckAt >= 300000) {
        backupCheckAt = Date.now();
        try {
          const manifest = await verifyTownBackup(
            config.backupDirectory,
            config.identity,
          );
          operations.observeBackup(
            "verified",
            manifest.capturedAt,
            manifest.report.historyComplete,
          );
        } catch {
          operations.observeBackup("failed");
        }
      }
      try {
        await operations.persist(config.dataDir);
      } catch {
        if (Date.now() - lastReportDiagnosticAt >= 60000) {
          console.error("V2 operations report write failed");
          lastReportDiagnosticAt = Date.now();
        }
      }
    }
  })().finally(() => {
    running = undefined;
  });
  return running;
};
const server = createReadServer(
  {
    health: () => readLivingTownHealth(store),
    activity: () => {
      throw new ReadApiError(503, "read_unavailable");
    },
    livingTown: Object.freeze({
      events: (after: string | null, limit: number) =>
        store.events(after, limit),
      town: () => store.town(),
      gameView: (account: string) => gameViews.read(account),
      merchantContext: () => store.merchantContext(),
      directory: (after: string | null, limit: number) => store.directory(after, limit),
      offers: () => store.offers(),
      listings: (after: string | null, limit: number) =>
        store.listings(after, limit),
      history: (id: string, after: string | null, limit: number) =>
        store.history(id, after, limit),
      shop: (id: string) => store.shopView(id),
      inventory: (id: string) => store.inventory(id),
      production: (id: string, after: string | null, limit: number) =>
        store.production(id, after, limit),
    }),
  },
  config.boundary,
  (duration, status) => operations.record("api", duration, status >= 400),
  playerReceiptHandler(playerReceipts, config.boundary),
);
server.listen(config.port, process.env["BAZAAR_CONTAINER_LISTEN"] === "true" ? "0.0.0.0" : "127.0.0.1");
let timer: NodeJS.Timeout | undefined;
const poll = async (): Promise<void> => {
  if (stopping) return;
  await cycle();
  if (!stopping)
    timer = setTimeout(() => {
      void poll();
    }, config.pollMs);
};
void poll();
// Display collection cannot hold up receipt confirmation or the public projection.
let viewTimer: NodeJS.Timeout | undefined;
let viewRunning: Promise<void> | undefined;
let lastViewDiagnostic = 0;
const pollViews = async (): Promise<void> => {
  if (stopping) return;

  if (Date.now() < rpcRetryAt) {
    viewTimer = setTimeout(() => {
      void pollViews();
    }, 15000);
    return;
  }
  viewRunning = gameViews.sync(client).catch((error: unknown) => {
  if (
    error instanceof Error &&
    error.name === "ChainRpcError" &&
    error.message === "Chain RPC: RATE_LIMITED"
  ) {
    rpcRetryAt = Date.now() + 30000;
  }
    if (Date.now() - lastViewDiagnostic > 60000) {
      console.error("Player display sync delayed; retained snapshots will be marked stale.");
      lastViewDiagnostic = Date.now();
    }
  });
  await viewRunning;
  if (!stopping) viewTimer = setTimeout(() => { void pollViews(); }, 15000);
};
void pollViews();
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  if (viewTimer) clearTimeout(viewTimer);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await running;
  await viewRunning;
  playerReceipts.close();
  gameViews.close();
  store.close();
};
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
const managedStop = (): void => {
  void stop().finally(() => { if (process.connected) process.disconnect(); });
};
process.on("message", message => { if (message === "bazaar:stop") managedStop(); });
process.once("disconnect", managedStop);
process.channel?.unref();
