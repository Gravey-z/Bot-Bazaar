import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { canonicalLivingTownJson as canonical, LivingTownClient, createRpcTransport } from "../packages/chain/dist/index.js";
import { near, demoRpc, result, sendDemoTransaction } from "./living-town-demo-deployment.mjs";
import { parseTownRuntimeConfig } from "../apps/worker/dist/private/living-town/runtime-config.js";
import { LivingTownExecutionStore } from "../apps/worker/dist/private/living-town/execution-store.js";
import { RuntimeFacts } from "../apps/worker/dist/private/living-town/runtime-facts.js";
import { RuntimeBudget } from "../apps/worker/dist/private/living-town/runtime-budget.js";
import { RuntimeOwner } from "../apps/worker/dist/private/living-town/runtime-owner.js";
import { guestConfig } from "../apps/worker/dist/private/guest/config.js";
import { GuestStore } from "../apps/worker/dist/private/guest/store.js";
import { GuestVault } from "../apps/worker/dist/private/guest/vault.js";

// Explicit offline, same-schema code upgrade. Never initializes/reset custody,
// execution, funding or inference journals. Backups and signed intents survive.
const root = fileURLToPath(new URL("../", import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const runtimeFile = path.join(root, "data/living-town-runtime.dev-ai.local.json");
const guestFile = path.join(root, "data/living-town-guest.local.json");
const readerFile = path.join(root, "data/living-town-reader.local.json");
const runtime = parseTownRuntimeConfig(read(runtimeFile));
const guestRaw = read(guestFile), readerRaw = read(readerFile);
const guest = guestConfig(guestRaw);
const vault = new GuestVault(guest.masterFile);
const funderPublic = read(guest.funderFile).public_key;
const oldIdentity = runtime.identity;

function verifyLocal() {
  const store = new LivingTownExecutionStore(runtime.executionDir, runtime.identity, runtime.seed, false, true);
  const facts = new RuntimeFacts(runtime.executionDir, runtime.identity, false);
  const budget = new RuntimeBudget(runtime.provider.budgetDir, runtime.provider.budgetWitnessDir);
  const owner = new RuntimeOwner(store, facts, runtime.witnessDir,
    Object.fromEntries(Object.entries(runtime.keys).map(([lane, key]) => [lane, key.publicKey])), false, budget);
  const custody = new GuestStore(guest, vault, false, funderPublic);
  try {
    owner.verify();
    assert.equal(store.unresolved().length, 0, "Recover original merchant transactions before upgrading");
  } finally { custody.close(); owner.close(); budget.close(); facts.close(); store.close(); }
}
function sql(file, work) {
  const db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    db.exec("BEGIN IMMEDIATE");
    const value = work(db);
    db.exec("COMMIT");
    return value;
  } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  finally { db.close(); }
}
const executionDigest = db => hash(JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
  assert.match(name, /^[a-z_]+$/);
  const rows = db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
  if (name === "deployment") for (const row of rows) { delete row.feed_generation; delete row.recovery_required; }
  return [name, rows];
})));
const factsDigest = db => hash(JSON.stringify([
  db.prepare("SELECT * FROM facts").all(), db.prepare("SELECT * FROM trades ORDER BY id").all(),
  db.prepare("SELECT * FROM last_sales ORDER BY shop,item").all(),
  db.prepare("SELECT * FROM purchase_events ORDER BY length(trade_id),trade_id").all(),
  db.prepare("SELECT * FROM facts_offers ORDER BY length(offer_id),offer_id").all(),
]));
async function prepare(directory, description) {
  assert.equal(oldIdentity.deployment.network_id, "testnet");
  assert.equal(oldIdentity.deployment.state_schema, "2");
  assert.equal(canonical(guest.profile.identity), canonical(oldIdentity));
  assert.equal(canonical(readerRaw.identity), canonical(oldIdentity));
  assert(!fs.existsSync(directory), "Use a new upgrade directory");
  verifyLocal();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of ["backup", "staged", "private", "public"]) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
  const wasm = fs.readFileSync(path.join(root, "data/build/bot_bazaar_living_town.wasm"));
  const codeHash = near.baseEncode(createHash("sha256").update(wasm).digest());
  assert.notEqual(codeHash, oldIdentity.codeHash, "No code change to deploy");
  const nextIdentity = { ...oldIdentity, codeHash };
  fs.writeFileSync(path.join(directory, "public/new.wasm"), wasm);
  const network = { rpc_url: runtime.public.rpcUrl, private_dir: path.join(directory, "private"), public_dir: path.join(directory, "public") };
  const rpc = demoRpc(network);
  assert.equal((await result(rpc, "status", {})).chain_id, "testnet");
  const head = await result(rpc, "block", { finality: "final" });
  const query = (request_type, extra = {}) => result(rpc, "query", { request_type, account_id: oldIdentity.deployment.contract_id, block_id: head.header.hash, ...extra });
  assert.equal((await query("view_account")).code_hash, oldIdentity.codeHash);
  const credential = read(path.join(root, "data/phase7-demo/private/contract.json"));
  assert.equal(credential.account_id, oldIdentity.deployment.contract_id);
  assert.equal((await query("view_access_key", { public_key: credential.public_key })).permission, "FullAccess");
  const oldCode = Buffer.from((await query("view_code")).code_base64, "base64");
  assert.equal(near.baseEncode(createHash("sha256").update(oldCode).digest()), oldIdentity.codeHash);
  fs.writeFileSync(path.join(directory, "public/previous.wasm"), oldCode);
  const client = new LivingTownClient(oldIdentity, createRpcTransport(runtime.public.rpcUrl));
  const town = await (await client.finalized()).getTown();
  write(path.join(directory, "public/town-before.json"), town);
  const state = await query("view_state", { prefix_base64: "", include_proof: false });
  write(path.join(directory, "public/state-before.json"), state);
  const files = [];
  async function stage(original, mutate, database = false) {
    const index = String(files.length).padStart(2, "0");
    const saved = path.join(directory, "backup", index), staged = path.join(directory, "staged", index);
    if (database) {
      const db = new DatabaseSync(original);
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); await backup(db, saved); } finally { db.close(); }
    } else fs.copyFileSync(original, saved);
    fs.chmodSync(saved, 0o600);
    fs.copyFileSync(saved, staged);
    await mutate(staged);
    fs.chmodSync(staged, 0o600);
    files.push({ original, saved, staged, before: hash(fs.readFileSync(original)), after: hash(fs.readFileSync(staged)) });
    return staged;
  }
  const encoded = canonical(nextIdentity);
  const worker = await stage(path.join(runtime.executionDir, "worker.sqlite"), f => sql(f, db => {
    assert.equal(db.prepare("SELECT identity FROM deployment").get().identity, canonical(oldIdentity));
    db.prepare("UPDATE deployment SET identity=?").run(encoded);
  }), true);
  const facts = await stage(path.join(runtime.executionDir, "facts.sqlite"), f => sql(f, db => db.prepare("UPDATE facts SET identity=?").run(encoded)), true);
  const digest = hash(canonical({ execution: sql(worker, executionDigest), facts: sql(facts, factsDigest) }));
  await stage(path.join(runtime.witnessDir, "continuity.sqlite"), f => sql(f, db => {
    const binding = JSON.parse(db.prepare("SELECT binding FROM witness").get().binding);
    assert.equal(binding.identity, hash(canonical(oldIdentity)));
    binding.identity = hash(encoded);
    db.prepare("UPDATE witness SET binding=?,state=?,revision=revision+1").run(canonical(binding), digest);
  }), true);
  let guestWitness;
  await stage(path.join(guest.directory, "guests.sqlite"), f => sql(f, db => {
    assert.equal(db.prepare("SELECT count(*) n FROM guest_actions WHERE status NOT IN ('confirmed','failed')").get().n, 0, "Recover original guest actions first");
    assert.equal(db.prepare("SELECT count(*) n FROM guests WHERE status!='active'").get().n, 0, "Recover guest provisioning first");
    const previous = db.prepare("SELECT * FROM guest_binding").get(), oldBinding = previous.value;
    const binding = JSON.parse(oldBinding);
    assert.equal(canonical(binding.identity), canonical(oldIdentity));
    binding.identity = nextIdentity;
    const nextBinding = canonical(binding);
    const reseal = (cipher, context) => cipher === null ? null : vault.seal(vault.open(cipher, `${oldBinding}:${context}`), `${nextBinding}:${context}`);
    for (const row of db.prepare("SELECT id,encrypted_key,signed_cipher FROM guests").all())
      db.prepare("UPDATE guests SET encrypted_key=?,signed_cipher=? WHERE id=?").run(reseal(row.encrypted_key, `${row.id}:key`), reseal(row.signed_cipher, `${row.id}:provision`), row.id);
    for (const row of db.prepare("SELECT guest_id,request_id,signed_cipher FROM guest_actions").all())
      db.prepare("UPDATE guest_actions SET signed_cipher=? WHERE guest_id=? AND request_id=?").run(reseal(row.signed_cipher, `${row.guest_id}:${row.request_id}:action`), row.guest_id, row.request_id);
    const revision = previous.revision + 1;
    db.prepare("UPDATE guest_binding SET value=?,revision=?").run(nextBinding, revision);
    const payload = canonical({ binding: vault.hash(nextBinding), directory: fs.realpathSync(guest.directory), host: hostname(), revision: String(revision) });
    guestWitness = { payload, mac: vault.hmac(`funding-witness:${payload}`) };
  }), true);
  await stage(guest.witnessFile, f => fs.writeFileSync(f, JSON.stringify(guestWitness) + "\n"));
  await stage(path.join(readerRaw.data_dir, "living-town.sqlite"), f => sql(f, db => {
    db.prepare("UPDATE projection_identity SET identity=?").run(encoded);
    // Keep historical receipts/accounting/activity. Reconcile current rows from
    // a newly verified baseline rather than relabel an old code checkpoint.
    db.exec("DELETE FROM projection_state");
  }), true);
  await stage(path.join(readerRaw.data_dir, "game-views.sqlite"), f => sql(f, db => {
    db.prepare("UPDATE identity SET value=?").run(encoded);
    db.exec("UPDATE views SET body=NULL,profile_json=NULL,needs_refresh=1,checked_at=0");
  }), true);
  await stage(path.join(readerRaw.data_dir, "player-receipts.sqlite"), f => sql(f, db => db.prepare("UPDATE identity SET value=?").run(encoded)), true);
  const candidates = [guestRaw.profile_file, runtimeFile, readerFile,
    path.join(root, "data/phase7-demo/runtime.json"), path.join(root, "data/phase7-demo/reader.json"),
    ...fs.readdirSync(path.join(root, "data")).filter(n => /^living-town-.*\.json$/.test(n)).map(n => path.join(root, "data", n)),
    ...fs.readdirSync(path.join(root, "config")).filter(n => /^living-town-.*\.json$/.test(n)).map(n => path.join(root, "config", n))];
  for (const file of new Set(candidates)) {
    if (!fs.existsSync(file)) continue;
    const value = read(file);
    if (value.identity && canonical(value.identity) === canonical(oldIdentity))
      await stage(file, f => write(f, { ...value, identity: nextIdentity }));
  }
  const manifest = { schema: "living-town-in-place-upgrade-v1", status: "prepared", network, oldIdentity, nextIdentity,
    transactionLabel: "upgrade-contract", description: description ?? "Update existing town contract code; preserve initialized state",
    wasmSha256: hash(wasm), beforeStateHash: hash(canonical(state.values)), files };
  write(path.join(directory, "manifest.json"), manifest);
  console.log(JSON.stringify({ status: "prepared", directory, contract: oldIdentity.deployment.contract_id, oldCodeHash: oldIdentity.codeHash, newCodeHash: codeHash, files: files.length }));
}
async function apply(directory) {
  const file = path.join(directory, "manifest.json"), m = read(file);
  assert.equal(m.schema, "living-town-in-place-upgrade-v1");
  assert.equal(m.oldIdentity.deployment.network_id, "testnet");
  const rpc = demoRpc(m.network), account = m.oldIdentity.deployment.contract_id;
  for (const f of m.files) {
    assert.equal(hash(fs.readFileSync(f.staged)), f.after, "Staged migration changed");
    assert([f.before, f.after].includes(hash(fs.readFileSync(f.original))), "Local state changed; stop services and prepare again");
  }
  const wasm = fs.readFileSync(path.join(directory, "public/new.wasm"));
  assert.equal(hash(wasm), m.wasmSha256);
  const accountState = await result(rpc, "query", { request_type: "view_account", account_id: account, finality: "final" });
  assert([m.oldIdentity.codeHash, m.nextIdentity.codeHash].includes(accountState.code_hash));
  if (accountState.code_hash === m.oldIdentity.codeHash) {
    const state = await result(rpc, "query", { request_type: "view_state", account_id: account, prefix_base64: "", include_proof: false, finality: "final" });
    assert.equal(hash(canonical(state.values)), m.beforeStateHash, "Town changed after preparation; prepare again");
  }
  const receipt = await sendDemoTransaction(m.network, m.transactionLabel ?? "upgrade-sell-out", read(path.join(root, "data/phase7-demo/private/contract.json")), account,
    [near.actions.deployContract(wasm)], m.description ?? "Update existing town code to allow retail sell-out; preserve initialized state");
  m.status = "deployed"; m.transactionHash = receipt.transaction.hash;
  write(file, m);
  const client = new LivingTownClient(m.nextIdentity, createRpcTransport(runtime.public.rpcUrl));
  const pinned = await client.finalized(), town = await pinned.getTown();
  const state = await result(rpc, "query", { request_type: "view_state", account_id: account, prefix_base64: "", include_proof: false, block_id: pinned.block.hash });
  assert.equal(hash(canonical(state.values)), m.beforeStateHash, "Unexpected state change; migration withheld for inspection");
  write(path.join(directory, "public/town-after.json"), town);
  for (const f of m.files) {
    if (hash(fs.readFileSync(f.original)) === f.after) continue;
    const temporary = `${f.original}.upgrade.tmp`;
    fs.copyFileSync(f.staged, temporary); fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, f.original);
  }
  m.status = "installed";
  write(file, m);
  console.log(JSON.stringify({ status: m.status, transactionHash: m.transactionHash, codeHash: m.nextIdentity.codeHash, stateUnchanged: true }));
}
try {
  const [mode, directory, description] = process.argv.slice(2);
  assert(["prepare", "apply", "verify-local"].includes(mode));
  if (mode === "verify-local") { verifyLocal(); console.log("Local custody, execution, funding and inference continuity verified."); }
  else {
    const target = path.resolve(directory);
    assert(target.startsWith(path.join(root, "data") + path.sep), "Upgrade evidence must stay inside workspace data");
    if (mode === "prepare") await prepare(target, description); else await apply(target);
  }
} finally { vault.close(); }
