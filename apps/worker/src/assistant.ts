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

// Separate opt-in listener. Reuse reviewed public identity/RPC config, not env secrets.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--config" || !args[1])
  throw new Error(
    "Usage: assistant --config <absolute-public-worker-config.json>",
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
const server = createAssistantServer(auth);
// Loopback listener behind an origin-preserving HTTPS proxy; never trust XFF.
server.listen(config.port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => server.close());
