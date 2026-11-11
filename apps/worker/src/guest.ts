import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { relative, isAbsolute, dirname, sep } from "node:path";
import { ChainRpcError } from "@bot-bazaar/chain";
import { readBoundedFile } from "./private/living-town/config.js";
import { guestConfig, guestCheck } from "./private/guest/config.js";
import { GuestVault } from "./private/guest/vault.js";
import { GuestStore } from "./private/guest/store.js";
import { guestFunder, GuestProvisioner } from "./private/guest/provisioner.js";
import { createGuestServer } from "./private/guest/server.js";
import { GuestActions } from "./private/guest/actions.js";
import { boundedTownRpc, resilientTownRpc } from "./private/living-town/runtime-rpc.js";

const args = process.argv.slice(2);
const initialize = args.length === 3 && args[2] === "--initialize";
if (args[0] !== "--config" || !args[1] || (args.length !== 2 && !initialize))
  throw new Error("Usage: guest --config <absolute-guest-config.json> [--initialize]");
const config = guestConfig(readBoundedFile(args[1], 16384));
if (initialize) mkdirSync(config.directory, { recursive: true, mode: 0o700 });
if (initialize) mkdirSync(dirname(config.witnessFile), { recursive: true, mode: 0o700 });
guestCheck(lstatSync(config.directory).isDirectory() && !lstatSync(config.directory).isSymbolicLink());
const actualDirectory = realpathSync(config.directory);
for (const file of [config.masterFile, config.funderFile]) {
  const rel = relative(actualDirectory, realpathSync(file));
  guestCheck(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel), "guest_secrets_must_be_outside_database_directory");
}
const witnessRelative = relative(actualDirectory, realpathSync(dirname(config.witnessFile)));
guestCheck(witnessRelative === ".." || witnessRelative.startsWith(".." + sep) || isAbsolute(witnessRelative), "guest_witness_must_be_outside_database_directory");
const vault = new GuestVault(config.masterFile);
const funder = guestFunder(config);
const store = new GuestStore(config, vault, initialize, funder.publicKey);
const rpc = boundedTownRpc(resilientTownRpc(config.profile.public.rpcUrl));
const provisioner = new GuestProvisioner(config, store, rpc, funder);
const guestActions = new GuestActions(config, store, rpc);
const server = createGuestServer(config, store);
let stopping = false, timer: ReturnType<typeof setTimeout> | undefined;
let lastDiagnostic = 0;
const diagnostic = (error: unknown): void => {
  if (Date.now() - lastDiagnostic >= 60000) {
    console.error("Guest work awaits original-transaction recovery or configuration repair; preserve its keys and journal.");
    if (error instanceof ChainRpcError)
      console.error(`Guest RPC: ${error.code}${error.rpcCause ? ` (${error.rpcCause})` : ""}${error.transactionReason ? `: ${error.transactionReason}` : ""}`);
    lastDiagnostic = Date.now();
  }
};
let cycle: Promise<void> = Promise.resolve();
const runCycle = async (): Promise<void> => {
  if (stopping) return;
  try { await provisioner.poll(); } catch (error) { diagnostic(error); }
  if (!stopping) try { await guestActions.poll(); } catch (error) { diagnostic(error); }
  if (!stopping) timer = setTimeout(() => { void poll(); }, config.pollMs);
};
const poll = (): Promise<void> => { cycle = runCycle(); return cycle; };
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true; provisioner.stop(); guestActions.stop(); if (timer) clearTimeout(timer);
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await provisioner.settled(); await cycle; store.close(); vault.close();
};
server.once("error", () => { console.error("Guest listener unavailable"); process.exitCode = 1; void stop(); });
server.listen(config.port, "127.0.0.1", () => { void poll(); });
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
// IPC allows the local launcher to request graceful shutdown on Windows too.
const managedStop = (): void => {
  void stop().finally(() => { if (process.connected) process.disconnect(); });
};
process.on("message", message => { if (message === "bazaar:stop") managedStop(); });
process.once("disconnect", managedStop);
process.channel?.unref();
