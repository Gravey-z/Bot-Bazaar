import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalLivingTownJson, livingTownGameView, livingTownReadEnvelope,
  parseLivingTownIdentity } from "@bot-bazaar/chain";
import type { LivingTownClient, LivingTownIdentity } from "@bot-bazaar/chain";
import { ReadApiError } from "../activity/repository.js";
import type { LivingTownProjectionStore } from "./store.js";
import type { LivingTownIndexedReceipt, LivingTownIndexedCompletion } from "@bot-bazaar/chain";

type View = ReturnType<typeof livingTownGameView>;
type Profile = Pick<View, "player" | "upgrade" | "assistantPolicy"> & { through: string };

/** Durable display projections. HTTP requests only subscribe/read SQLite;
 * collection runs on the reader's background loop, once for all browsers.
 */
export class LivingTownGameViews {
  private readonly db: DatabaseSync;
  private readonly generation: string;
  constructor(directory: string, private readonly identity: LivingTownIdentity,
    private readonly projection: LivingTownProjectionStore) {
    this.db = new DatabaseSync(join(directory, "game-views.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity(value TEXT NOT NULL,generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS views(account TEXT PRIMARY KEY,last_seen INTEGER NOT NULL,
        checked_at INTEGER NOT NULL DEFAULT 0,body TEXT);`);
    const columns = this.db.prepare("PRAGMA table_info(views)").all().map(row => row["name"]);
    if (!columns.includes("profile_json")) this.db.exec("ALTER TABLE views ADD COLUMN profile_json TEXT");
    if (!columns.includes("needs_refresh")) this.db.exec("ALTER TABLE views ADD COLUMN needs_refresh INTEGER NOT NULL DEFAULT 1");
    this.db.prepare("UPDATE views SET needs_refresh=1").run();
    const row = this.db.prepare("SELECT * FROM identity").get();
    if (row && row["value"] !== canonicalLivingTownJson(parseLivingTownIdentity(identity)))
      throw new Error("game views deployment mismatch");
    this.generation = row ? String(row["generation"]) : randomUUID();
    if (!row) this.db.prepare("INSERT INTO identity VALUES (?,?)")
      .run(canonicalLivingTownJson(identity), this.generation);
  }
  read(account: string, now = Date.now()): unknown {
    if (!/^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(account))
      throw new ReadApiError(400, "invalid_query");
    const row = this.db.prepare("SELECT body,profile_json,needs_refresh FROM views WHERE account=?").get(account);
    if (!row && Number(this.db.prepare("SELECT count(*) n FROM views").get()!["n"]) >= 1000)
      throw new ReadApiError(503, "read_unavailable");
    this.db.prepare(`INSERT INTO views(account,last_seen) VALUES (?,?)
      ON CONFLICT(account) DO UPDATE SET last_seen=excluded.last_seen`).run(account, now);
    if (!row?.["body"]) throw new ReadApiError(503, "read_unavailable");
    const saved = livingTownReadEnvelope(livingTownGameView)(JSON.parse(String(row["body"])));
    const current = this.projection.town(now);
    const profile: Profile = row["profile_json"] ? JSON.parse(String(row["profile_json"])) as Profile
      : { player: saved.snapshot.data.player, upgrade: saved.snapshot.data.upgrade,
          assistantPolicy: saved.snapshot.data.assistantPolicy, through: saved.snapshot.event_sequence };
    const local = this.projection.playerDisplay(account);
    if ((profile.player && !local.ledger) || (!profile.player && local.ledger)) {
      this.db.prepare("UPDATE views SET needs_refresh=1 WHERE account=?").run(account);
      return { ...saved, stale: true };
    }
    const player = profile.player && local.ledger ? { ...profile.player,
      ledger: local.ledger, shop_id: local.shop?.shop_id ?? null } : null;
    const upgrade = row["needs_refresh"] === 0 && profile.upgrade && local.shop && local.ledger
      ? { ...profile.upgrade, shop_revision: local.shop.revision, production_slots: local.shop.production_slots,
          eligible: !current.snapshot.data.paused && local.shop.production_slots === "1" &&
            profile.upgrade.completed_both && profile.upgrade.sold_both && BigInt(local.ledger.gold.available) >= 180n }
      : null;
    const data = livingTownGameView({ ...saved.snapshot.data, town: current.snapshot.data,
      player, shop: player ? local.shop : null, ledger: player ? local.ledger : null,
      listings: local.merchantListings, ownListings: player ? local.listings : [],
      production: player ? local.production : { items: [], historyGap: false },
      offers: this.identity.deployment.state_schema === "2" ? this.projection.offers(now).snapshot.data : [],
      upgrade, assistantPolicy: profile.assistantPolicy?.revision === local.shop?.policy_revision ? profile.assistantPolicy : null });
    return livingTownReadEnvelope(livingTownGameView)({ ...current, snapshot: { ...current.snapshot, data },
      stale: current.stale || Math.abs(now - Number(BigInt(current.snapshot.block_timestamp_ns) / 1000000n)) > 30000 });
  }
  applyReceipt(receipt: LivingTownIndexedReceipt | LivingTownIndexedCompletion): void {
    if (receipt.status.kind !== "succeeded" || receipt.status.result.data.replayed) return;
    const result = receipt.status.result;
    const outcome = result.data.outcome;
    const accounts = new Set<string>();
    if ("player" in outcome) accounts.add(outcome.player.account_id);
    if ("shop" in outcome && outcome.shop.owner.kind === "player") accounts.add(outcome.shop.owner.account_id);
    for (const ledger of ["ledger" in outcome ? outcome.ledger : null,
      "buyer" in outcome ? outcome.buyer : null, "seller" in outcome ? outcome.seller : null])
      if (ledger?.actor.kind === "player") accounts.add(ledger.actor.account_id);
    if ("listing" in outcome && outcome.listing.owner.kind === "player") accounts.add(outcome.listing.owner.account_id);
    for (const account of accounts) {
      const row = this.db.prepare("SELECT body,profile_json,needs_refresh FROM views WHERE account=?").get(account);
      if (!row) continue;
      const saved = row["body"] ? livingTownReadEnvelope(livingTownGameView)(JSON.parse(String(row["body"]))) : null;
      const profile: Profile = row["profile_json"] ? JSON.parse(String(row["profile_json"])) as Profile
        : { player: saved?.snapshot.data.player ?? null, upgrade: saved?.snapshot.data.upgrade ?? null,
            assistantPolicy: saved?.snapshot.data.assistantPolicy ?? null, through: saved?.snapshot.event_sequence ?? "0" };
      if (BigInt(result.data.effect_event_sequence) <= BigInt(profile.through)) continue;
      let dirty = Number(row["needs_refresh"]);
      if (outcome.kind === "player_registered") { profile.player = outcome.player; dirty = 0; }
      if (outcome.kind === "assistant_policy_set") profile.assistantPolicy = outcome.policy;
      if (outcome.kind === "production_completed" || outcome.kind === "customer_sale") dirty = 1;
      if (outcome.kind === "upgrade_purchased") dirty = 1;
      profile.through = result.data.effect_event_sequence;
      this.db.prepare("UPDATE views SET profile_json=?,needs_refresh=?,checked_at=0 WHERE account=?")
        .run(canonicalLivingTownJson(profile), dirty, account);
    }
  }
  async sync(client: LivingTownClient): Promise<void> {
    const now = Date.now();
    this.db.prepare("DELETE FROM views WHERE last_seen<?").run(now - 86400000);
    const rows = this.db.prepare(`SELECT account,body,needs_refresh FROM views WHERE last_seen>=? AND (body IS NULL OR needs_refresh=1)
      ORDER BY checked_at,account LIMIT 8`).all(now - 600000);
    if (!rows.length) return;
    const reader = await client.finalized();
    const town = await reader.getTown();
    const foundation = await reader.getFoundation();
    const recipes = await reader.getRecipes({ after_id: null, limit: "50",
      expected_market_revision: town.market_revision });
    if (recipes.data.has_more || recipes.data.items.length !== 2) throw new Error("incomplete game recipes");
    const listings: ReturnType<typeof livingTownGameView>["listings"] = [];
    const merchantReads = await Promise.allSettled(["1", "2", "3"].map(shopId =>
      reader.getListings({ shop_id: shopId, item_id: null, active_only: false,
        after_id: null, limit: "50", expected_market_revision: town.market_revision })));
    const merchantFailure = merchantReads.find(r => r.status === "rejected");
    if (merchantFailure?.status === "rejected") throw merchantFailure.reason;
    for (const read of merchantReads) {
      if (read.status !== "fulfilled") throw new Error("incomplete merchant reads");
      const result = read.value;
      listings.push(...result.data.items);
      if (result.data.has_more || result.data.items.length > 6)
        throw new Error("incomplete game listings");
    }
    let after: string | null = null;
    const offers: ReturnType<typeof livingTownGameView>["offers"] = [];
    let offersHistoryGap = false;
    if (this.identity.deployment.state_schema === "2") {
      after = null;
      for (let page = 0; page < 3; page++) {
        const result = await reader.getOffers({ merchant_id: null, status: "all", after_id: after,
          limit: "50", expected_market_revision: town.market_revision });
        offers.push(...result.data.items);
        offersHistoryGap ||= result.data.history_gap;
        if (!result.data.has_more) break;
        if (page === 2 || !result.data.next_after_id || result.data.next_after_id === after)
          throw new Error("incomplete game offers");
        after = result.data.next_after_id;
      }
    }
    // Finish the entire bounded read batch before committing any view.
    const results = await Promise.allSettled(rows.map(async row => {
      const account = String(row["account"]);
      const previous = row["body"]
        ? livingTownReadEnvelope(livingTownGameView)(JSON.parse(String(row["body"]))) : null;
      // All contract mutations advance these counters. A fresh verified reader
      // with equal counters can reuse personal data, even across clock epochs.
      const reuse = row["needs_refresh"] === 0 && previous?.snapshot.market_revision === town.market_revision &&
        previous.snapshot.event_sequence === town.event_sequence;
      const playerSnapshot = reuse ? null : await reader.getPlayer(account);
      if (playerSnapshot) this.projection.cachePlayer(playerSnapshot);
      const player = reuse ? previous!.snapshot.data.player : playerSnapshot!.data;
      const shopId = player?.shop_id;
      const view: ReturnType<typeof livingTownGameView> = reuse ? {
        ...previous!.snapshot.data, town: town.data, offers, offersHistoryGap,
        listings: listings.filter(l => l.active && BigInt(l.remaining_quantity) > 0n),
      } : {
        account, town: town.data, player, shop: null, ledger: player?.ledger ?? null,
        listings: listings.filter(l => l.active && BigInt(l.remaining_quantity) > 0n),
        ownListings: [], recipes: recipes.data.items.map(r => r.recipe),
        production: { items: [], historyGap: false }, offers, offersHistoryGap,
        upgrade: null, assistantPolicy: null,
        assistantRepriceAvailable: foundation.data.supported_methods.includes("assistant_reprice"),
      };
      if (shopId && !reuse) {
        const reads = await Promise.allSettled([
          reader.getShop(shopId), reader.getShopInventory(shopId),
          reader.getListings({ shop_id: shopId, item_id: null, active_only: false,
            after_id: null, limit: "50", expected_market_revision: town.market_revision }),
          foundation.data.supported_methods.includes("get_upgrade") ? reader.getUpgrade(shopId) : Promise.resolve(null),
          foundation.data.supported_methods.includes("get_assistant_policy") ? reader.getAssistantPolicy(shopId) : Promise.resolve(null),
        ] as const);
        const failure = reads.find(r => r.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const [shopRead, ledgerRead, ownedRead, upgradeRead, assistantRead] = reads;
        if (shopRead.status !== "fulfilled" || ledgerRead.status !== "fulfilled" ||
          ownedRead.status !== "fulfilled" || upgradeRead.status !== "fulfilled" || assistantRead.status !== "fulfilled")
          throw new Error("incomplete player reads");
        view.shop = shopRead.value.data;
        view.ledger = ledgerRead.value.data;
        const owned = ownedRead.value;
        if (owned.data.has_more || owned.data.items.length > 2)
          throw new Error("incomplete owned listings");
        view.ownListings = owned.data.items;
        view.upgrade = upgradeRead.value?.data ?? null;
        view.assistantPolicy = assistantRead.value?.data ?? null;
        let cursor: string | null = null;
        for (let page = 0; page < 6; page++) {
          const result = await reader.getProductionJobs({ shop_id: shopId, status: "all",
            after_id: cursor, limit: "50", expected_market_revision: town.market_revision });
          view.production.items.push(...result.data.items);
          view.production.historyGap ||= result.data.history_gap;
          if (!result.data.has_more) break;
          if (page === 5 || !result.data.next_after_id || result.data.next_after_id === cursor)
            throw new Error("incomplete game jobs");
          cursor = result.data.next_after_id;
        }
      }
      const data = livingTownGameView(view);
      const envelope = livingTownReadEnvelope(livingTownGameView)({
        schema: "living-town-read-v1", source: "confirmed_projection",
        deployment: this.identity.deployment, snapshot: { ...town, data },
        checkpoint: { network_id: "testnet",
          genesis_hash: this.identity.deployment.genesis_hash, contract_id: this.identity.deployment.contract_id,
          projection_schema_version: "1", verified_code_hash: this.identity.codeHash,
          config_sha256: this.identity.deployment.config_sha256,
          baseline_event_sequence: town.event_sequence, through_event_sequence: town.event_sequence,
          through_market_revision: town.market_revision, finalized_block_hash: reader.block.hash,
          finalized_block_height: reader.block.height, last_receipt_id: null, last_log_index: null,
          history_complete: false, gap_from_sequence: "1", feed_generation: this.generation },
        observed_at_ms: String(Date.now()), stale: false, history_complete: false,
      });
      const profile: Profile = { player: data.player, upgrade: data.upgrade,
        assistantPolicy: data.assistantPolicy, through: town.event_sequence };
      return { account, body: canonicalLivingTownJson(envelope), profile: canonicalLivingTownJson(profile),
        through: town.event_sequence };
    }));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const current = this.db.prepare("SELECT profile_json FROM views WHERE account=?").get(result.value.account);
        const profile = current?.["profile_json"] ? JSON.parse(String(current["profile_json"])) as Profile : null;
        // A slow metadata read cannot overwrite a newer receipt notification.
        if (profile && BigInt(profile.through) > BigInt(result.value.through)) continue;
        this.db.prepare("UPDATE views SET body=?,profile_json=?,needs_refresh=0,checked_at=? WHERE account=?")
          .run(result.value.body, result.value.profile, Date.now(), result.value.account);
      }
      // Rotate failed accounts as well, so an unavailable account cannot starve others.
      for (const row of rows) this.db.prepare("UPDATE views SET checked_at=? WHERE account=?")
        .run(Date.now(), String(row["account"]));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const failure = results.find(r => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  close(): void { this.db.close(); }
}
