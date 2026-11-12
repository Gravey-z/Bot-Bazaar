import { TownActivityFeed } from "./feed.js";
import {
  ChainValidationError,
  livingTownOffer,
  livingTownOfferEffect,
  livingTownOfferPage,
  checkPendingOfferReservations,
} from "@bot-bazaar/chain";
import { sameOfferTerms } from "./offer-store.js";
import { gzipSync } from "node:zlib";
import { DatabaseSync, backup } from "node:sqlite";
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
  livingTownMarketEventHistory,
  livingTownShop,
  livingTownPlayer,
  livingTownLedger,
  livingTownCheckpoint,
  livingTownReadEnvelope,
  parseU64,
  decodeLivingTownSnapshot,
  livingTownProductionJob,
  livingTownProductionPage,
  livingTownProductionRead,
  livingTownListing,
  livingTownSalesHistoryRead,
  livingTownMarketListingsRead,
  livingTownShopDirectory,
  livingTownMerchantContext,
} from "@bot-bazaar/chain";
import type {
  FinalizedBlock,
  LivingTownIdentity,
  LivingTownIndexedReceipt,
  LivingTownIndexedCompletion,
  LivingTownCheckpoint,
} from "@bot-bazaar/chain";
import { ReadApiError } from "../activity/repository.js";
import { LivingTownAccounting } from "./accounting.js";
import { sha256 } from "../storage/validation.js";
import { projectionSchema } from "./schema.js";
type Town = ReturnType<typeof livingTownTown>;
type Shop = ReturnType<typeof livingTownShop>;
type Ledger = ReturnType<typeof livingTownLedger>;
type Job = ReturnType<typeof livingTownProductionJob>;
type Indexed = LivingTownIndexedReceipt | LivingTownIndexedCompletion;
type Effect = Extract<Indexed["status"], { kind: "succeeded" }>["result"];
type Snapshot<T> = ReturnType<ReturnType<typeof livingTownSnapshot<T>>>;
export interface ProjectionBaseline {
  offers?: Snapshot<ReturnType<typeof livingTownOfferPage>>[];
  block: FinalizedBlock;
  town: Snapshot<Town>;
  shops: { shop: Snapshot<Shop>; ledger: Snapshot<Ledger> }[];
  marketEvents?: Snapshot<ReturnType<typeof livingTownMarketEventHistory>>;
  listings?: Snapshot<{
    items: ReturnType<typeof livingTownListing>[];
    next_after_id: string | null;
    has_more: boolean;
    history_gap: boolean;
    pruned_through: string;
  }>[];
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
  private readonly accounting: LivingTownAccounting;
  private readonly feed: TownActivityFeed;
  readonly identity: LivingTownIdentity;
  private synchronized = false;
  private closed = false;
  private snapshotting = false;
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
          if (this.identity.deployment.state_schema === "2")
            this.db.exec(
              "CREATE TABLE projection_offers(offer_id TEXT PRIMARY KEY,status TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096)) STRICT; PRAGMA user_version=6;",
            );
          this.db
            .prepare("INSERT INTO projection_identity VALUES(1,?)")
            .run(json(this.identity));
        });
      } else
        requireValue(
          version === (this.identity.deployment.state_schema === "2" ? 6 : 5),
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
      this.accounting = new LivingTownAccounting(this.db);
      this.feed = new TownActivityFeed(this.db, this.identity, version === 0);
      const checkpoint = this.state()?.checkpoint;
      if (checkpoint) this.transaction(() => this.feed.seedRecentReceipts(checkpoint));
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
  private listing(value: ReturnType<typeof livingTownListing>): void {
    const listing = livingTownListing(value);
    this.db.prepare("INSERT INTO market_listings VALUES(?,?,?) ON CONFLICT(listing_id) DO UPDATE SET shop_id=excluded.shop_id,body=excluded.body")
      .run(listing.listing_id, listing.shop_id, json(listing));
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
    const marketEvents = input.marketEvents
      ? decodeLivingTownSnapshot(
          input.marketEvents,
          this.identity.deployment,
          livingTownMarketEventHistory,
        )
      : null;
    requireValue(
      !marketEvents ||
        (marketEvents.block_height === t.block_height &&
          marketEvents.block_timestamp_ns === t.block_timestamp_ns &&
          marketEvents.market_revision === t.market_revision &&
          json(marketEvents.data.items.at(-1) ?? null) ===
            json(t.data.market_event)),
      "market activity checkpoint mismatch",
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
    const market: ReturnType<typeof livingTownListing>[] = [];
    if (input.listings) {
      requireValue(
        input.listings.length > 0 && input.listings.length <= 41,
        "market page bound exceeded",
      );
      input.listings.forEach((raw, i) => {
        requireValue(
          json(raw.deployment) === json(this.identity.deployment) &&
            raw.block_height === b.height &&
            raw.block_timestamp_ns === b.timestampNs &&
            raw.market_revision === t.market_revision &&
            raw.event_sequence === t.event_sequence,
          "market checkpoint mismatch",
        );
        const page = raw.data;
        requireValue(
          page.items.length <= 50 &&
            page.has_more === i < input.listings!.length - 1 &&
            !page.history_gap &&
            page.pruned_through === "0",
          "incomplete market pages",
        );
        for (const value of page.items) {
          const listing = livingTownListing(value),
            entry = all.find((row) => row.shop.shop_id === listing.shop_id);
          requireValue(
            listing.listing_id === String(market.length + 1) &&
              entry &&
              json(entry.shop.owner) === json(listing.owner) &&
              entry.ledger.inventory.listing_reserved[listing.item_id] ===
                listing.remaining_quantity,
            "market identity/stock mismatch",
          );
          requireValue(
            !market.some(
              (l) =>
                l.shop_id === listing.shop_id && l.item_id === listing.item_id,
            ),
            "duplicate market slot",
          );
          market.push(listing);
        }
        requireValue(
          page.next_after_id === (market.at(-1)?.listing_id ?? null),
          "market cursor mismatch",
        );
      });
      requireValue(
        market.length === Number(BigInt(t.data.next_listing_id) - 1n) &&
          market.length <= 2018,
        "incomplete market baseline",
      );
    }
    this.capacity();
    const offers: ReturnType<typeof livingTownOffer>[] = [];
    if (this.identity.deployment.state_schema === "2") {
      requireValue(
        input.offers && input.offers.length >= 1 && input.offers.length <= 3,
        "complete offer baseline required",
      );
      let last = 0n;
      input.offers.forEach((raw, i) => {
        const p = decodeLivingTownSnapshot(
          raw,
          this.identity.deployment,
          livingTownOfferPage,
        );
        requireValue(
          p.block_height === b.height &&
            p.block_timestamp_ns === b.timestampNs &&
            p.market_revision === t.market_revision &&
            p.data.has_more === i < input.offers!.length - 1,
          "mixed/incomplete offer baseline",
        );
        for (const o of p.data.items) {
          requireValue(
            BigInt(o.created_at_ns) <= BigInt(b.timestampNs) &&
              (o.closed_at_ns === null ||
                BigInt(o.closed_at_ns) <= BigInt(b.timestampNs)) &&
              o.expired ===
                (o.status === "expired" ||
                  (o.status === "pending" &&
                    BigInt(b.timestampNs) >= BigInt(o.expires_at_ns))),
            "offer baseline time mismatch",
          );
          requireValue(BigInt(o.offer_id) > last, "unordered offer baseline");
          last = BigInt(o.offer_id);
          offers.push(o);
        }
        requireValue(
          p.data.next_after_id === (p.data.items.at(-1)?.offer_id ?? null),
          "offer baseline cursor mismatch",
        );
      });
      requireValue(offers.length <= 140, "offer baseline capacity");
      checkPendingOfferReservations(
        t.data.npc_ledgers,
        offers.filter((o) => o.status === "pending"),
      );
    }
    this.transaction(() => {
      this.db.exec(
        "DELETE FROM market_listings; DELETE FROM market_snapshot; DELETE FROM production_jobs; DELETE FROM production_history; DELETE FROM projection_shops; DELETE FROM projection_ledgers;",
      );
      if (this.identity.deployment.state_schema === "2") {
        this.db.exec("DELETE FROM projection_offers");
        for (const o of offers) this.putOffer(o);
      }
      t.data.npc_ledgers.forEach((l) => this.ledger(l));
      t.data.npc_shops.forEach((s) => this.shop(s));
      for (const row of entries) {
        this.ledger(row.ledger);
        this.shop(row.shop);
      }
      for (const listing of market)
        this.db
          .prepare("INSERT INTO market_listings VALUES(?,?,?)")
          .run(listing.listing_id, listing.shop_id, json(listing));
      if (input.listings)
        this.db
          .prepare("INSERT INTO market_snapshot VALUES(1,?)")
          .run(t.market_revision);
      for (const job of jobs) this.job(job);
      this.db
        .prepare("INSERT INTO production_history VALUES(1,?)")
        .run(pruned ?? "0");
      if (prior && !preserveGeneration) this.feed.reset();
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
      this.feed.observe(
        t.data,
        checkpoint,
        t.block_timestamp_ns,
        jobs,
        marketEvents?.data.items ??
          (t.data.market_event ? [t.data.market_event] : []),
      );
    });
    this.synchronized = true;
  }
  hasReceipt(hash: string, request: string): boolean {
    const r = this.db
      .prepare("SELECT request FROM projection_receipts WHERE tx_hash=?")
      .get(hash);
    if (!r) return false;
    if (r["request"] !== request) {
      throw new ChainValidationError("conflicting receipt request identity");
    }
    return true;
  }
  commit(receipt: Indexed, now = Date.now()): "duplicate" | "indexed" {
    const s = this.state();
    requireValue(s, "projection baseline required");
    const { status, proof } = receipt;
    const previouslyThrough = s.checkpoint.through_event_sequence;
    requireValue(
      json(proof.deployment) === json(this.identity.deployment),
      "receipt deployment mismatch",
    );
    const request = json(proof);
    if (this.hasReceipt(proof.transactionHash, request)) return "duplicate";
    const changedListing = status.kind === "succeeded" && "listing" in status.result.data.outcome
      ? status.result.data.outcome.listing : null;
    const previousRow = changedListing ? this.db.prepare("SELECT body FROM market_listings WHERE listing_id=?")
      .get(changedListing.listing_id) : null;
    const previousListing = previousRow ? livingTownListing(parseLivingTownJson(String(previousRow["body"]))) : undefined;
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
      this.accounting.recordFee(receipt);
      if (receipt.response !== undefined && receipt.response !== null) {
        const raw = Buffer.from(JSON.stringify(receipt.response));
        requireValue(
          raw.length <= 1048576,
          "receipt proof exceeds archive bound",
        );
        const compressed = gzipSync(raw);
        requireValue(
          compressed.length <= 262144,
          "compressed receipt proof exceeds bound",
        );
        this.db
          .prepare("INSERT INTO projection_proofs VALUES(?,?)")
          .run(proof.transactionHash, compressed);
      }
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
        if (!existing) this.accounting.record(status.result);
        this.accounting.advance();
        if (BigInt(seq) > BigInt(s.latestSeen)) s.latestSeen = seq;
      }
      // A cached effect is not a new transfer, but its finalized envelope can
      // prove that other state changes are missing from this projection.
      if (
        status.kind === "succeeded" &&
        BigInt(status.result.event_sequence) > BigInt(s.latestSeen)
      )
        s.latestSeen = status.result.event_sequence;
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
        this.db.prepare("UPDATE market_snapshot SET revision=? WHERE singleton=1").run(p.result.market_revision);
      }
      if (
        s.checkpoint.through_event_sequence !==
        this.state()!.checkpoint.through_event_sequence
      )
        s.observedAt = String(stamp(now));
      this.save(s);
      this.feed.receipt(receipt, previousListing);
      this.feed.flush(s.checkpoint);
    });
    if (BigInt(s.checkpoint.through_event_sequence) > BigInt(previouslyThrough) &&
      BigInt(s.latestSeen) <= BigInt(s.checkpoint.through_event_sequence)) this.synchronized = true;
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
      t = copy(s.town.data);
    if (!["trade_proposed", "trade_accepted", "trade_rejected", "trade_cancelled", "offers_expired",
      "listing_set", "listing_cancelled", "listings_set", "assistant_repriced", "production_started", "production_completed",
      "raw_supplied", "raw_supplies", "treasury_swept", "customer_funded", "customer_sale", "upgrade_purchased",
      "assistant_policy_set", "market_event_scheduled", "player_registered", "shop_created", "shop_renamed",
      "raw_purchased"].includes(o.kind)) return false;
    if (
      [
        "trade_proposed",
        "trade_accepted",
        "trade_rejected",
        "trade_cancelled",
        "offers_expired",
      ].includes(o.kind)
    ) {
      requireValue(
        this.identity.deployment.state_schema === "2",
        "offer projection schema unavailable",
      );
      const v = livingTownOfferEffect(result.data).outcome;
      const changes = new Map<string, Mutable<Ledger>>();
      const get = (m: string) => {
        if (!changes.has(m)) {
          const prior = this.readLedger(`merchant:${m}`);
          requireValue(prior, "missing offer ledger");
          changes.set(m, copy(prior));
        }
        return changes.get(m)!;
      };
      const changedOffers = v.kind === "offers_expired" ? v.offers : [v.offer];
      for (const offer of changedOffers) {
        const row = this.db
          .prepare("SELECT body FROM projection_offers WHERE offer_id=?")
          .get(offer.offer_id);
        if (v.kind !== "trade_proposed" && !row) return false;
        if (row) {
          const old = livingTownOffer(JSON.parse(String(row["body"])));
          requireValue(
            old.status === "pending" && sameOfferTerms(old, offer),
            "offer projection lifecycle/terms mismatch",
          );
        }
        if (v.kind === "trade_proposed")
          requireValue(
            !row && offer.offer_id === t.next_offer_id,
            "offer projection creation mismatch",
          );
        const b = get(offer.buyer),
          c = BigInt(offer.total_price),
          q = BigInt(offer.quantity),
          item = offer.item_id;
        const add = (n: string, d: bigint) =>
          parseU64((BigInt(n) + d).toString());
        if (v.kind === "trade_proposed") {
          b.gold.trade_reserved = add(b.gold.trade_reserved, c);
          b.gold.available = add(b.gold.available, -c);
          b.inventory.trade_inbound_reserved[item] = add(
            b.inventory.trade_inbound_reserved[item],
            q,
          );
          t.next_offer_id = add(t.next_offer_id, 1n);
        } else {
          b.gold.trade_reserved = add(b.gold.trade_reserved, -c);
          b.inventory.trade_inbound_reserved[item] = add(
            b.inventory.trade_inbound_reserved[item],
            -q,
          );
          if (v.kind === "trade_accepted") {
            b.gold.held = add(b.gold.held, -c);
            b.inventory.held[item] = add(b.inventory.held[item], q);
            b.inventory.available[item] = add(b.inventory.available[item], q);
            const seller = get(offer.seller);
            seller.gold.held = add(seller.gold.held, c);
            seller.gold.available = add(seller.gold.available, c);
            seller.inventory.held[item] = add(seller.inventory.held[item], -q);
            seller.inventory.available[item] = add(
              seller.inventory.available[item],
              -q,
            );
            requireValue(
              v.trade.trade_id === t.next_trade_id,
              "offer trade cursor mismatch",
            );
            t.next_trade_id = add(t.next_trade_id, 1n);
          } else b.gold.available = add(b.gold.available, c);
        }
      }
      const expected =
        v.kind === "offers_expired"
          ? v.ledgers
          : v.kind === "trade_accepted"
            ? [v.buyer, v.seller]
            : [v.buyer];
      requireValue(
        expected.length === changes.size,
        "offer changed ledger set mismatch",
      );
      for (const l of expected) {
        requireValue(l.actor.kind === "merchant", "offer ledger actor");
        const c = changes.get(l.actor.merchant_id);
        requireValue(c, "offer ledger missing");
        c.revision = parseU64((BigInt(c.revision) + 1n).toString());
        requireValue(
          json(c) === json(l),
          "offer projected reservation/transfer mismatch",
        );
        this.ledger(l);
        t.npc_ledgers[["rex", "luna", "bolt"].indexOf(l.actor.merchant_id)] = l;
      }
      for (const offer of changedOffers) this.putOffer(offer);
    }
    // Verified outcomes carry the changed rows. Apply them atomically with
    // the event cursor instead of rebuilding every shop after each mutation.
    const setLedger = (ledger: Ledger) => {
      this.ledger(ledger);
      if (ledger.actor.kind === "merchant")
        t.npc_ledgers[["rex", "luna", "bolt"].indexOf(ledger.actor.merchant_id)] = ledger;
    };
    const nextLedger = (ledger: Ledger): boolean => {
      const old = this.readLedger(actor(ledger));
      return !!old && BigInt(ledger.revision) === BigInt(old.revision) + 1n;
    };
    const getShop = (id: string): Shop | null => {
      const row = this.db.prepare("SELECT body FROM projection_shops WHERE shop_id=?").get(id);
      return row ? livingTownShop(JSON.parse(String(row["body"]))) : null;
    };
    const getListing = (id: string) => {
      const row = this.db.prepare("SELECT body FROM market_listings WHERE listing_id=?").get(id);
      return row ? livingTownListing(JSON.parse(String(row["body"]))) : null;
    };
    const setShop = (shop: Shop) => {
      this.shop(shop);
      if (shop.owner.kind === "merchant")
        t.npc_shops[["rex", "luna", "bolt"].indexOf(shop.owner.merchant_id)] = shop;
    };
    if (o.kind === "listings_set") {
      const priorLedger = this.readLedger(actor(o.ledger));
      if (!priorLedger || BigInt(o.ledger.revision) !== BigInt(priorLedger.revision) + BigInt(o.listings.length)) return false;
      let nextId = BigInt(t.next_listing_id);
      const expectedLedger = copy(priorLedger);
      expectedLedger.revision = o.ledger.revision;
      for (const listing of o.listings) {
        const old = getListing(listing.listing_id);
        if (!getShop(listing.shop_id) || (old
          ? old.shop_id !== listing.shop_id || old.item_id !== listing.item_id || BigInt(listing.revision) !== BigInt(old.revision) + 1n
          : BigInt(listing.listing_id) !== nextId || listing.revision !== "1")) return false;
        if (!old) nextId++;
        const item = listing.item_id;
        expectedLedger.inventory.listing_reserved[item] = listing.remaining_quantity;
        expectedLedger.inventory.available[item] = parseU64((BigInt(expectedLedger.inventory.held[item]) -
          BigInt(listing.remaining_quantity) - BigInt(expectedLedger.inventory.trade_reserved[item])).toString());
      }
      if (json(expectedLedger) !== json(o.ledger)) return false;
      setLedger(o.ledger);
      for (const listing of o.listings) this.listing(listing);
      t.next_listing_id = parseU64(nextId.toString());
    }
    if (o.kind === "listing_set" || o.kind === "listing_cancelled") {
      const old = getListing(o.listing.listing_id);
      if (!getShop(o.listing.shop_id) || !nextLedger(o.ledger) ||
        (old ? BigInt(o.listing.revision) !== BigInt(old.revision) + 1n
          : o.listing.listing_id !== t.next_listing_id)) return false;
      setLedger(o.ledger);
      this.listing(o.listing);
      if (!old) t.next_listing_id = parseU64((BigInt(t.next_listing_id) + 1n).toString());
    }
    if (o.kind === "assistant_repriced") {
      const old = getListing(o.listing.listing_id);
      if (!old || BigInt(o.listing.revision) !== BigInt(old.revision) + 1n ||
        old.remaining_quantity !== o.listing.remaining_quantity) return false;
      this.listing(o.listing);
    }
    if (o.kind === "production_started" || o.kind === "production_completed") {
      const shop = getShop(o.job.shop_id);
      const prior = this.db.prepare("SELECT status FROM production_jobs WHERE job_id=?").get(o.job.job_id);
      if (!shop || !nextLedger(o.ledger) || (o.kind === "production_started"
        ? !!prior || o.job.job_id !== t.next_job_id
        : prior?.["status"] !== "running"))
        return false;
      let pruneId: string | null = null;
      if (o.kind === "production_completed") {
        const completed = this.db.prepare("SELECT body FROM production_jobs WHERE status='completed'")
          .all().map(row => livingTownProductionJob(JSON.parse(String(row["body"]))))
          .sort((a, b) => BigInt(a.completed_at_ns!) < BigInt(b.completed_at_ns!) ? -1
            : a.completed_at_ns === b.completed_at_ns ? 0 : 1);
        if (completed.length >= 256) {
          requireValue(completed.length === 256, "completed job retention bound");
          const earliest = completed.filter(job => job.completed_at_ns === completed[0]!.completed_at_ns);
          if (earliest.length === 1) pruneId = earliest[0]!.job_id;
          else {
            const ordered = earliest.map(job => ({ job, sequence: this.db.prepare(
              "SELECT event_sequence FROM projection_events WHERE json_extract(payload,'$.result.data.outcome.kind')='production_completed' AND json_extract(payload,'$.result.data.outcome.job.job_id')=?")
              .get(job.job_id)?.["event_sequence"] }));
            // A baseline may lack historical receipt ordering within a block.
            // Repair instead of guessing which job the contract pruned.
            if (ordered.some(row => row.sequence === undefined)) return false;
            ordered.sort((a, b) => BigInt(String(a.sequence)) < BigInt(String(b.sequence)) ? -1 : 1);
            pruneId = ordered[0]!.job.job_id;
          }
        }
      }
      setLedger(o.ledger);
      setShop({ ...shop, revision: parseU64((BigInt(shop.revision) + 1n).toString()) });
      if (o.kind === "production_started") {
        this.job(o.job);
        t.next_job_id = parseU64((BigInt(t.next_job_id) + 1n).toString());
        for (const item of Object.keys(o.job.inputs_consumed) as (keyof typeof o.job.inputs_consumed)[])
          t.totals.recipe_inputs_consumed[item] = (BigInt(t.totals.recipe_inputs_consumed[item]) + BigInt(o.job.inputs_consumed[item])).toString();
      } else {
        this.db.prepare("UPDATE production_jobs SET status='completed',body=? WHERE job_id=?").run(json(o.job), o.job.job_id);
        const item = o.job.output_item;
        t.totals.completed_outputs[item] = (BigInt(t.totals.completed_outputs[item]) + BigInt(o.job.output_quantity)).toString();
        if (pruneId) {
          this.db.prepare("DELETE FROM production_jobs WHERE job_id=?").run(pruneId);
          const previous = String(this.db.prepare("SELECT pruned_through FROM production_history WHERE singleton=1").get()!["pruned_through"]);
          if (BigInt(pruneId) > BigInt(previous))
            this.db.prepare("UPDATE production_history SET pruned_through=? WHERE singleton=1").run(pruneId);
        }
      }
    }
    if (o.kind === "raw_supplies") {
      const revisions = new Map<string, bigint>();
      for (const allocation of o.allocations) {
        const id = actor(allocation.ledger);
        const previous = revisions.get(id) ?? (() => {
          const old = this.readLedger(id);
          return old ? BigInt(old.revision) : -1n;
        })();
        if (previous < 0n || BigInt(allocation.ledger.revision) !== previous + 1n) return false;
        revisions.set(id, BigInt(allocation.ledger.revision));
      }
      for (const allocation of o.allocations) {
        setLedger(allocation.ledger);
        t.totals.supplied_items[allocation.item_id] = (BigInt(t.totals.supplied_items[allocation.item_id]) + BigInt(allocation.issued_quantity)).toString();
      }
    }
    if (o.kind === "raw_supplied" || o.kind === "treasury_swept") {
      if (!nextLedger(o.ledger)) return false;
      setLedger(o.ledger);
      if (o.kind === "raw_supplied")
        t.totals.supplied_items[o.item_id] = (BigInt(t.totals.supplied_items[o.item_id]) + BigInt(o.issued_quantity)).toString();
      else t.totals.treasury_burns = (BigInt(t.totals.treasury_burns) + BigInt(o.burned_gold)).toString();
    }
    if (o.kind === "customer_funded") {
      if (BigInt(o.pool.revision) !== BigInt(t.customer_pool.revision) + 1n) return false;
      t.customer_pool = o.pool;
      t.totals.customer_topups = (BigInt(t.totals.customer_topups) + BigInt(o.issued_gold)).toString();
    }
    if (o.kind === "customer_sale") {
      const old = getListing(o.listing.listing_id);
      if (!old || !nextLedger(o.seller) || o.trade.trade_id !== t.next_trade_id ||
        BigInt(o.listing.revision) !== BigInt(old.revision) + 1n ||
        BigInt(o.pool.revision) !== BigInt(t.customer_pool.revision) + 1n) return false;
      setLedger(o.seller);
      this.listing(o.listing);
      t.customer_pool = o.pool;
      t.next_trade_id = parseU64((BigInt(t.next_trade_id) + 1n).toString());
      t.totals.customer_consumed[o.trade.item_id] = (BigInt(t.totals.customer_consumed[o.trade.item_id]) + BigInt(o.trade.consumed_quantity)).toString();
    }
    if (o.kind === "upgrade_purchased") {
      const old = getShop(o.shop.shop_id);
      if (!old || !nextLedger(o.ledger) || BigInt(o.shop.revision) !== BigInt(old.revision) + 1n) return false;
      setLedger(o.ledger);
      setShop(o.shop);
      t.totals.upgrade_burns = (BigInt(t.totals.upgrade_burns) + BigInt(o.gold_burned)).toString();
    }
    if (o.kind === "assistant_policy_set") {
      const old = getShop(o.shop.shop_id);
      if (!old || BigInt(o.shop.revision) !== BigInt(old.revision) + 1n) return false;
      setShop(o.shop);
    }
    if (o.kind === "market_event_scheduled") {
      if (o.event.event_id !== t.next_market_event_id) return false;
      t.market_event = o.event;
      t.next_market_event_id = parseU64((BigInt(t.next_market_event_id) + 1n).toString());
    }
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
      const listing = getListing(o.trade.listing_id);
      if (!listing || listing.item_id !== o.trade.item_id || listing.unit_price !== o.trade.unit_price ||
        listing.owner.kind !== "merchant" || listing.owner.merchant_id !== o.trade.seller.merchant_id ||
        BigInt(listing.remaining_quantity) < BigInt(o.trade.quantity)) return false;
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
      const remaining = parseU64((BigInt(listing.remaining_quantity) - q).toString());
      this.listing({ ...listing, remaining_quantity: remaining, active: remaining !== "0",
        revision: parseU64((BigInt(listing.revision) + 1n).toString()) });
      const index = ["rex", "luna", "bolt"].indexOf(o.trade.seller.merchant_id);
      t.npc_ledgers[index] = o.seller;
      if (o.buyer.actor.kind === "merchant")
        t.npc_ledgers[
          ["rex", "luna", "bolt"].indexOf(o.buyer.actor.merchant_id)
        ] = o.buyer;
      t.next_trade_id = parseU64((BigInt(t.next_trade_id) + 1n).toString());
    }
    const epoch = (
      (BigInt(result.block_timestamp_ns) - BigInt(t.genesis_time_ns)) /
      60_000_000_000n
    ).toString();
    if (t.customer_pool.epoch !== epoch) {
      t.customer_pool.potion_units_bought = parseU64("0");
      t.customer_pool.tool_units_bought = parseU64("0");
    }
    t.epoch = parseU64(epoch);
    t.customer_pool.epoch = parseU64(epoch);
    if (this.identity.deployment.state_schema === "2")
      for (const row of this.db.prepare("SELECT body FROM projection_offers WHERE status='pending'").all()) {
        const offer = livingTownOffer(JSON.parse(String(row["body"])));
        this.putOffer({ ...offer, expired: BigInt(offer.expires_at_ns) <= BigInt(result.block_timestamp_ns) });
      }
    s.town = { ...s.town, data: livingTownTown(t) };
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
    if (expected.customer_pool.epoch !== t.data.customer_pool.epoch) {
      expected.customer_pool.potion_units_bought = parseU64("0");
      expected.customer_pool.tool_units_bought = parseU64("0");
    }
    expected.epoch = t.data.epoch;
    expected.customer_pool.epoch = t.data.customer_pool.epoch;
    if (json(expected) !== json(t.data)) return false;
    requireValue(
      t.block_height === block.height &&
        t.block_timestamp_ns === block.timestampNs &&
        BigInt(block.height) >= BigInt(s.checkpoint.finalized_block_height),
      "inconsistent finalized projection observation",
    );
    this.transaction(() => {
      s.town = t;
      if (this.identity.deployment.state_schema === "2") {
        for (const row of this.db
          .prepare("SELECT body FROM projection_offers WHERE status='pending'")
          .all()) {
          const o = livingTownOffer(JSON.parse(String(row["body"])));
          this.putOffer({
            ...o,
            expired: BigInt(t.block_timestamp_ns) >= BigInt(o.expires_at_ns),
          });
        }
      }
      s.checkpoint.finalized_block_hash = block.hash;
      s.checkpoint.finalized_block_height = block.height;
      s.observedAt = String(stamp(now));
      this.save(s);
      const jobs = this.db
        .prepare("SELECT body FROM production_jobs")
        .all()
        .map((r) => livingTownProductionJob(JSON.parse(String(r["body"]))));
      this.feed.observe(
        t.data,
        s.checkpoint,
        t.block_timestamp_ns,
        jobs,
        t.data.market_event ? [t.data.market_event] : [],
      );
    });
    this.synchronized = true;
    return true;
  }
  noteHead(town: Snapshot<Town>, block: FinalizedBlock): void {
    const current = this.state();
    if (!current) return;
    const head = decodeLivingTownSnapshot(town, this.identity.deployment, livingTownTown);
    requireValue(head.block_height === block.height && head.block_timestamp_ns === block.timestampNs &&
      BigInt(head.event_sequence) >= BigInt(current.checkpoint.through_event_sequence), "invalid projection head");
    if (BigInt(head.event_sequence) > BigInt(current.latestSeen)) current.latestSeen = head.event_sequence;
    this.transaction(() => this.save(current));
    this.synchronized = false;
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
  events(
    after: string | null = null,
    limit = 50,
  ): ReturnType<TownActivityFeed["page"]> {
    if (!this.state()) throw new ReadApiError(503, "read_unavailable");
    return this.feed.page(after, limit);
  }
  agentActivity(records: readonly unknown[]): void {
    requireValue(records.length <= 100, "agent activity batch too large");
    this.capacity();
    this.transaction(() => {
      for (const r of records) this.feed.agent(r);
      const s = this.state();
      if (
        s &&
        this.synchronized &&
        BigInt(s.latestSeen) <= BigInt(s.checkpoint.through_event_sequence)
      )
        this.feed.flush(s.checkpoint);
    });
  }
  town(
    now = Date.now(),
  ): ReturnType<ReturnType<typeof livingTownReadEnvelope<Town>>> {
    const s = this.state();
    if (!s) throw new ReadApiError(503, "read_unavailable");
    return this.envelope(s.town.data, livingTownTown, now);
  }
  offers(
    now = Date.now(),
  ): ReturnType<
    ReturnType<
      typeof livingTownReadEnvelope<ReturnType<typeof livingTownOffer>[]>
    >
  > {
    if (this.identity.deployment.state_schema !== "2")
      throw new ReadApiError(503, "read_unavailable");
    const values = this.db
      .prepare(
        "SELECT body FROM projection_offers ORDER BY length(offer_id),offer_id",
      )
      .all()
      .map((r) => livingTownOffer(JSON.parse(String(r["body"]))));
    return this.envelope(
      values,
      (v) => {
        requireValue(Array.isArray(v) && v.length <= 140, "offer read bound");
        return v.map(livingTownOffer);
      },
      now,
    );
  }
  private putOffer(o: ReturnType<typeof livingTownOffer>): void {
    this.db
      .prepare(
        "INSERT INTO projection_offers VALUES(?,?,?) ON CONFLICT(offer_id) DO UPDATE SET status=excluded.status,body=excluded.body",
      )
      .run(o.offer_id, o.status, json(o));
    this.db
      .prepare(
        "DELETE FROM projection_offers WHERE offer_id IN (SELECT offer_id FROM projection_offers WHERE status!='pending' ORDER BY length(json_extract(body,'$.closed_at_ns')) DESC,json_extract(body,'$.closed_at_ns') DESC,length(offer_id) DESC,offer_id DESC LIMIT -1 OFFSET 128)",
      )
      .run();
  }
  merchantContext(now = Date.now()) {
    const town = this.town(now);
    if (town.stale || !this.marketReady()) throw new ReadApiError(503, "read_unavailable");
    const listings = this.db.prepare("SELECT body FROM market_listings ORDER BY length(listing_id),listing_id")
      .all().map(row => livingTownListing(JSON.parse(String(row["body"]))));
    const merchants = ["1", "2", "3"].map(id => {
      const jobs = this.db.prepare("SELECT body FROM production_jobs WHERE shop_id=? AND status='running'")
        .all(id).map(row => livingTownProductionJob(JSON.parse(String(row["body"]))));
      requireValue(jobs.length <= 1, "merchant job context bound");
      return { shop: this.shopView(id, now).snapshot, listings: listings.filter(l => l.shop_id === id),
        job: jobs[0] ?? null };
    });
    const candidates = listings.filter(l => l.owner.kind === "player" && l.active &&
      ["health_potion", "iron_tool"].includes(l.item_id)).map(listing => ({ listing,
        shop: this.shopView(listing.shop_id, now).snapshot, ledger: this.inventory(listing.shop_id, now).snapshot }));
    const pendingOffers = this.identity.deployment.state_schema === "2"
      ? this.offers(now).snapshot.data.filter(o => o.status === "pending").map(o => ({ ...o,
          expired: BigInt(o.expires_at_ns) <= BigInt(town.snapshot.block_timestamp_ns) })) : [];
    return this.envelope({ merchants, listings: listings.filter(l => l.owner.kind === "merchant"), candidates, pendingOffers,
      negotiatedTrading: this.identity.deployment.state_schema === "2" }, livingTownMerchantContext, now);
  }
  cachePlayer(snapshot: Snapshot<ReturnType<typeof livingTownPlayer> | null>): boolean {
    const current = this.town();
    if (json(snapshot.deployment) !== json(this.identity.deployment) ||
      snapshot.market_revision !== current.snapshot.market_revision || snapshot.event_sequence !== current.snapshot.event_sequence)
      return false;
    if (snapshot.data) {
      const player = livingTownPlayer(snapshot.data);
      this.transaction(() => this.ledger(player.ledger));
    }
    return true;
  }
  playerDisplay(account: string) {
    const key = `account:${account}`;
    const raw = this.db.prepare("SELECT body FROM projection_shops WHERE owner=?").get(key);
    const shop = raw ? livingTownShop(JSON.parse(String(raw["body"]))) : null;
    const listings = shop ? this.db.prepare("SELECT body FROM market_listings WHERE shop_id=? ORDER BY length(listing_id),listing_id")
      .all(shop.shop_id).map(row => livingTownListing(JSON.parse(String(row["body"])))) : [];
    const jobs = shop ? this.db.prepare("SELECT body FROM production_jobs WHERE shop_id=? ORDER BY length(job_id),job_id")
      .all(shop.shop_id).map(row => livingTownProductionJob(JSON.parse(String(row["body"])))) : [];
    const merchantListings = this.db.prepare("SELECT body FROM market_listings WHERE shop_id IN ('1','2','3') ORDER BY length(listing_id),listing_id")
      .all().map(row => livingTownListing(JSON.parse(String(row["body"]))))
      .filter(listing => listing.active && BigInt(listing.remaining_quantity) > 0n);
    const pruned = this.db.prepare("SELECT pruned_through FROM production_history WHERE singleton=1").get();
    return { ledger: this.readLedger(key), shop, listings, merchantListings, production: {
      items: jobs, historyGap: pruned ? BigInt(String(pruned["pruned_through"])) > 0n : true } };
  }
  directory(after: string | null = null, limit = 20, now = Date.now()) {
    this.town(now);
    const afterId = this.pageCursor(after, "directory");
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 50, "invalid directory limit");
    const rows = this.db.prepare("SELECT body FROM projection_shops WHERE owner LIKE 'account:%' ORDER BY length(shop_id),shop_id")
      .all().map(row => livingTownShop(JSON.parse(String(row["body"]))))
      .filter(shop => BigInt(shop.shop_id) > BigInt(afterId));
    const shops = rows.slice(0, limit);
    return this.envelope({ shops,
      next_cursor: rows.length > shops.length ? this.nextPage("directory", shops.at(-1)!.shop_id) : null },
      livingTownShopDirectory, now);
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
  private pageCursor(after: string | null, scope: string): string {
    if (after === null) return "0";
    const s = this.state()!;
    try {
      requireValue(/^[A-Za-z0-9_-]{1,1024}$/.test(after));
      const c = JSON.parse(
        Buffer.from(after, "base64url").toString("utf8"),
      ) as {
        scope: string;
        afterId: string;
        generation: string;
        blockHash: string;
        accounting: string;
      };
      requireValue(
        Object.keys(c).sort().join() ===
          "accounting,afterId,blockHash,generation,scope" &&
          c.scope === scope &&
          parseU64(c.afterId) === c.afterId &&
          Buffer.from(json(c)).toString("base64url") === after,
      );
      if (
        c.generation !== s.checkpoint.feed_generation ||
        c.blockHash !== s.checkpoint.finalized_block_hash ||
        c.accounting !== this.accounting.through()
      )
        throw new ReadApiError(409, "feed_generation_mismatch");
      return c.afterId;
    } catch (error) {
      if (error instanceof ReadApiError) throw error;
      throw new ReadApiError(400, "invalid_query");
    }
  }
  private nextPage(scope: string, afterId: string): string {
    const s = this.state()!;
    return Buffer.from(
      json({
        scope,
        afterId,
        generation: s.checkpoint.feed_generation,
        blockHash: s.checkpoint.finalized_block_hash,
        accounting: this.accounting.through(),
      }),
    ).toString("base64url");
  }
  listings(
    after: string | null = null,
    limit = 20,
    now = Date.now(),
  ): ReturnType<
    ReturnType<
      typeof livingTownReadEnvelope<
        ReturnType<typeof livingTownMarketListingsRead>
      >
    >
  > {
    const town = this.town(now);
    if (
      this.db.prepare("SELECT revision FROM market_snapshot").get()?.[
        "revision"
      ] !== town.snapshot.market_revision
    )
      throw new ReadApiError(503, "read_unavailable");
    requireValue(
      Number.isInteger(limit) && limit >= 1 && limit <= 50,
      "invalid listings limit",
    );
    const afterId = this.pageCursor(after, "market"),
      rows = this.db
        .prepare(
          "SELECT body FROM market_listings ORDER BY length(listing_id),listing_id",
        )
        .all()
        .map((r) => livingTownListing(JSON.parse(String(r["body"]))))
        .filter((l) => BigInt(l.listing_id) > BigInt(afterId));
    const items = rows.slice(0, limit),
      more = rows.length > items.length;
    return this.envelope(
      {
        items,
        has_more: more,
        next_cursor: more
          ? this.nextPage("market", items.at(-1)!.listing_id)
          : null,
      },
      livingTownMarketListingsRead,
      now,
    );
  }
  marketReady(): boolean {
    const state = this.state();
    return (
      !!state &&
      this.db.prepare("SELECT revision FROM market_snapshot").get()?.[
        "revision"
      ] === state.town.market_revision
    );
  }
  history(
    id: string,
    after: string | null = null,
    limit = 20,
    now = Date.now(),
  ): ReturnType<
    ReturnType<
      typeof livingTownReadEnvelope<
        ReturnType<typeof livingTownSalesHistoryRead>
      >
    >
  > {
    const shop = this.shopView(id, now),
      key = owner(shop.snapshot.data),
      scope = `history:${id}`,
      afterId = this.pageCursor(after, scope);
    requireValue(
      Number.isInteger(limit) && limit >= 1 && limit <= 50,
      "invalid history limit",
    );
    const through = this.state()!.checkpoint.through_event_sequence,
      rows = this.accounting
        .history(key, through)
        .filter((r) => BigInt(r.event_sequence) > BigInt(afterId)),
      items = rows.slice(0, limit),
      more = rows.length > items.length;
    return this.envelope(
      {
        shop_id: parseU64(id),
        items,
        has_more: more,
        next_cursor: more
          ? this.nextPage(scope, items.at(-1)!.event_sequence)
          : null,
        costs: this.accounting.summary(
          key,
          through,
          this.state()!.checkpoint.finalized_block_height,
        ),
      },
      livingTownSalesHistoryRead,
      now,
    );
  }
  customerDemand(
    seed: string,
    arrivalIndex: string,
    now = Date.now(),
  ): import("./customers.js").CustomerDemandInput {
    const town = this.town(now),
      through = town.snapshot.event_sequence;
    const complete =
      this.db.prepare("SELECT revision FROM market_snapshot").get()?.[
        "revision"
      ] === town.snapshot.market_revision;
    const historyComplete =
      BigInt(this.accounting.through()) >= BigInt(through);
    const candidates = complete
      ? this.db
          .prepare(
            "SELECT body FROM market_listings ORDER BY length(listing_id),listing_id",
          )
          .all()
          .map((r) => livingTownListing(JSON.parse(String(r["body"]))))
          .filter((l) => l.owner.kind === "player")
          .map((listing) => ({
            listing,
            shop: this.shopView(listing.shop_id, now).snapshot,
            ledger: this.inventory(listing.shop_id, now).snapshot,
            lastSaleEventSequence: historyComplete
              ? this.accounting.fulfillment(
                  owner(this.shopView(listing.shop_id, now).snapshot.data),
                  listing.item_id,
                  through,
                )
              : null,
          }))
      : [];
    return {
      town: town.snapshot,
      seed: parseU64(seed),
      tick: town.snapshot.data.epoch,
      arrivalIndex: parseU64(arrivalIndex),
      fresh: !town.stale,
      marketComplete: complete,
      historyComplete,
      candidates,
    };
  }
  archive(
    after: string | null = null,
    limit = 10,
  ): { body: string; sha256: string; next: string | null } {
    requireValue(
      after === null || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(after),
      "invalid archive cursor",
    );
    requireValue(
      Number.isInteger(limit) && limit >= 1 && limit <= 25,
      "invalid archive limit",
    );
    const rows = this.db
      .prepare(
        "SELECT r.request,r.tx_hash,p.body FROM projection_receipts r JOIN projection_proofs p ON p.tx_hash=r.tx_hash WHERE r.tx_hash>? ORDER BY r.tx_hash LIMIT ?",
      )
      .all(after ?? "", limit + 1);
    const entries = rows.slice(0, limit).map((row) => ({
      proof: JSON.parse(String(row["request"])),
      response_gzip_base64: Buffer.from(row["body"] as Uint8Array).toString(
        "base64",
      ),
    }));
    const body = json({
      schema: "living-town-receipt-archive-v1",
      identity: this.identity,
      checkpoint: this.cursor(),
      missing_proof_count: String(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM projection_receipts r WHERE NOT EXISTS(SELECT 1 FROM projection_proofs p WHERE p.tx_hash=r.tx_hash)",
          )
          .get()!["n"],
      ),
      entries,
    });
    return {
      body,
      sha256: sha256(body),
      next: rows.length > limit ? String(rows[limit - 1]!["tx_hash"]) : null,
    };
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
  /** Online consistent copy only; never exports signing journals or credentials. */
  async snapshotTo(path: string): Promise<void> {
    requireValue(
      !this.closed &&
        !this.snapshotting &&
        isAbsolute(path) &&
        !existsSync(path),
      "new absolute snapshot path required",
    );
    this.snapshotting = true;
    try {
      closeSync(openSync(path, "wx", 0o600));
      await backup(this.db, path);
    } finally {
      this.snapshotting = false;
    }
  }
  close(): void {
    requireValue(!this.snapshotting, "projection snapshot in progress");
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
