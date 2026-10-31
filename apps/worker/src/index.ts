import { createServer } from "node:http";
import { ConfigurationError } from "@bot-bazaar/shared";
import { parseWorkerConfig } from "./private/config.js";
import { mkdirSync } from "node:fs";
import { WorkerStore } from "./private/storage/database.js";
import { retainBackups } from "./private/storage/backup.js";
import { MarketClient, createRpcTransport } from "@bot-bazaar/chain";
import { DiscoveryObserver } from "./private/discovery/observer.js";
import { DiscoveryLoop } from "./private/discovery/loop.js";

const config = (() => {
  try {
    return parseWorkerConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : "Worker configuration could not be loaded",
    );
    process.exit(1);
  }
})();

const store = (() => {
  try {
    const database = new WorkerStore(config.storage);
    try {
      mkdirSync(config.storage.backupDir, { recursive: true, mode: 0o700 });
    } catch {
      void database.close();
      throw new Error("backup directory unavailable");
    }
    return database;
  } catch {
    console.error(
      "Worker database unavailable; check configuration, ownership, storage and recovery requirements",
    );
    process.exit(1);
  }
})();
let backupFailed = false;
let backupCycle: Promise<void> | undefined;
const runBackup = async () => {
  try {
    store.prune();
    await store.backup(config.storage.backupDir);
    await retainBackups(config.storage.backupDir);
    backupFailed = false;
  } catch {
    backupFailed = true;
    console.error(
      "Worker backup failed; new economic work must remain stopped",
    );
  }
};
const performBackup = (): Promise<void> => {
  if (backupCycle) return backupCycle;
  backupCycle = runBackup().finally(() => {
    backupCycle = undefined;
  });
  return backupCycle;
};
await performBackup();
const backupTimer = setInterval(
  () => {
    void performBackup();
  },
  60 * 60 * 1000,
);
backupTimer.unref();
const discovery = config.discoveryEnabled
  ? new DiscoveryLoop(
      new DiscoveryObserver(
        new MarketClient(
          config.public.contractId,
          createRpcTransport(config.public.rpcUrl),
        ),
        store,
      ),
      () => {
        console.error(
          "Worker discovery unavailable; observation checkpoint was not advanced",
        );
      },
    )
  : undefined;

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        status: "not_ready",
        database: store.available ? "ready" : "unavailable",
        recovery: "required",
        backup: backupFailed ? "failed" : "verified",
        discovery: discovery?.status ?? "disabled",
      }),
    );
    return;
  }

  response.writeHead(404);
  response.end();
});

server.on("error", () => {
  console.error(
    "Worker could not listen; check HOST/PORT and whether the port is already in use",
  );
  process.exitCode = 1;
  clearInterval(backupTimer);
  void (async () => {
    await discovery?.stop();
    await store.close();
  })().catch(() => {
    process.exitCode = 1;
  });
});

server.listen(config.port, config.host, () => {
  discovery?.start();
  console.info(
    `Bot Bazaar worker scaffold listening on ${config.host}:${config.port}; provider ${config.provider.kind}`,
  );
});

const shutdown = () => {
  clearInterval(backupTimer);
  server.close(() => {
    void (async () => {
      await backupCycle;
      await discovery?.stop();
      await store.close();
    })().catch(() => {
      process.exitCode = 1;
    });
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
