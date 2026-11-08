import { resolve } from "node:path";
import { parseLivingTownIdentity } from "../packages/chain/dist/index.js";
import {
  readBoundedFile,
  parseLivingTownWorkerConfig,
} from "../apps/worker/dist/private/living-town/config.js";
import { LivingTownProjectionStore } from "../apps/worker/dist/private/living-town/store.js";
import {
  createTownBackup,
  verifyTownBackup,
  restoreTownBackup,
} from "../apps/worker/dist/private/living-town/backup.js";

const [action, configPath, input, output] = process.argv.slice(2);
if (
  !configPath ||
  !input ||
  !["create", "verify", "restore"].includes(action) ||
  (action !== "verify") !== !!output ||
  process.argv.length !== (action === "verify" ? 5 : 6)
)
  throw Error(
    "Usage: living-town-backup <create|verify|restore> <public-reader-config.json> <economy-config.json|bundle-directory> [new-output-directory]",
  );
const settings = readBoundedFile(resolve(configPath), 32768);
const identity = parseLivingTownIdentity(settings?.identity ?? settings);
let result;
if (action === "create") {
  const config = parseLivingTownWorkerConfig(settings);
  // Stop the source read process first: its exclusive journal lock is respected.
  const store = new LivingTownProjectionStore(config.dataDir, config.identity);
  try {
    result = await createTownBackup(
      store,
      resolve(output),
      readBoundedFile(resolve(input), 65536),
    );
  } finally {
    store.close();
  }
} else if (action === "verify")
  result = await verifyTownBackup(resolve(input), identity);
else
  result = await restoreTownBackup(resolve(input), resolve(output), identity);
console.log(
  JSON.stringify(
    {
      action,
      mode: result.mode,
      checkpoint: result.report.checkpoint,
      receipts: result.report.receipts,
      missingProofs: result.report.missingProofs,
      accountingThrough: result.report.accountingThrough,
      historyComplete: result.report.historyComplete,
      stateSha256: result.report.stateSha256,
    },
    null,
    2,
  ),
);
