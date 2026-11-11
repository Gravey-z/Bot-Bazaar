import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Explicit, finite account setup; never starts a reader, guest service or runtime.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/worker/package.json", import.meta.url));
const { KeyPair } = await import(pathToFileURL(require.resolve("near-api-js")).href);
const privateDir = path.join(root, "data/guest-secrets");
const evidenceDir = path.join(root, "data/guest-setup");
const credentialFile = path.join(privateDir, "parent.json");
const encryptionFile = path.join(privateDir, "encryption.json");
const configFile = path.join(root, "data/living-town-guest.local.json");
const profileFile = path.join(root, "config/living-town-testnet.json");
const profile = JSON.parse(readFileSync(profileFile, "utf8"));
const saveNew = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const read = file => JSON.parse(readFileSync(file, "utf8"));
const mode = process.argv[2];
if (!["prepare", "create", "configure"].includes(mode)) throw Error("Use prepare|create <near-cli-runner>|configure");
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
if (mode === "prepare") {
  if (existsSync(configFile)) throw Error("Guest configuration already exists; preserve established custody state");
  if (!existsSync(credentialFile)) {
    const key = KeyPair.fromRandom("ed25519");
    saveNew(credentialFile, { account_id: `bb-guests-${randomBytes(5).toString("hex")}.testnet`,
      public_key: key.getPublicKey().toString(), private_key: key.toString() });
  }
  if (!existsSync(encryptionFile)) saveNew(encryptionFile, { key_base64: randomBytes(32).toString("base64") });
  const parent = read(credentialFile);
  console.info(JSON.stringify({ prepared: true, accountId: parent.account_id, credentialFile, encryptionFile }));
} else {
  const parent = read(credentialFile);
  const rpc = async (method, params) => {
    const response = await fetch(profile.public.rpcUrl, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "guest-setup", method, params }) });
    if (!response.ok) throw Error(`Testnet RPC HTTP ${response.status}`);
    return response.json();
  };
  const status = await rpc("status", []);
  if (status.result?.chain_id !== "testnet") throw Error("Testnet RPC required");
  const account = await rpc("query", { request_type: "view_account", account_id: parent.account_id, finality: "final" });
  if (mode === "create") {
    if (account.result) throw Error("Account already exists; use configure to verify it without another faucet request");
    if (account.error?.cause?.name !== "UNKNOWN_ACCOUNT") throw Error("RPC did not establish account absence");
    const runner = process.argv[3];
    if (!runner || !existsSync(runner)) throw Error("Provide the installed near-cli-rs run-near.js path");
    saveNew(path.join(evidenceDir, "faucet-intent.json"), { account_id: parent.account_id, public_key: parent.public_key, at: new Date().toISOString() });
    const result = spawnSync(process.execPath, [runner, "account", "create-account", "sponsor-by-faucet-service",
      parent.account_id, "use-manually-provided-public-key", parent.public_key, "network-config", "testnet", "create"],
    { cwd: root, encoding: "utf8", timeout: 90000, maxBuffer: 262144, windowsHide: true });
    // This command receives only a public key. Never pass private keys to the CLI or logs.
    saveNew(path.join(evidenceDir, "faucet-result.json"), { account_id: parent.account_id, exitCode: result.status,
      stdout: result.stdout ?? "", stderr: result.stderr ?? "", at: new Date().toISOString() });
    console.info(JSON.stringify({ accountId: parent.account_id, exitCode: result.status, evidence: evidenceDir }));
    if (result.error || result.status !== 0) throw Error("Faucet command did not complete successfully. Preserve this key and intent; reconcile before any retry.");
  } else {
    if (!account.result) throw Error("Account not confirmed at finality; no local guest configuration written");
    const access = await rpc("query", { request_type: "view_access_key", account_id: parent.account_id,
      public_key: parent.public_key, finality: "final" });
    if (access.result?.permission !== "FullAccess") throw Error("Matching full-access parent key required");
    if (BigInt(account.result.amount) < 70000000000000000000000n) throw Error("Parent balance insufficient for first guest plus storage/fees");
    const example = read(path.join(root, "config/living-town-guest.example.json"));
    const readerFile = path.join(root, "data/living-town-reader.local.json");
    const reader = read(readerFile);
    if (reader.identity.deployment.contract_id !== profile.identity.deployment.contract_id)
      throw Error("Reader deployment mismatch");
    const outbox = reader.receipt_inbox;
    if (typeof outbox !== "string" || !path.isAbsolute(outbox)) throw Error("Configure the reader's public receipt inbox first");
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    const config = { ...example, profile_file: profileFile, data_dir: path.join(root, "data/guest-custody"),
      encryption_key_file: encryptionFile, funder_key_file: credentialFile,
      funding_witness_file: path.join(root, "data/guest-witness/authority.json"), receipt_outbox: outbox,
      parent_account_id: parent.account_id, frontend_origin: "http://127.0.0.1:4200", trusted_proxy_ips: ["127.0.0.1"] };
    saveNew(configFile, config);
    saveNew(path.join(evidenceDir, "verified-account.json"), { account_id: parent.account_id, public_key: parent.public_key,
      balance_yocto: account.result.amount, block_height: account.result.block_height, block_hash: account.result.block_hash,
      permission: access.result.permission, verified_at: new Date().toISOString() });
    console.info(JSON.stringify({ configured: true, accountId: parent.account_id, balanceYocto: account.result.amount,
      configFile, servicesStarted: false }));
  }
}
