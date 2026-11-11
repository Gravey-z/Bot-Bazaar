import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, realpathSync, readFileSync,
  openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { KeyPair } from "near-api-js";
import { canonicalLivingTownJson } from "@bot-bazaar/chain";
import type { GuestActionRequest } from "@bot-bazaar/chain";
import { guestActivityPage } from "@bot-bazaar/chain";
import { guestActivity, guestProgress } from "./activity.js";
import type { GuestConfig } from "./config.js";
import { guestCheck } from "./config.js";
import { GuestVault } from "./vault.js";

export class GuestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface GuestRow {
  id: string; account_id: string; public_key: string; encrypted_key: string;
  status: "provisioning" | "active" | "failed" | "blocked";
  tx_hash: string | null; signed_cipher: string | null; reference_height: string | null;
  dispatch_started: number; created: number;
}
export interface GuestActionRow {
  guest_id: string; request_id: string; request_json: string; status: "queued" | "signed" | "unknown" | "confirmed" | "failed";
  proof_json: string | null; signed_cipher: string | null; tx_hash: string | null;
  dispatch_started: number; result_json: string | null; error_code: string | null; published: number;
}
export class GuestStore {
  private readonly db: DatabaseSync;
  readonly binding: string;
  constructor(readonly config: GuestConfig, readonly vault: GuestVault, initialize: boolean, funderPublicKey: string) {
    guestCheck(lstatSync(config.directory).isDirectory() && !lstatSync(config.directory).isSymbolicLink());
    const file = join(realpathSync(config.directory), "guests.sqlite");
    guestCheck(existsSync(file) || initialize, "explicit_guest_initialization_required");
    if (existsSync(file)) guestCheck(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    this.db = new DatabaseSync(file, { timeout: 1000, allowExtension: false, enableForeignKeyConstraints: true });
    chmodSync(file, 0o600);
    this.binding = canonicalLivingTownJson({ identity: config.profile.identity, parent: config.parent,
      funderPublicKey, keyId: vault.keyId, funding: config.funding, feeReserve: config.feeReserve,
      totalCap: config.totalCap, dailyCap: config.dailyCap, maxGuests: String(config.maxGuests),
      maxDaily: String(config.maxDaily), maxIpDaily: String(config.maxIpDaily), origin: config.origin });
    try {
      this.db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (!tables.length) {
        guestCheck(initialize, "explicit_guest_initialization_required");
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE guest_binding(value TEXT NOT NULL,revision INTEGER NOT NULL) STRICT;
          CREATE TABLE guests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE,public_key TEXT NOT NULL UNIQUE,
            encrypted_key TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('provisioning','active','failed','blocked')),
            tx_hash TEXT UNIQUE,signed_cipher TEXT,reference_height TEXT,dispatch_started INTEGER NOT NULL DEFAULT 0,
            created INTEGER NOT NULL,receipt_json TEXT,error_code TEXT,registration_seen INTEGER NOT NULL DEFAULT 0) STRICT;
          CREATE TABLE guest_sessions(hash TEXT PRIMARY KEY,guest_id TEXT REFERENCES guests(id),
            expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL) STRICT;
          CREATE INDEX guest_session_expiry ON guest_sessions(expires);
          CREATE TABLE guest_usage(day INTEGER NOT NULL,ip_hash TEXT NOT NULL,kind TEXT NOT NULL,
            count INTEGER NOT NULL,PRIMARY KEY(day,ip_hash,kind)) STRICT;
          CREATE TABLE guest_funding(guest_id TEXT PRIMARY KEY REFERENCES guests(id),day INTEGER NOT NULL,
            reserved TEXT NOT NULL,actual_fee TEXT) STRICT;
          CREATE TABLE guest_health(singleton INTEGER PRIMARY KEY CHECK(singleton=1),blocked INTEGER NOT NULL) STRICT;
          CREATE TABLE guest_actions(guest_id TEXT NOT NULL REFERENCES guests(id),request_id TEXT NOT NULL,
            request_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','signed','unknown','confirmed','failed')),
            proof_json TEXT,signed_cipher TEXT,tx_hash TEXT UNIQUE,dispatch_started INTEGER NOT NULL DEFAULT 0,
            result_json TEXT,error_code TEXT,published INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,checked INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(guest_id,request_id)) STRICT;
          CREATE UNIQUE INDEX guest_one_unresolved_action ON guest_actions(guest_id) WHERE status IN ('queued','signed','unknown');
          INSERT INTO guest_health VALUES(1,0); COMMIT;`);
        this.db.prepare("INSERT INTO guest_binding VALUES (?,0)").run(this.binding);
      }
      guestCheck(this.db.prepare("SELECT value FROM guest_binding").get()?.["value"] === this.binding,
        "guest_deployment_funding_or_encryption_binding_changed");
      guestCheck(this.db.prepare("PRAGMA integrity_check").get()?.["integrity_check"] === "ok");
      if (!existsSync(config.witnessFile)) {
        guestCheck(initialize && this.revision() === 0, "guest_funding_witness_required");
        this.writeWitness(0, true);
      }
      this.verifyWitness();
      // Development uses a fresh schema; never silently migrate an existing
      // custody/funding database or discard original signed intents.
      this.db.prepare("SELECT registration_seen FROM guests LIMIT 1").get();
      this.db.prepare("SELECT request_id,checked FROM guest_actions LIMIT 1").get();
    } catch (error) { this.db.close(); throw error; }
  }
  private write<T>(work: () => T): T {
    this.verifyWitness();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(), next = this.revision() + 1;
      guestCheck(Number.isSafeInteger(next));
      this.db.prepare("UPDATE guest_binding SET revision=?").run(next);
      // An ahead-of-DB witness after a crash is a repair condition, never a
      // reason to silently reset/release funding reservations or sign again.
      this.writeWitness(next);
      this.db.exec("COMMIT"); return result;
    }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private revision(): number { return Number(this.db.prepare("SELECT revision FROM guest_binding").get()!["revision"]); }
  private witness(revision: number): string {
    const payload = canonicalLivingTownJson({ binding: this.vault.hash(this.binding),
      directory: realpathSync(this.config.directory), host: hostname(), revision: String(revision) });
    return JSON.stringify({ payload, mac: this.vault.hmac(`funding-witness:${payload}`) });
  }
  private verifyWitness(): void {
    const stat = lstatSync(this.config.witnessFile);
    guestCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384, "guest_funding_witness_invalid");
    guestCheck(readFileSync(this.config.witnessFile, "utf8").trim() === this.witness(this.revision()), "guest_funding_continuity_requires_inspection");
  }
  private writeWitness(revision: number, exclusive = false): void {
    const target = exclusive ? this.config.witnessFile : `${this.config.witnessFile}.${randomUUID()}.tmp`;
    const fd = openSync(target, "wx", 0o600);
    try { writeFileSync(fd, this.witness(revision) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    if (!exclusive) renameSync(target, this.config.witnessFile);
  }
  private usage(day: number, ip: string, kind: string): void {
    this.db.prepare("INSERT INTO guest_usage VALUES (?,?,?,1) ON CONFLICT(day,ip_hash,kind) DO UPDATE SET count=count+1").run(day, ip, kind);
  }
  session(raw: string, now = Date.now()): { hash: string; guestId: string | null; expires: number } | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const hash = this.vault.hash(raw), r = this.db.prepare("SELECT guest_id,expires FROM guest_sessions WHERE hash=? AND revoked=0 AND expires>?").get(hash, now);
    return r ? { hash, guestId: r["guest_id"] as string | null, expires: Number(r["expires"]) } : null;
  }
  newSession(ip: string, now = Date.now()): { token: string; expires: number } {
    return this.write(() => {
      const day = Math.floor(now / 86400000);
      this.db.prepare("DELETE FROM guest_sessions WHERE expires<=? OR revoked=1").run(now);
      this.db.prepare("DELETE FROM guest_usage WHERE day<?").run(day - 2);
      this.usage(day, ip, "sessions");
      if (Number(this.db.prepare("SELECT count(*) AS n FROM guest_sessions").get()!["n"]) >= 5000)
        throw new GuestError(429, "guest_session_capacity");
      const token = randomBytes(32).toString("base64url"), expires = now + this.config.sessionTtlMs;
      this.db.prepare("INSERT INTO guest_sessions(hash,guest_id,expires,created) VALUES (?,NULL,?,?)")
        .run(this.vault.hash(token), expires, now);
      return { token, expires };
    });
  }
  start(sessionHash: string, ip: string, now = Date.now()): GuestRow {
    return this.write(() => {
      const s = this.db.prepare("SELECT guest_id FROM guest_sessions WHERE hash=? AND revoked=0 AND expires>?").get(sessionHash, now);
      if (!s) throw new GuestError(401, "guest_session_required");
      if (s["guest_id"]) return this.guest(String(s["guest_id"]))!;
      if (this.db.prepare("SELECT blocked FROM guest_health").get()!["blocked"] !== 0)
        throw new GuestError(503, "guest_funding_blocked");
      const day = Math.floor(now / 86400000), reservations = this.db.prepare("SELECT day,reserved FROM guest_funding").all();
      const reserve = BigInt(this.config.funding) + BigInt(this.config.feeReserve);
      const total = reservations.reduce((n, r) => n + BigInt(String(r["reserved"])), 0n);
      const daily = reservations.filter(r => Number(r["day"]) === day).reduce((n, r) => n + BigInt(String(r["reserved"])), 0n);
      if (total + reserve > BigInt(this.config.totalCap) || daily + reserve > BigInt(this.config.dailyCap))
        throw new GuestError(429, "guest_funding_cap");
      this.usage(day, "global", "guests");
      this.usage(day, ip, "guests");
      const id = randomUUID(), account = `g-${randomBytes(8).toString("hex")}.${this.config.parent}`;
      const key = KeyPair.fromRandom("ed25519");
      const encrypted = this.vault.seal(key.toString(), `${this.binding}:${id}:key`);
      this.db.prepare("INSERT INTO guests(id,account_id,public_key,encrypted_key,status,created) VALUES (?,?,?,?,'provisioning',?)")
        .run(id, account, key.getPublicKey().toString(), encrypted, now);
      this.db.prepare("INSERT INTO guest_funding(guest_id,day,reserved) VALUES (?,?,?)").run(id, day, reserve.toString());
      this.db.prepare("UPDATE guest_sessions SET guest_id=? WHERE hash=?").run(id, sessionHash);
      return this.guest(id)!;
    });
  }
  guest(id: string): GuestRow | null {
    return (this.db.prepare("SELECT * FROM guests WHERE id=?").get(id) as unknown as GuestRow | undefined) ?? null;
  }
  next(): GuestRow | null {
    if (this.fundingBlocked())
      return (this.db.prepare("SELECT * FROM guests WHERE status='provisioning' AND dispatch_started=1 ORDER BY created LIMIT 1").get() as unknown as GuestRow | undefined) ?? null;
    return (this.db.prepare("SELECT * FROM guests WHERE status='provisioning' ORDER BY (tx_hash IS NULL),created LIMIT 1").get() as unknown as GuestRow | undefined) ?? null;
  }
  fundingBlocked(): boolean { return this.db.prepare("SELECT blocked FROM guest_health").get()!["blocked"] !== 0; }
  prepared(id: string, hash: string, signed: string, height: string): void {
    this.write(() => {
      const g = this.guest(id); guestCheck(g?.status === "provisioning" && !g.tx_hash);
      this.db.prepare("UPDATE guests SET tx_hash=?,signed_cipher=?,reference_height=? WHERE id=?")
        .run(hash, this.vault.seal(signed, `${this.binding}:${id}:provision`), height, id);
    });
  }
  dispatch(id: string): void {
    this.write(() => {
    const day = Math.floor(Date.now() / 86400000);
    const funding = this.db.prepare("SELECT day,reserved FROM guest_funding WHERE guest_id=?").get(id)!;
    if (Number(funding["day"]) !== day) {
      const today = this.db.prepare("SELECT reserved FROM guest_funding WHERE day=?").all(day);
      const reserved = today.reduce((n, r) => n + BigInt(String(r["reserved"])), 0n);
      if (reserved + BigInt(String(funding["reserved"])) > BigInt(this.config.dailyCap))
        throw new GuestError(429, "guest_daily_dispatch_cap");
      // A queued account must acquire today's funding allowance before its
      // first broadcast; yesterday's backlog cannot bypass today's admission cap.
      this.db.prepare("UPDATE guest_funding SET day=? WHERE guest_id=?").run(day, id);
    }
    const result = this.db.prepare("UPDATE guests SET dispatch_started=1 WHERE id=? AND status='provisioning' AND tx_hash IS NOT NULL AND dispatch_started=0").run(id);
    guestCheck(Number(result.changes) === 1);
    });
  }
  finish(id: string, success: boolean, receipt: unknown, fee: string): void {
    this.write(() => {
      const encoded = JSON.stringify(receipt); guestCheck(Buffer.byteLength(encoded) <= 1048576);
      this.db.prepare("UPDATE guests SET status=?,receipt_json=?,error_code=? WHERE id=? AND status='provisioning'")
        .run(success ? "active" : "failed", encoded, success ? null : "account_creation_failed", id);
      this.db.prepare("UPDATE guest_funding SET actual_fee=? WHERE guest_id=?").run(fee, id);
      // Never release uncertain/failed reservations or reset historical funding.
      if (BigInt(fee) > BigInt(this.config.feeReserve)) this.db.exec("UPDATE guest_health SET blocked=1");
    });
  }
  block(id: string): void {
    this.write(() => {
      this.db.prepare("UPDATE guests SET status='blocked',error_code='provisioning_requires_inspection' WHERE id=?").run(id);
      this.db.exec("UPDATE guest_health SET blocked=1");
    });
  }
  revoke(hash: string): void { this.write(() => { this.db.prepare("UPDATE guest_sessions SET revoked=1 WHERE hash=?").run(hash); }); }
  publicGuest(id: string | null): Record<string, unknown> | null {
    const g = id ? this.guest(id) : null;
    return g ? { guestId: g.id, accountId: g.account_id, status: g.status,
      provisioningTransactionHash: g.tx_hash,
      provisioningReceiptUrl: g.tx_hash ? new URL(`/txns/${g.tx_hash}`, this.config.profile.public.explorerUrl).href : null,
      registrationObserved: !!this.db.prepare("SELECT registration_seen FROM guests WHERE id=?").get(g.id)?.["registration_seen"],
      pendingAction: this.pendingAction(g.id) ? this.publicAction(this.pendingAction(g.id)!) : null,
      capabilities: { gameplayActions: true } } : null;
  }
  enqueueAction(guestId: string, request: GuestActionRequest): GuestActionRow {
    return this.write(() => {
      const body = canonicalLivingTownJson(request), previous = this.action(guestId, request.requestId);
      if (previous) {
        if (previous.request_json !== body) throw new GuestError(409, "guest_request_id_conflict");
        return previous;
      }
      if (this.guest(guestId)?.status !== "active") throw new GuestError(409, "guest_account_not_active");
      if (this.pendingAction(guestId)) throw new GuestError(409, "guest_original_action_pending");
      const count = Number(this.db.prepare("SELECT count(*) AS n FROM guest_actions WHERE guest_id=?").get(guestId)!["n"]);
      const today = Number(this.db.prepare("SELECT count(*) AS n FROM guest_actions WHERE guest_id=? AND created>=?").get(guestId, Math.floor(Date.now() / 86400000) * 86400000)!["n"]);
      if (count >= 100 || today >= 30) throw new GuestError(429, "guest_action_limit");
      this.db.prepare("INSERT INTO guest_actions(guest_id,request_id,request_json,status,created) VALUES (?,?,?,'queued',?)")
        .run(guestId, request.requestId, body, Date.now());
      return this.action(guestId, request.requestId)!;
    });
  }
  action(guestId: string, id: string): GuestActionRow | null {
    return (this.db.prepare("SELECT * FROM guest_actions WHERE guest_id=? AND request_id=?").get(guestId, id) as unknown as GuestActionRow | undefined) ?? null;
  }
  pendingAction(guestId: string): GuestActionRow | null {
    return (this.db.prepare("SELECT * FROM guest_actions WHERE guest_id=? AND status IN ('queued','signed','unknown') LIMIT 1").get(guestId) as unknown as GuestActionRow | undefined) ?? null;
  }
  nextAction(): GuestActionRow | null {
    const action = (this.db.prepare("SELECT * FROM guest_actions WHERE status IN ('queued','signed','unknown') ORDER BY checked,created LIMIT 1").get() as unknown as GuestActionRow | undefined) ?? null;
    if (action) this.write(() => { this.db.prepare("UPDATE guest_actions SET checked=? WHERE guest_id=? AND request_id=?").run(Date.now(), action.guest_id, action.request_id); });
    return action;
  }
  registrationGuest(): GuestRow | null {
    return (this.db.prepare(`SELECT * FROM guests g WHERE status='active' AND registration_seen=0
      AND NOT EXISTS (SELECT 1 FROM guest_actions a WHERE a.guest_id=g.id AND a.status IN ('queued','signed','unknown'))
      AND NOT EXISTS (SELECT 1 FROM guest_actions a WHERE a.guest_id=g.id
        AND json_extract(a.request_json,'$.action')='register_player'
        AND (a.status!='failed' OR COALESCE(a.error_code,'') NOT IN ('guest_review_expired','guest_registration_expired')))
      ORDER BY created LIMIT 1`).get() as unknown as GuestRow | undefined) ?? null;
  }
  registrationObserved(id: string): void { this.write(() => { this.db.prepare("UPDATE guests SET registration_seen=1 WHERE id=?").run(id); }); }
  signAction(guestId: string, id: string, proof: unknown, signed: string, hash: string): void {
    this.write(() => {
      guestCheck(this.action(guestId, id)?.status === "queued");
      this.db.prepare("UPDATE guest_actions SET proof_json=?,signed_cipher=?,tx_hash=?,status='signed' WHERE guest_id=? AND request_id=?")
        .run(canonicalLivingTownJson(proof), this.vault.seal(signed, `${this.binding}:${guestId}:${id}:action`), hash, guestId, id);
    });
  }
  dispatchAction(guestId: string, id: string): void {
    this.write(() => {
      const result = this.db.prepare("UPDATE guest_actions SET dispatch_started=1,status='unknown' WHERE guest_id=? AND request_id=? AND status='signed' AND dispatch_started=0").run(guestId, id);
      guestCheck(Number(result.changes) === 1);
    });
  }
  finishAction(guestId: string, id: string, status: "confirmed" | "failed", result: unknown, code: string | null): void {
    this.write(() => {
      const body = result === null ? null : canonicalLivingTownJson(result);
      guestCheck(body === null || Buffer.byteLength(body) <= 131072);
      this.db.prepare("UPDATE guest_actions SET status=?,result_json=?,error_code=? WHERE guest_id=? AND request_id=? AND status IN ('queued','signed','unknown')")
        .run(status, body, code, guestId, id);
    });
  }
  unpublishedActions(): GuestActionRow[] {
    return this.db.prepare("SELECT * FROM guest_actions WHERE published=0 AND tx_hash IS NOT NULL AND proof_json IS NOT NULL AND dispatch_started=1 ORDER BY created LIMIT 3").all() as unknown as GuestActionRow[];
  }
  markPublished(guestId: string, id: string): void { this.write(() => { this.db.prepare("UPDATE guest_actions SET published=1 WHERE guest_id=? AND request_id=?").run(guestId, id); }); }
  publicAction(a: GuestActionRow): Record<string, unknown> {
    return { requestId: a.request_id, request: JSON.parse(a.request_json), status: a.status,
      proof: a.proof_json ? JSON.parse(a.proof_json) : null,
      result: a.result_json ? JSON.parse(a.result_json) : null, error: a.error_code,
      transactionHash: a.tx_hash,
      receiptUrl: a.tx_hash ? new URL(`/txns/${a.tx_hash}`, this.config.profile.public.explorerUrl).href : null };
  }
  activity(guestId: string, before: string | null) {
    const guest = this.guest(guestId);
    if (!guest) throw new GuestError(404, "guest_account_required");
    const rows = this.db.prepare("SELECT rowid AS cursor,* FROM guest_actions WHERE guest_id=? ORDER BY rowid DESC LIMIT 100").all(guestId) as unknown as (GuestActionRow & { cursor: number; created: number })[];
    const summaries = rows.map(row => guestActivity(row, guest, this.config));
    const eligible = before === null ? summaries : summaries.filter(row => BigInt(row.cursor) < BigInt(before));
    const items = eligible.slice(0, 10);
    return guestActivityPage({ accountId: guest.account_id, items,
      nextBefore: eligible.length > 10 ? items.at(-1)!.cursor : null,
      progress: guestProgress(summaries), provisioningTransactionHash: guest.tx_hash,
      observedAtMs: String(Date.now()) });
  }
  close(): void { this.db.close(); }
}
