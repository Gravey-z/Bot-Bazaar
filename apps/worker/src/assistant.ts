import {
  LivingTownClient,
  canonicalLivingTownJson,
  createRpcTransport,
} from "@bot-bazaar/chain";
import {
  parseLivingTownWorkerConfig,
  readBoundedFile,
} from "./private/living-town/config.js";
import { AssistantAuth, assistantFacts } from "./private/assistant/auth.js";
import { createAssistantServer } from "./private/assistant/server.js";
import { mkdirSync } from "node:fs";
import { AssistantStore } from "./private/assistant/store.js";
import { AssistantPipeline } from "./private/assistant/pipeline.js";
import { assistantFactSource } from "./private/assistant/facts.js";

// Separate opt-in listener. Reuse reviewed public identity/RPC config, not env secrets.
const args = process.argv.slice(2);
const initialize = args.length === 3 && args[2] === "--initialize";
if ((args.length !== 2 && !initialize) || args[0] !== "--config" || !args[1])
  throw new Error(
    "Usage: assistant --config <absolute-public-worker-config.json> [--initialize]",
  );
const config = parseLivingTownWorkerConfig(readBoundedFile(args[1], 32768));
if (
  config.boundary.allowedOrigins.length !== 1 ||
  config.inbox ||
  config.activityInbox
)
  throw new Error("Assistant requires one exact origin and no inboxes");
const client = new LivingTownClient(
  config.identity,
  createRpcTransport(config.public.rpcUrl),
);
const auth = new AssistantAuth(
  config.boundary.allowedOrigins[0]!,
  canonicalLivingTownJson(config.identity),
  assistantFacts(client),
);
if (!config.public.workerUrl)
  throw new Error(
    "Confirmed projection URL required for assistant recommendations",
  );
if (initialize) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const store = new AssistantStore(
  config.dataDir,
  canonicalLivingTownJson(config.identity),
  initialize,
);
// Standalone mode is explicitly rules fallback. Paid inference must be injected by
// the existing shared budget owner, never by opening a fresh assistant allowance.
const pipeline = new AssistantPipeline(
  store,
  assistantFactSource(client, config.public.workerUrl),
);
const server = createAssistantServer(auth, pipeline);
// Loopback listener behind an origin-preserving HTTPS proxy; never trust XFF.
server.listen(config.port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => server.close(() => store.close()));
