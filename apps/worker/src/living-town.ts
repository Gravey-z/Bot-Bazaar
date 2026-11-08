import { mkdirSync } from "node:fs";
import { TownOperations } from "./private/living-town/operations.js";
import { verifyTownBackup } from "./private/living-town/backup.js";
import { LivingTownClient, createRpcTransport } from "@bot-bazaar/chain";
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

// Separate read-only V2 process: no signer, inference, scheduler or runtime env.
const args = process.argv.slice(2),
  initialize = args.length === 3 && args[2] === "--initialize";
if (args[0] !== "--config" || !args[1] || (args.length !== 2 && !initialize))
  throw new Error(
    "Usage: living-town --config <absolute-public-config.json> [--initialize]",
  );
const config = parseLivingTownWorkerConfig(readBoundedFile(args[1], 32768));
const operations = new TownOperations("read_projection");
const rpc = createRpcTransport(config.public.rpcUrl);
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
let stopping = false,
  running: Promise<void> | undefined;
let backupCheckAt = 0,
  lastSyncDiagnosticAt = 0,
  lastReportDiagnosticAt = 0;
const cycle = (): Promise<void> => {
  if (running) return running;
  running = (async () => {
    const started = performance.now();
    let failed = false;
    try {
      if (!store.cursor()) await projector.sync();
      if (config.inbox)
        for (const proof of readReceiptInbox(config.inbox, config.identity))
          await projector.ingest(proof);
      await projector.sync();
      if (config.activityInbox)
        store.agentActivity(
          readAgentActivityInbox(config.activityInbox, config.identity),
        );
      const town = store.town();
      operations.observeSnapshot(
        Number(town.observed_at_ms),
        town.snapshot.block_timestamp_ns,
      );
    } catch {
      failed = true;
      store.invalidate();
      if (Date.now() - lastSyncDiagnosticAt >= 60000) {
        console.error(
          "V2 projection sync failed; inspect the private operations report",
        );
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
);
server.listen(config.port, "127.0.0.1");
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
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await running;
  store.close();
};
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
