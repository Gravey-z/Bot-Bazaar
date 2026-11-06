import { mkdirSync } from "node:fs";
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
if (initialize) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const store = new LivingTownProjectionStore(
    config.dataDir,
    config.identity,
    initialize,
  ),
  client = new LivingTownClient(
    config.identity,
    createRpcTransport(config.public.rpcUrl),
  ),
  projector = new LivingTownProjector(client, store);
let stopping = false,
  running: Promise<void> | undefined;
const cycle = (): Promise<void> => {
  if (running) return running;
  running = (async () => {
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
    } catch {
      store.invalidate();
      console.error(
        "V2 read projection could not advance; retained state will be labelled stale",
      );
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
