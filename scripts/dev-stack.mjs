import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, lstatSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { createServer } from "node:net";

const root = fileURLToPath(new URL("../", import.meta.url));
const localEnv = path.join(root, ".env.dev.local");
if (existsSync(localEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(localEnv, "utf8"))))
    if (process.env[key] === undefined) process.env[key] = value;
}
const { values } = parseArgs({ options: { port: { type: "string", default: "4200" } } });
if (!/^[1-9][0-9]{0,4}$/.test(values.port) || Number(values.port) > 65535)
  throw Error("--port must be 1–65535");
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) {
    if (child.connected) child.send("bazaar:stop", () => {});
  }
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
function start(label, file, args = []) {
  if (stopping) throw Error("Development startup interrupted");
  const child = spawn(process.execPath, [file, ...args], {
    cwd: root, env: process.env, stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  children.add(child);
  child.once("error", () => { console.error(`${label} could not start`); stop(1); });
  child.once("exit", code => {
    children.delete(child);
    if (!stopping) { console.error(`${label} exited; stopping this development session`); stop(code || 1); }
  });
  return child;
}
async function requireFreePort(port) {
  if (stopping) throw Error("Development startup interrupted");
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(Error(`Port ${port} is already in use. Stop the old service, or use dev:web:only to manage backends yourself.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
function initialization(directory, database) {
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()))
    throw Error("Development data must use a regular directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path.join(directory, database))) return [];
  if (readdirSync(directory).length)
    throw Error(`Missing ${database} in a nonempty directory. Preserve existing state and repair its configuration; automatic initialization refused.`);
  return ["--initialize"];
}

try {
  if ((process.env.WEB_EXPERIENCE ?? "living-town") === "living-town") {
    if ((process.env.LIVING_TOWN_TARGET ?? "local") !== "local")
      throw Error("dev:web manages local services only. Use dev:web:only for externally managed services.");
    console.info("Building local worker (no tests)…");
    const built = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "apps/worker/tsconfig.json"], { cwd: root, stdio: "inherit" });
    if (built.error || built.status !== 0) throw Error("Worker build failed; no services started");
    const { parseLivingTownWorkerConfig } = await import("../apps/worker/dist/private/living-town/config.js");
    const { canonicalLivingTownJson } = await import("../packages/chain/dist/index.js");
    const readerFile = path.resolve(root, process.env.DEV_READER_CONFIG ?? "data/living-town-reader.local.json");
    const generatedReader = !existsSync(readerFile);
    if (!existsSync(readerFile)) {
      const profile = JSON.parse(readFileSync(path.join(root, "config/living-town-testnet.json"), "utf8"));
      const directory = path.join(root, "data/dev");
      mkdirSync(path.dirname(readerFile), { recursive: true });
      writeFileSync(readerFile, JSON.stringify({
        schema: "bot-bazaar-living-town-reader-v1", identity: profile.identity,
        public: { ...profile.public, workerUrl: "http://127.0.0.1:3011" },
        data_dir: path.join(directory, "projection"), receipt_inbox: null,
        backup_directory: null, agent_activity_inbox: null, trusted_proxy_ips: [],
        port: "3011", poll_ms: "3000", allowed_origins: [`http://127.0.0.1:${values.port}`],
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
    const reader = parseLivingTownWorkerConfig(JSON.parse(readFileSync(readerFile, "utf8")));
    if (reader.port !== 3011) throw Error("The reviewed local web profile requires the reader on port 3011");
    const origin = `http://127.0.0.1:${values.port}`;
    if (!JSON.parse(readFileSync(readerFile, "utf8")).allowed_origins.includes(origin))
      throw Error(`Reader config must allow ${origin}`);
    process.env.V2_WORKER_URL = `http://127.0.0.1:${reader.port}`;
    const guestFile = path.resolve(root, process.env.DEV_GUEST_CONFIG ?? "data/living-town-guest.local.json");
    let guest;
    if (existsSync(guestFile)) {
      const { guestConfig } = await import("../apps/worker/dist/private/guest/config.js");
      guest = guestConfig(JSON.parse(readFileSync(guestFile, "utf8")));
      if (guest.origin !== origin) throw Error(`Guest frontend_origin must be ${origin}`);
      if (canonicalLivingTownJson(guest.profile.identity) !== canonicalLivingTownJson(reader.identity))
        throw Error("Guest and reader must use the same deployment identity");
      const rawReader = JSON.parse(readFileSync(readerFile, "utf8"));
      if (rawReader.receipt_inbox === null && generatedReader) {
        rawReader.receipt_inbox = guest.outbox;
        writeFileSync(readerFile, JSON.stringify(rawReader, null, 2) + "\n");
      } else if (rawReader.receipt_inbox === null || path.resolve(rawReader.receipt_inbox) !== guest.outbox)
        throw Error("Reader receipt_inbox must match the guest receipt_outbox");
      process.env.GUEST_API_URL = `http://127.0.0.1:${guest.port}`;
    } else {
      console.warn("Guest mode needs one-time setup: data/living-town-guest.local.json (see docs/LOCAL-DEVELOPMENT.md). Wallet play remains available.");
    }
    const ports = [Number(values.port), reader.port, ...(guest ? [guest.port] : [])];
    const { prepareDevMerchantRuntime } = await import("./dev-merchant-runtime.mjs");
    const merchantRuntime = await prepareDevMerchantRuntime(root, JSON.parse(readFileSync(readerFile, "utf8")));
    if (new Set(ports).size !== ports.length) throw Error("Web, reader and guest ports must differ");
    for (const port of ports) await requireFreePort(port);
    start("Town reader", "apps/worker/dist/living-town.js", ["--config", readerFile, ...initialization(reader.dataDir, "living-town.sqlite")]);
    if (guest) {
      mkdirSync(guest.outbox, { recursive: true, mode: 0o700 });
      start("Guest backend", "apps/worker/dist/guest.js", ["--config", guestFile, ...initialization(guest.directory, "guests.sqlite")]);
    }
    if (merchantRuntime) {
      console.info(`Merchant AI: ${merchantRuntime.model}; event-driven calls, no two-minute throttle or daily spending cap; $10 shared lifetime budget. Idle turns use no AI. Control: ${merchantRuntime.control}`);
      start("AI merchants", "apps/worker/dist/living-town-runtime.js", merchantRuntime.args);
    } else console.info("AI merchants disabled by DEV_AI_MERCHANTS=0.");
  }
  start("Web development server", "scripts/dev-web.mjs", ["--port", values.port]);
  console.info("Ctrl+C stops services owned by this launcher, including the merchant runtime.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Development startup failed");
  stop(1);
}
