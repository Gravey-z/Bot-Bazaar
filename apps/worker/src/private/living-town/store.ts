import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  openSync,
  existsSync,
  lstatSync,
  realpathSync,
  chmodSync,
  statfsSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalLivingTownJson,
  parseLivingTownJson,
  parseLivingTownIdentity,
  livingTownSnapshot,
  livingTownTown,
  livingTownShop,
  livingTownLedger,
  livingTownCheckpoint,
  livingTownReadEnvelope,
  parseU64,
  decodeLivingTownSnapshot,
  livingTownProductionJob,
  livingTownProductionPage,
  livingTownProductionRead,
} from "@bot-bazaar/chain";
import type {
  FinalizedBlock,
  LivingTownIdentity,
  LivingTownIndexedReceipt,
  LivingTownIndexedCompletion,
  LivingTownCheckpoint,
} from "@bot-bazaar/chain";
import { ReadApiError } from "../activity/repository.js";
import { projectionSchema } from "./schema.js";
type Town = ReturnType<typeof livingTownTown>;
type Shop = ReturnType<typeof livingTownShop>;
type Ledger = ReturnType<typeof livingTownLedger>;
type Job = ReturnType<typeof livingTownProductionJob>;
type Indexed = LivingTownIndexedReceipt | LivingTownIndexedCompletion;
type Effect = Extract<Indexed["status"], { kind: "succeeded" }>["result"];
type Snapshot<T> = ReturnType<ReturnType<typeof livingTownSnapshot<T>>>;
export interface ProjectionBaseline {
  block: FinalizedBlock;
  town: Snapshot<Town>;
  shops: { shop: Snapshot<Shop>; ledger: Snapshot<Ledger> }[];
  production: {
    shopId: string;
    pages: Snapshot<ReturnType<typeof livingTownProductionPage>>[];
  }[];
}
interface State {
  town: Snapshot<Town>;
  checkpoint: LivingTownCheckpoint;
  observedAt: string;
  latestSeen: string;
}
const json = canonicalLivingTownJson;
function requireValue(
  v: unknown,
  message = "invalid V2 projection",
): asserts v {
  if (!v) throw new Error(message);
}
function stamp(v: number): number {
  requireValue(Number.isSafeInteger(v) && v >= 0, "invalid observation time");
  return v;
}
const actor = (ledger: Ledger): string =>
  ledger.actor.kind === "player"
    ? `account:${ledger.actor.account_id}`
    : `merchant:${ledger.actor.merchant_id}`;
const owner = (shop: Shop): string =>
  shop.owner.kind === "player"
    ? `account:${shop.owner.account_id}`
    : `merchant:${shop.owner.merchant_id}`;
type Mutable<T> = T extends string | number | boolean | null
  ? T
  : { -readonly [K in keyof T]: Mutable<T[K]> };
const copy = <T>(v: T): Mutable<T> =>
  JSON.parse(JSON.stringify(v)) as Mutable<T>;

// Dedicated V2 projection file. It never opens/migrates the V1 signer database.
export class LivingTownProjectionStore {
  private readonly db: DatabaseSync;
  readonly identity: LivingTownIdentity;
  private synchronized = false;
  private closed = false;
  readonly path: string;
  constructor(dataDir: string, identity: unknown, create = false) {
    this.identity = parseLivingTownIdentity(identity);
    requireValue(
      isAbsolute(dataDir) &&
        lstatSync(dataDir).isDirectory() &&
        !lstatSync(dataDir).isSymbolicLink(),
      "existing absolute projection directory required",
    );
    this.path = join(realpathSync(dataDir), "living-town.sqlite");
    const fresh = !existsSync(this.path);
    requireValue(
      !fresh || create,
      "explicit projection initialization required",
    );
    if (fresh) closeSync(openSync(this.path, "wx", 0o600));
    requireValue(
      lstatSync(this.path).isFile() && !lstatSync(this.path).isSymbolicLink(),
      "regular projection database required",
    );
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path, {
      timeout: 1000,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    try {
      this.db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
      );
      const version = Number(
        this.db.prepare("PRAGMA user_version").get()!["user_version"],
      );
      if (version === 0) {
        requireValue(
          create &&
            this.db
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all().length === 0,
          "unknown projection migration source",
        );
        this.transaction(() => {
          this.db.exec(projectionSchema);
          this.db
            .prepare("INSERT INTO projection_identity VALUES(1,?)")
            .run(json(this.identity));
        });
      } else
        requireValue(
          version === 2,
          "unsupported projection schema; initialize a fresh disposable read projection",
        );
      requireValue(
        this.db.prepare("PRAGMA integrity_check").get()!["integrity_check"] ===
          "ok" &&
          this.db.prepare("PRAGMA foreign_key_check").all().length === 0,
        "projection integrity failed",
      );
      requireValue(
        this.db
          .prepare("SELECT identity FROM projection_identity WHERE singleton=1")
          .get()?.["identity"] === json(this.identity),
        "projection deployment/code/config mismatch",
      );
      this.state();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private capacity(): void {
    const disk = statfsSync(this.path);
    requireValue(
      disk.bavail * disk.bsize > 16 * 1024 * 1024,
      "projection disk headroom exhausted",
    );
    requireValue(
      Number(this.db.prepare("PRAGMA page_count").get()!["page_count"]) *
        Number(this.db.prepare("PRAGMA page_size").get()!["page_size"]) <
        1024 ** 3,
      "projection database capacity reached",
    );
  }
  private state(): State | null {
    const raw = this.db
      .prepare("SELECT body FROM projection_state WHERE singleton=1")
      .get()?.["body"];
    if (raw === undefined) return null;
    const s = parseLivingTownJson(String(raw)) as State;
    requireValue(
      Object.keys(s).sort().join() === "checkpoint,latestSeen,observedAt,town",
      "invalid persisted projection state",
    );
    this.validate(s);
    livingTownCheckpoint(s.checkpoint);
    parseU64(s.observedAt);
    stamp(Number(s.observedAt));
    parseU64(s.latestSeen);
    return s;
  }
  private validate(s: State): void {
    requireValue(
      s.checkpoint.verified_code_hash === this.identity.codeHash,
      "projection code identity mismatch",
    );
    livingTownReadEnvelope(livingTownTown)({
      schema: "living-town-read-v1",
      deployment: this.identity.deployment,
      source: "confirmed_projection",
      snapshot: s.town,
      checkpoint: s.checkpoint,
      observed_at_ms: s.observedAt,
      stale: true,
      history_complete: s.checkpoint.history_complete,
    });
  }
  private save(s: State): void {
    this.validate(s);
    requireValue(
      Buffer.byteLength(json(s)) <= 32768,
      "projection state too large",
    );
    this.db
      .prepare(
        "INSERT INTO projection_state VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET body=excluded.body",
      )
      .run(json(s));
  }
  private ledger(value: Ledger): void {
    const l = livingTownLedger(value);
    this.db
      .prepare(
        "INSERT INTO projection_ledgers VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET body=excluded.body",
      )
      .run(actor(l), json(l));
  }
  private shop(value: Shop): void {
    const s = livingTownShop(value);
    this.db
      .prepare(
        "INSERT INTO projection_shops VALUES(?,?,?) ON CONFLICT(shop_id) DO UPDATE SET body=excluded.body",
      )
      .run(s.shop_id, owner(s), json(s));
  }
  baseline(
    input: ProjectionBaseline,
    now = Date.now(),
    preserveGeneration = false,
  ): void {
    const t = decodeLivingTownSnapshot(
        input.town,
        this.identity.deployment,
        livingTownTown,
      ),
      b = input.block;
    requireValue(
      t.block_height === b.height && t.block_timestamp_ns === b.timestampNs,
      "baseline block mismatch",
    );
    requireValue(
      input.shops.length === Number(BigInt(t.data.next_shop_id) - 4n) &&
        input.shops.length <= 1000,
      "incomplete shop baseline",
    );
    const prior = this.state();
    requireValue(
      !prior ||
        (BigInt(t.event_sequence) >=
          BigInt(prior.checkpoint.through_event_sequence) &&
          BigInt(t.event_sequence) >= BigInt(prior.latestSeen)),
      "projection cannot rewind",
    );
    requireValue(
      !prior ||
        BigInt(b.height) >= BigInt(prior.checkpoint.finalized_block_height),
      "projection block cannot rewind",
    );
    const entries = input.shops.map((row, i) => {
      const shop = decodeLivingTownSnapshot(
          row.shop,
          this.identity.deployment,
          livingTownShop,
        ),
        ledger = decodeLivingTownSnapshot(
          row.ledger,
          this.identity.deployment,
          livingTownLedger,
        );
      requireValue(
        shop.data.shop_id === String(i + 4) &&
          shop.data.owner.kind === "player" &&
          shop.market_revision === t.market_revision &&
          ledger.market_revision === t.market_revision &&
          shop.block_height === b.height &&
          ledger.block_height === b.height &&
          shop.block_timestamp_ns === b.timestampNs &&
          ledger.block_timestamp_ns === b.timestampNs &&
          owner(shop.data) === actor(ledger.data),
        "baseline owner/revision mismatch",
      );
      return { shop: shop.data, ledger: ledger.data };
    });
    const all = [
      ...t.data.npc_shops.map((shop, i) => ({
        shop,
        ledger: t.data.npc_ledgers[i]!,
      })),
      ...entries,
    ];
    const jobs: Job[] = [];
    let pruned: string | undefined;
    requireValue(
      input.production.length === all.length,
      "incomplete production baseline",
    );
    input.production.forEach((group, i) => {
      const entry = all[i]!;
      requireValue(
        group.shopId === entry.shop.shop_id &&
          group.pages.length >= 1 &&
          group.pages.length <= 6,
        "production shop/page mismatch",
      );
      let after = 0n;
      const current: Job[] = [];
      group.pages.forEach((raw, n) => {
        const p = decodeLivingTownSnapshot(
          raw,
          this.identity.deployment,
          livingTownProductionPage,
        );
        requireValue(
          p.market_revision === t.market_revision &&
            p.event_sequence === t.event_sequence &&
            p.block_height === b.height &&
            p.block_timestamp_ns === b.timestampNs,
          "production baseline block/revision mismatch",
        );
        requireValue(
          p.data.has_more === n < group.pages.length - 1 &&
            p.data.history_gap === BigInt(p.data.pruned_through) > 0n,
          "incomplete production pagination",
        );
        pruned ??= p.data.pruned_through;
        requireValue(
          pruned === p.data.pruned_through,
          "production history mismatch",
        );
        for (const job of p.data.items) {
          requireValue(
            BigInt(job.job_id) > after &&
              job.shop_id === group.shopId &&
              json(job.owner) === json(entry.shop.owner) &&
              BigInt(job.start_at_ns) <= BigInt(b.timestampNs) &&
              (job.completed_at_ns === null ||
                BigInt(job.completed_at_ns) <= BigInt(b.timestampNs)),
            "production job identity/order/time mismatch",
          );
          after = BigInt(job.job_id);
          current.push(job);
        }
        if (p.data.has_more)
          requireValue(
            p.data.next_after_id !== null &&
              BigInt(p.data.next_after_id) >= after &&
              BigInt(p.data.next_after_id) > 0n,
            "production cursor mismatch",
          );
      });
      const running = current.filter((j) => j.status === "running");
      requireValue(
        running.length <= Number(entry.shop.production_slots),
        "production active slot mismatch",
      );
      for (const item of Object.keys(
        entry.ledger.inventory.production_output_reserved,
      ) as (keyof Ledger["inventory"]["production_output_reserved"])[]) {
        const reserved = running
          .filter((j) => j.output_item === item)
          .reduce((sum, j) => sum + BigInt(j.output_quantity), 0n);
        requireValue(
          reserved ===
            BigInt(entry.ledger.inventory.production_output_reserved[item]),
          "production promise mismatch",
        );
      }
      jobs.push(...current);
    });
    requireValue(
      new Set(jobs.map((j) => j.job_id)).size === jobs.length &&
        jobs.filter((j) => j.status === "running").length <= 1003 &&
        jobs.filter((j) => j.status === "completed").length <= 256,
      "production global bound/identity mismatch",
    );
    this.capacity();
    this.transaction(() => {
      this.db.exec(
        "DELETE FROM production_jobs; DELETE FROM production_history; DELETE FROM projection_shops; DELETE FROM projection_ledgers;",
      );
      t.data.npc_ledgers.forEach((l) => this.ledger(l));
      t.data.npc_shops.forEach((s) => this.shop(s));
      for (const row of entries) {
        this.ledger(row.ledger);
        this.shop(row.shop);
      }
      for (const job of jobs) this.job(job);
      this.db
        .prepare("INSERT INTO production_history VALUES(1,?)")
        .run(pruned ?? "0");
      const d = this.identity.deployment;
      const checkpoint: LivingTownCheckpoint = {
        network_id: d.network_id,
        genesis_hash: d.genesis_hash,
        contract_id: d.contract_id,
        projection_schema_version: "1",
        verified_code_hash: this.identity.codeHash,
        config_sha256: d.config_sha256,
        baseline_event_sequence: parseU64(t.event_sequence),
        through_event_sequence: parseU64(t.event_sequence),
        through_market_revision: parseU64(t.market_revision),
        finalized_block_hash: b.hash,
        finalized_block_height: b.height,
        last_receipt_id: null,
        last_log_index: null,
        history_complete: false,
        gap_from_sequence: prior?.checkpoint.gap_from_sequence ?? parseU64("1"),
        feed_generation:
          preserveGeneration &&
          prior?.checkpoint.baseline_event_sequence === t.event_sequence
            ? prior.checkpoint.feed_generation
            : randomUUID(),
      };
      this.save({
        town: t,
        checkpoint,
        observedAt: String(stamp(now)),
        latestSeen: t.event_sequence,
      });
    });
    this.synchronized = true;
  }
  hasReceipt(hash: string, request: string): boolean {
    const r = this.db
      .prepare("SELECT request FROM projection_receipts WHERE tx_hash=?")
      .get(hash);
    if (!r) return false;
    requireValue(
      r["request"] === request,
      "conflicting receipt request identity",
    );
    return true;
  }
  commit(receipt: Indexed, now = Date.now()): "duplicate" | "indexed" {
    const s = this.state();
    requireValue(s, "projection baseline required");
    const { status, proof } = receipt;
    requireValue(
      json(proof.deployment) === json(this.identity.deployment),
      "receipt deployment mismatch",
    );
    const request = json(proof);
    if (this.hasReceipt(proof.transactionHash, request)) return "duplicate";
    this.capacity();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO projection_receipts VALUES(?,?,?,?,?,?,?)")
        .run(
          proof.transactionHash,
          request,
          status.executionReceiptId,
          status.block.hash,
          status.block.height,
          status.kind,
          stamp(now),
        );
      if (receipt.event !== null) {
        requireValue(
          status.kind === "succeeded" &&
            !status.result.data.replayed &&
            receipt.logIndex !== null,
          "invalid economic event",
        );
        const seq = status.result.event_sequence;
        const existing = this.db
          .prepare(
            "SELECT payload,receipt_id,log_index FROM projection_events WHERE event_sequence=?",
          )
          .get(seq);
        const payload = json({
          result: status.result,
          event: receipt.event,
          block: status.block,
          receiptId: status.executionReceiptId,
          logIndex: receipt.logIndex,
        });
        if (existing)
          requireValue(
            existing["payload"] === payload &&
              existing["receipt_id"] === status.executionReceiptId &&
              existing["log_index"] === receipt.logIndex,
            "conflicting event sequence",
          );
        else
          this.db
            .prepare("INSERT INTO projection_events VALUES(?,?,?,?)")
            .run(seq, status.executionReceiptId, receipt.logIndex, payload);
        if (BigInt(seq) > BigInt(s.latestSeen)) s.latestSeen = seq;
      }
      while (true) {
        const next = (
          BigInt(s.checkpoint.through_event_sequence) + 1n
        ).toString();
        const row = this.db
          .prepare(
            "SELECT payload FROM projection_events WHERE event_sequence=?",
          )
          .get(next);
        if (!row) break;
        const p = JSON.parse(String(row["payload"])) as {
          result: Effect;
          block: FinalizedBlock;
          receiptId: string;
          logIndex: string;
        };
        if (!this.apply(s, p.result)) break;
        requireValue(
          BigInt(p.block.height) >= BigInt(s.checkpoint.finalized_block_height),
          "event block moved backwards",
        );
        s.town = {
          ...s.town,
          market_revision: p.result.market_revision,
          event_sequence: p.result.event_sequence,
          block_height: p.block.height,
          block_timestamp_ns: p.block.timestampNs,
        };
        s.checkpoint = {
          ...s.checkpoint,
          through_event_sequence: parseU64(p.result.event_sequence),
          through_market_revision: parseU64(p.result.market_revision),
          finalized_block_hash: p.block.hash,
          finalized_block_height: p.block.height,
          last_receipt_id: p.receiptId,
          last_log_index: parseU64(p.logIndex),
        };
      }
      if (
        s.checkpoint.through_event_sequence !==
        this.state()!.checkpoint.through_event_sequence
      )
        s.observedAt = String(stamp(now));
      this.save(s);
    });
    return "indexed";
  }
  private readLedger(key: string): Ledger | null {
    const r = this.db
      .prepare("SELECT body FROM projection_ledgers WHERE actor=?")
      .get(key);
    return r ? livingTownLedger(parseLivingTownJson(String(r["body"]))) : null;
  }
  private job(value: Job): void {
    const j = livingTownProductionJob(value);
    this.db
      .prepare("INSERT INTO production_jobs VALUES(?,?,?,?)")
      .run(j.job_id, j.shop_id, j.status, json(j));
  }
  private apply(s: State, result: Effect): boolean {
    const o = result.data.outcome,
      t = s.town.data;
    // Settlement/retention reads are rebuilt at one finalized block. Preserve a
    // visible gap until jobs, shop revisions and ledgers can advance together.
    if (o.kind === "production_started" || o.kind === "production_completed")
      return false;
    if (o.kind === "player_registered") {
      requireValue(
        !this.readLedger(`account:${o.player.account_id}`),
        "duplicate player grant event",
      );
      this.ledger(o.player.ledger);
      t.registered_player_count = parseU64(
        (BigInt(t.registered_player_count) + 1n).toString(),
      );
      t.totals.player_grants = (
        BigInt(t.totals.player_grants) + 100n
      ).toString();
    }
    if (o.kind === "shop_created") {
      if (!this.readLedger(owner(o.shop))) return false;
      requireValue(
        o.shop.shop_id === t.next_shop_id,
        "non-monotonic shop identity",
      );
      this.shop(o.shop);
      t.next_shop_id = parseU64((BigInt(t.next_shop_id) + 1n).toString());
    }
    if (o.kind === "shop_renamed") {
      const r = this.db
        .prepare("SELECT body FROM projection_shops WHERE shop_id=?")
        .get(o.shop.shop_id);
      requireValue(r, "rename missing shop");
      const old = livingTownShop(JSON.parse(String(r["body"])));
      requireValue(
        owner(old) === owner(o.shop) &&
          BigInt(o.shop.revision) === BigInt(old.revision) + 1n,
        "rename projection mismatch",
      );
      this.shop(o.shop);
    }
    if (o.kind === "raw_purchased") {
      const buyer = this.readLedger(actor(o.buyer)),
        seller = this.readLedger(actor(o.seller));
      if (!buyer || !seller) return false;
      const b = copy(buyer),
        v = copy(seller),
        q = BigInt(o.trade.quantity),
        cost = BigInt(o.trade.total_price),
        item = o.trade.item_id;
      b.revision = parseU64((BigInt(b.revision) + 1n).toString());
      v.revision = parseU64((BigInt(v.revision) + 1n).toString());
      b.gold.held = parseU64((BigInt(b.gold.held) - cost).toString());
      b.gold.available = parseU64((BigInt(b.gold.available) - cost).toString());
      v.gold.held = parseU64((BigInt(v.gold.held) + cost).toString());
      v.gold.available = parseU64((BigInt(v.gold.available) + cost).toString());
      b.inventory.held[item] = parseU64(
        (BigInt(b.inventory.held[item]) + q).toString(),
      );
      b.inventory.available[item] = parseU64(
        (BigInt(b.inventory.available[item]) + q).toString(),
      );
      v.inventory.held[item] = parseU64(
        (BigInt(v.inventory.held[item]) - q).toString(),
      );
      v.inventory.listing_reserved[item] = parseU64(
        (BigInt(v.inventory.listing_reserved[item]) - q).toString(),
      );
      requireValue(
        json(b) === json(o.buyer) &&
          json(v) === json(o.seller) &&
          o.trade.trade_id === t.next_trade_id,
        "purchase ledger projection mismatch",
      );
      this.ledger(o.buyer);
      this.ledger(o.seller);
      const index = ["rex", "luna", "bolt"].indexOf(o.trade.seller.merchant_id);
      t.npc_ledgers[index] = o.seller;
      t.next_trade_id = parseU64((BigInt(t.next_trade_id) + 1n).toString());
    }
    const epoch = (
      (BigInt(result.block_timestamp_ns) - BigInt(t.genesis_time_ns)) /
      60_000_000_000n
    ).toString();
    t.epoch = parseU64(epoch);
    t.customer_pool.epoch = parseU64(epoch);
    livingTownTown(t);
    return true;
  }
  observe(
    town: Snapshot<Town>,
    block: FinalizedBlock,
    now = Date.now(),
  ): boolean {
    const s = this.state();
    if (!s) return false;
    const t = decodeLivingTownSnapshot(
      town,
      this.identity.deployment,
      livingTownTown,
    );
    if (t.market_revision !== s.town.market_revision) return false;
    const expected = copy(s.town.data);
    expected.epoch = t.data.epoch;
    expected.customer_pool.epoch = t.data.customer_pool.epoch;
    requireValue(
      json(expected) === json(t.data) &&
        t.block_height === block.height &&
        t.block_timestamp_ns === block.timestampNs &&
        BigInt(block.height) >= BigInt(s.checkpoint.finalized_block_height),
      "inconsistent finalized projection observation",
    );
    this.transaction(() => {
      s.town = t;
      s.checkpoint.finalized_block_hash = block.hash;
      s.checkpoint.finalized_block_height = block.height;
      s.observedAt = String(stamp(now));
      this.save(s);
    });
    this.synchronized = true;
    return true;
  }
  private envelope<T>(data: T, decode: (v: unknown) => T, now: number) {
    const s = this.state();
    if (!s) throw new ReadApiError(503, "read_unavailable");
    return livingTownReadEnvelope(decode)({
      schema: "living-town-read-v1",
      deployment: this.identity.deployment,
      source: "confirmed_projection",
      snapshot: { ...s.town, data },
      checkpoint: s.checkpoint,
      observed_at_ms: String(s.observedAt),
      stale:
        !this.synchronized ||
        stamp(now) < Number(s.observedAt) ||
        now - Number(s.observedAt) > 30000 ||
        BigInt(s.latestSeen) > BigInt(s.checkpoint.through_event_sequence),
      history_complete: s.checkpoint.history_complete,
    });
  }
  town(
    now = Date.now(),
  ): ReturnType<ReturnType<typeof livingTownReadEnvelope<Town>>> {
    const s = this.state();
    if (!s) throw new ReadApiError(503, "read_unavailable");
    return this.envelope(s.town.data, livingTownTown, now);
  }
  shopView(
    id: string,
    now = Date.now(),
  ): ReturnType<ReturnType<typeof livingTownReadEnvelope<Shop>>> {
    const current = this.town(now);
    requireValue(parseU64(id) !== "0", "invalid shop ID");
    const r = this.db
      .prepare("SELECT body FROM projection_shops WHERE shop_id=?")
      .get(id);
    if (!r)
      throw new ReadApiError(
        current.stale ? 503 : 404,
        current.stale ? "read_unavailable" : "shop_not_found",
      );
    return this.envelope(
      livingTownShop(parseLivingTownJson(String(r["body"]))),
      livingTownShop,
      now,
    );
  }
  inventory(
    id: string,
    now = Date.now(),
  ): ReturnType<ReturnType<typeof livingTownReadEnvelope<Ledger>>> {
    const shop = this.shopView(id, now);
    const l = this.readLedger(owner(shop.snapshot.data));
    requireValue(l, "missing referenced shop ledger");
    return this.envelope(l, livingTownLedger, now);
  }
  production(
    id: string,
    after: string | null = null,
    limit = 20,
    now = Date.now(),
  ): ReturnType<
    ReturnType<
      typeof livingTownReadEnvelope<ReturnType<typeof livingTownProductionRead>>
    >
  > {
    this.shopView(id, now);
    const s = this.state()!;
    let afterId = "0";
    if (after !== null) {
      try {
        requireValue(/^[A-Za-z0-9_-]{1,1024}$/.test(after));
        const c = parseLivingTownJson(
          Buffer.from(after, "base64url").toString("utf8"),
        ) as {
          generation: string;
          blockHash: string;
          shopId: string;
          afterId: string;
        };
        requireValue(
          Object.keys(c).sort().join() ===
            "afterId,blockHash,generation,shopId" &&
            c.shopId === id &&
            parseU64(c.afterId) === c.afterId &&
            Buffer.from(json(c)).toString("base64url") === after,
        );
        if (
          c.generation !== s.checkpoint.feed_generation ||
          c.blockHash !== s.checkpoint.finalized_block_hash
        )
          throw new ReadApiError(409, "feed_generation_mismatch");
        afterId = c.afterId;
      } catch (error) {
        if (error instanceof ReadApiError) throw error;
        throw new ReadApiError(400, "invalid_query");
      }
    }
    requireValue(
      Number.isInteger(limit) && limit >= 1 && limit <= 50,
      "invalid production limit",
    );
    const rows = this.db
      .prepare(
        "SELECT body FROM production_jobs WHERE shop_id=? ORDER BY length(job_id),job_id",
      )
      .all(id);
    const remaining = rows
      .map((r) =>
        livingTownProductionJob(parseLivingTownJson(String(r["body"]))),
      )
      .filter((j) => BigInt(j.job_id) > BigInt(afterId));
    const items = remaining.slice(0, limit);
    const pruned = String(
      this.db
        .prepare(
          "SELECT pruned_through FROM production_history WHERE singleton=1",
        )
        .get()!["pruned_through"],
    );
    return this.envelope(
      {
        page: {
          items,
          next_after_id:
            items.at(-1)?.job_id ??
            (afterId === "0" ? null : parseU64(afterId)),
          has_more: remaining.length > items.length,
          history_gap: BigInt(pruned) > 0n,
          pruned_through: parseU64(pruned),
        },
        next_cursor:
          remaining.length > items.length
            ? Buffer.from(
                json({
                  generation: s.checkpoint.feed_generation,
                  blockHash: s.checkpoint.finalized_block_hash,
                  shopId: id,
                  afterId: items.at(-1)!.job_id,
                }),
              ).toString("base64url")
            : null,
        ready_job_ids: items
          .filter(
            (j) =>
              j.status === "running" &&
              BigInt(j.ready_at_ns) <= BigInt(s.town.block_timestamp_ns),
          )
          .map((j) => j.job_id),
        settlement: "wallet_claim" as const,
      },
      livingTownProductionRead,
      now,
    );
  }
  cursor(): LivingTownCheckpoint | null {
    return this.state()?.checkpoint ?? null;
  }
  counts(): {
    shops: number;
    ledgers: number;
    receipts: number;
    events: number;
  } {
    const count = (table: string): number =>
      Number(this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!["n"]);
    return {
      shops: count("projection_shops"),
      ledgers: count("projection_ledgers"),
      receipts: count("projection_receipts"),
      events: count("projection_events"),
    };
  }
  invalidate(): void {
    this.synchronized = false;
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
