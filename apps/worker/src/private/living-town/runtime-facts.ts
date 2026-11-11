import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { canonicalLivingTownJson, livingTownOffer } from "@bot-bazaar/chain";
import type {
  FinalizedLivingTownReader,
  LivingTownIdentity,
} from "@bot-bazaar/chain";
import type { MerchantPolicyInput } from "./merchant-policy.js";
import type { CustomerDemandInput } from "./customers.js";
import { sameCustomerCheckpointState } from "./customers.js";
import { requireStorage, sha256 } from "../storage/validation.js";
import type { SharedMerchantFacts } from "./shared-merchant-facts.js";
type Trade = Extract<
  Awaited<ReturnType<FinalizedLivingTownReader["getTrade"]>>["data"],
  { kind: "found" }
>["value"];

/** Contiguous finalized trade observations from genesis, with durable last-sale fairness. */
export class RuntimeFacts {
  private readonly db: DatabaseSync;
  private observer?: () => void;
  private cached?: {
    merchant: MerchantPolicyInput;
    customer: Omit<CustomerDemandInput, "seed" | "tick" | "arrivalIndex">;
  };
  constructor(
    directory: string,
    private readonly identity: LivingTownIdentity,
    create: boolean,
    private readonly shared?: (reader: FinalizedLivingTownReader) => Promise<SharedMerchantFacts>,
  ) {
    this.db = new DatabaseSync(join(directory, "facts.sqlite"), {
      open: false,
    });
    // A restart never silently creates a replacement history database.
    if (!create) {
      requireStorage(
        existsSync(join(directory, "facts.sqlite")),
        "runtime facts database missing",
      );
    }
    this.db.open();
    chmodSync(join(directory, "facts.sqlite"), 0o600);
    try {
      this.db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      if (create)
        this.db.exec(
          "CREATE TABLE facts(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, next_trade TEXT NOT NULL, height TEXT NOT NULL, event_sequence TEXT NOT NULL) STRICT; CREATE TABLE trades(id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT; CREATE TABLE last_sales(shop TEXT NOT NULL,item TEXT NOT NULL,event_sequence TEXT NOT NULL,PRIMARY KEY(shop,item)) STRICT;" +
            (identity.deployment.state_schema === "2"
              ? "CREATE TABLE facts_offers(offer_id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096)) STRICT; CREATE TABLE purchase_events(trade_id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT; CREATE TRIGGER bound_purchase_events BEFORE INSERT ON purchase_events WHEN (SELECT count(*) FROM purchase_events)>=10000 BEGIN SELECT RAISE(ABORT,'purchase inbox full'); END; PRAGMA user_version=2;"
              : "PRAGMA user_version=1;"),
        );
      if (create)
        this.db
          .prepare("INSERT INTO facts VALUES(1,?,'1','0','0')")
          .run(canonicalLivingTownJson(identity));
      requireStorage(
        (identity.deployment.state_schema === "2"
          ? this.db.prepare("PRAGMA user_version").get()?.["user_version"] === 2
          : [0, 1].includes(
              Number(
                this.db.prepare("PRAGMA user_version").get()?.["user_version"],
              ),
            )) &&
          this.db.prepare("SELECT identity FROM facts").get()!["identity"] ===
            canonicalLivingTownJson(identity) &&
          this.db.prepare("PRAGMA integrity_check").get()![
            "integrity_check"
          ] === "ok",
        "facts identity/integrity mismatch",
      );
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  observeMutations(observer: () => void): void {
    this.observer = observer;
  }
  digest(): string {
    return sha256(
      JSON.stringify([
        this.db.prepare("SELECT * FROM facts").all(),
        this.db.prepare("SELECT * FROM trades ORDER BY id").all(),
        this.db.prepare("SELECT * FROM last_sales ORDER BY shop,item").all(),
        ...(this.identity.deployment.state_schema === "2"
          ? [
              this.db
                .prepare(
                  "SELECT * FROM purchase_events ORDER BY length(trade_id),trade_id",
                )
                .all(),
              this.db
                .prepare(
                  "SELECT * FROM facts_offers ORDER BY length(offer_id),offer_id",
                )
                .all(),
            ]
          : []),
      ]),
    );
  }
  async collect(reader: FinalizedLivingTownReader): Promise<{
    merchant: MerchantPolicyInput;
    customer: Omit<CustomerDemandInput, "seed" | "tick" | "arrivalIndex">;
  }> {
    const town = await reader.getTown();
    const shared = this.shared ? await this.shared(reader) : null;
    const old = this.db.prepare("SELECT * FROM facts").get()!;
    requireStorage(
      BigInt(town.block_height) >= BigInt(String(old["height"])) &&
        BigInt(town.event_sequence) >= BigInt(String(old["event_sequence"])) &&
        BigInt(town.data.next_trade_id) >= BigInt(String(old["next_trade"])),
      "facts checkpoint moved backwards",
    );
    // The reviewed contract increments the global revision/event sequence for every economic
    // mutation. Equal full town state at a newer finalized block proves that its subordinate
    // listings, jobs and ledgers have not changed. Rebind only previously complete facts;
    // key nonces and fresh finalized identity are still checked separately before signing.
    const reuse = this.cached?.merchant.historyComplete === true &&
      sameCustomerCheckpointState(this.cached.merchant.town, town);
    const pending = this.identity.deployment.state_schema === "2"
      ? shared ? { town, offers: shared.pendingOffers }
        : reuse && this.cached!.merchant.negotiatedTrading
        ? { town, offers: (this.cached!.merchant.pendingOffers ?? []).map(value => {
            const offer = livingTownOffer(value);
            // Expiry is time-derived even while economic state is unchanged.
            return { ...offer, expired: BigInt(offer.expires_at_ns) <= BigInt(town.block_timestamp_ns) };
          }) }
        : await reader.getPendingMerchantOffers()
      : null;
    requireStorage(
      !pending || canonicalLivingTownJson(pending.town) === canonicalLivingTownJson(town),
      "mixed runtime offer facts",
    );
    if (reuse && this.cached) {
      const value = structuredClone(this.cached);
      const lift = (snapshot: unknown): unknown => ({
        ...town,
        data: structuredClone((snapshot as { data: unknown }).data),
      });
      value.merchant.town = value.customer.town = town;
      if (pending) {
        value.merchant.pendingOffers = pending.offers;
        value.merchant.negotiatedTrading = true;
      }
      value.merchant.merchants = value.merchant.merchants.map((m) => ({
        ...m,
        shop: lift(m.shop),
      }));
      value.customer.candidates = value.customer.candidates.map((c) => ({
        ...c,
        shop: lift(c.shop),
        ledger: lift(c.ledger),
      }));
      value.merchant.fresh = value.customer.fresh =
        Math.abs(
          Date.now() - Number(BigInt(town.block_timestamp_ns) / 1000000n),
        ) < 60000;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("UPDATE facts SET height=?,event_sequence=?")
          .run(town.block_height, town.event_sequence);
        this.saveOffers(pending?.offers ?? []);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this.observer?.();
      this.cached = structuredClone(value);
      return value;
    }
    const newTrades: Trade[] = [];
    let complete = true;
    let next = BigInt(String(old["next_trade"]));
    // At most the contract's retained window per collection. A missed/pruned interval blocks dispatch.
    for (
      let n = 0;
      next < BigInt(town.data.next_trade_id) && n < 256;
      n++, next++
    ) {
      const row = await reader.getTrade(next.toString());
      if (row.data.kind !== "found") {
        complete = false;
        break;
      }
      requireStorage(
        row.block_height === town.block_height &&
          row.market_revision === town.market_revision &&
          row.event_sequence === town.event_sequence &&
          row.data.value.trade_id === next.toString(),
        "mixed trade checkpoint",
      );
      newTrades.push(row.data.value);
    }
    complete &&= next === BigInt(town.data.next_trade_id);
    const listings: Awaited<
      ReturnType<FinalizedLivingTownReader["getListings"]>
    >["data"]["items"] = shared ? [...shared.listings] : [];
    let after: string | null = null;
    for (let page = 0; !shared && page < 41; page++) {
      const row = await reader.getListings({
        shop_id: null,
        item_id: null,
        active_only: false,
        after_id: after,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      requireStorage(
        row.block_height === town.block_height &&
          row.event_sequence === town.event_sequence &&
          !row.data.history_gap,
        "incomplete/mixed market page",
      );
      listings.push(...row.data.items);
      if (!row.data.has_more) break;
      requireStorage(
        page < 40 &&
          row.data.next_after_id !== null &&
          BigInt(row.data.next_after_id) > BigInt(after ?? "0"),
        "market page bound/cursor",
      );
      after = row.data.next_after_id;
    }
    const merchants: MerchantPolicyInput["merchants"][number][] = [];
    if (shared) merchants.push(...shared.merchants);
    const shopIds = ["1", "2", "3"];
    const jobResults = await Promise.allSettled((shared ? [] : shopIds).map(shop_id =>
      reader.getProductionJobs({ shop_id, status: "running", after_id: null,
        limit: "50", expected_market_revision: town.market_revision })));
    const jobFailure = jobResults.find(r => r.status === "rejected");
    if (jobFailure?.status === "rejected") throw jobFailure.reason;
    for (const [index, id] of (shared ? [] : shopIds).entries()) {
      // get_town already carries these exact NPC shop records at this pinned block.
      const data = town.data.npc_shops.find((shop) => shop.shop_id === id);
      requireStorage(data, "missing NPC shop");
      const shop = { ...town, data };
      const result = jobResults[index]!;
      requireStorage(result.status === "fulfilled", "incomplete production reads");
      const jobs = result.value;
      requireStorage(
        !jobs.data.has_more &&
          jobs.data.items.length <= 1 &&
          jobs.block_height === town.block_height,
        "incomplete NPC slots",
      );
      merchants.push({
        shop: { ...shop, data: shop.data },
        listings: listings.filter((l) => l.shop_id === id),
        job: jobs.data.items[0] ?? null,
      });
    }
    const candidates: CustomerDemandInput["candidates"][number][] = [];
    if (shared) candidates.push(...shared.candidates.map(candidate => ({ ...candidate,
      lastSaleEventSequence: null })));
    const candidateListings = listings.filter(
      (l) =>
        l.owner.kind === "player" &&
        ["health_potion", "iron_tool"].includes(l.item_id) &&
        l.active,
    );
    for (let offset = 0; !shared && offset < candidateListings.length; offset += 4) {
      const batch = await Promise.allSettled(candidateListings.slice(offset, offset + 4).map(async listing => {
        const reads = await Promise.allSettled([
          reader.getShop(listing.shop_id), reader.getShopInventory(listing.shop_id),
        ] as const);
        const failure = reads.find(r => r.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const [shopRead, ledgerRead] = reads;
        requireStorage(shopRead.status === "fulfilled" && ledgerRead.status === "fulfilled",
          "incomplete candidate reads");
        const shop = shopRead.value;
        requireStorage(shop.data, "missing listed shop");
        return { listing, shop: { ...shop, data: shop.data }, ledger: ledgerRead.value,
          lastSaleEventSequence: null };
      }));
      const failure = batch.find(r => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const result of batch) {
        requireStorage(result.status === "fulfilled", "incomplete candidate batch");
        candidates.push(result.value);
      }
    }
    requireStorage(candidates.length <= 2000, "candidate bound exceeded");
    const cutoff =
      BigInt(town.block_timestamp_ns) - 300000000000n >
      BigInt(town.data.genesis_time_ns)
        ? BigInt(town.block_timestamp_ns) - 300000000000n
        : BigInt(town.data.genesis_time_ns);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const trade of newTrades) {
        if (
          this.identity.deployment.state_schema === "2" &&
          trade.kind === "raw_purchase" &&
          trade.buyer.kind === "player"
        )
          this.db
            .prepare("INSERT INTO purchase_events VALUES(?,?)")
            .run(trade.trade_id, canonicalLivingTownJson(trade));
        this.db
          .prepare("INSERT INTO trades VALUES(?,?)")
          .run(trade.trade_id, canonicalLivingTownJson(trade));
        if (trade.kind === "customer_sale")
          this.db
            .prepare(
              "INSERT INTO last_sales VALUES(?,?,?) ON CONFLICT(shop,item) DO UPDATE SET event_sequence=excluded.event_sequence",
            )
            .run(trade.seller.account_id, trade.item_id, trade.event_sequence);
      }
      for (const row of this.db.prepare("SELECT id,body FROM trades").all()) {
        const trade = JSON.parse(String(row["body"])) as Trade;
        if (BigInt(trade.settled_at_ns) < cutoff)
          this.db.prepare("DELETE FROM trades WHERE id=?").run(row["id"]!);
      }
      this.db
        .prepare("UPDATE facts SET next_trade=?,height=?,event_sequence=?")
        .run(next.toString(), town.block_height, town.event_sequence);
      this.saveOffers(pending?.offers ?? []);
      this.db.exec("COMMIT");
      this.observer?.();
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* committed witness mismatch remains blocked */
      }
      throw e;
    }
    const trades = this.db
      .prepare("SELECT body FROM trades ORDER BY id")
      .all()
      .map((r) => JSON.parse(String(r["body"])) as Trade);
    requireStorage(
      trades.length <= 2000,
      "merchant history window exceeds policy bound",
    );
    for (const candidate of candidates) {
      const listing = candidate.listing as (typeof listings)[number];
      candidate.lastSaleEventSequence =
        (this.db
          .prepare(
            "SELECT event_sequence FROM last_sales WHERE shop=? AND item=?",
          )
          .get(
            listing.owner.kind === "player" ? listing.owner.account_id : "",
            listing.item_id,
          )?.["event_sequence"] as string | undefined) ?? null;
    }
    const fresh =
      Math.abs(
        Date.now() - Number(BigInt(town.block_timestamp_ns) / 1000000n),
      ) < 60000;
    const result = {
      merchant: {
        town,
        merchants,
        trades,
        fresh,
        historyComplete: complete,
        ...(pending
          ? { pendingOffers: pending.offers, negotiatedTrading: true }
          : {}),
        merchantTrading:
          typeof reader.getFoundation === "function" &&
          (await reader.getFoundation()).data.supported_methods.includes(
            "merchant_purchase",
          ),
      },
      customer: {
        town,
        candidates,
        fresh,
        marketComplete: true,
        historyComplete: complete,
      },
    };
    this.cached = structuredClone(result);
    return result;
  }
  close(): void {
    this.db.close();
  }
  purchasesAfter(after: string): unknown[] {
    if (this.identity.deployment.state_schema !== "2") return [];
    return this.db
      .prepare(
        "SELECT body FROM purchase_events WHERE length(trade_id)>length(?) OR (length(trade_id)=length(?) AND trade_id>?) ORDER BY length(trade_id),trade_id LIMIT 256",
      )
      .all(after, after, after)
      .map((r) => JSON.parse(String(r.body)));
  }
  private saveOffers(values: unknown[]): void {
    if (this.identity.deployment.state_schema !== "2") return;
    requireStorage(values.length <= 12, "runtime pending offer capacity");
    this.db.prepare("DELETE FROM facts_offers").run();
    for (const value of values) {
      const o = livingTownOffer(value);
      requireStorage(
        o.status === "pending",
        "runtime facts require pending offers",
      );
      this.db
        .prepare("INSERT INTO facts_offers VALUES(?,?)")
        .run(o.offer_id, canonicalLivingTownJson(o));
    }
  }
}
