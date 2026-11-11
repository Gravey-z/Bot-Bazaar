import type { DatabaseSync } from "node:sqlite";
import {
  canonicalLivingTownJson,
  livingTownOffer,
  livingTownOfferEffect,
  isLivingTownOfferMethod,
} from "@bot-bazaar/chain";
import type {
  FinalizedLivingTownReader,
  LivingTownOffer,
} from "@bot-bazaar/chain";
import type { TownCall } from "./town-chain.js";
import { requireStorage } from "../storage/validation.js";

export const townOfferSchema = `
CREATE TABLE town_offer_checkpoint(singleton INTEGER PRIMARY KEY CHECK(singleton=1),height TEXT NOT NULL,revision TEXT NOT NULL,block_hash TEXT NOT NULL,complete INTEGER NOT NULL CHECK(complete IN (0,1))) STRICT;
CREATE TABLE town_offer_commitments(offer_id TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','cancelled','expired')),body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096)) STRICT;
CREATE TRIGGER bound_town_offer_commitments BEFORE INSERT ON town_offer_commitments WHEN NOT EXISTS(SELECT 1 FROM town_offer_commitments WHERE offer_id=NEW.offer_id) AND (SELECT count(*) FROM town_offer_commitments)>=140 BEGIN SELECT RAISE(ABORT,'town offer cache full'); END;
CREATE TABLE town_offer_bindings(action_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE,offers_json TEXT NOT NULL CHECK(length(CAST(offers_json AS BLOB))<=32768)) STRICT;
`;
const json = canonicalLivingTownJson;
export function sameOfferTerms(
  a: LivingTownOffer,
  b: LivingTownOffer,
): boolean {
  const terms = (o: LivingTownOffer) => ({
    offer_id: o.offer_id,
    proposer: o.proposer,
    buyer: o.buyer,
    seller: o.seller,
    item_id: o.item_id,
    quantity: o.quantity,
    unit_price: o.unit_price,
    total_price: o.total_price,
    created_at_ns: o.created_at_ns,
    expires_at_ns: o.expires_at_ns,
    proposal_command_sequence: o.proposal_command_sequence,
  });
  return json(terms(a)) === json(terms(b));
}
/** Witnessed within the execution DB. Timeouts/pruned reads never release a commitment. */
export class TownOfferRepository {
  constructor(
    private readonly db: DatabaseSync,
    readonly enabled: boolean,
    private readonly write: <T>(fn: () => T) => T,
  ) {}
  pending(): LivingTownOffer[] {
    if (!this.enabled) return [];
    return this.db
      .prepare(
        "SELECT body FROM town_offer_commitments WHERE status='pending' ORDER BY length(offer_id),offer_id",
      )
      .all()
      .map((r) => livingTownOffer(JSON.parse(String(r["body"]))));
  }
  get(id: string): LivingTownOffer | null {
    if (!this.enabled) return null;
    const row = this.db
      .prepare("SELECT body FROM town_offer_commitments WHERE offer_id=?")
      .get(id);
    return row ? livingTownOffer(JSON.parse(String(row["body"]))) : null;
  }
  private put(value: LivingTownOffer): void {
    const old = this.get(value.offer_id);
    requireStorage(
      !old || sameOfferTerms(old, value),
      "stored offer terms changed",
    );
    requireStorage(
      !old || BigInt(value.revision) >= BigInt(old.revision),
      "offer revision regressed",
    );
    if (old && old.status !== "pending")
      requireStorage(json(old) === json(value), "terminal offer changed");
    // Evict terminal history only; an open obligation is never cache garbage.
    if (!old)
      this.db
        .prepare(
          "DELETE FROM town_offer_commitments WHERE offer_id IN (SELECT offer_id FROM town_offer_commitments WHERE status!='pending' ORDER BY length(json_extract(body,'$.closed_at_ns')),json_extract(body,'$.closed_at_ns'),length(offer_id),offer_id LIMIT max(0,(SELECT count(*) FROM town_offer_commitments)-139))",
        )
        .run();
    this.db
      .prepare(
        "INSERT INTO town_offer_commitments VALUES(?,?,?) ON CONFLICT(offer_id) DO UPDATE SET status=excluded.status,body=excluded.body",
      )
      .run(value.offer_id, value.status, json(value));
    this.db
      .prepare(
        "DELETE FROM town_offer_commitments WHERE offer_id IN (SELECT offer_id FROM town_offer_commitments WHERE status!='pending' ORDER BY length(json_extract(body,'$.closed_at_ns')) DESC,json_extract(body,'$.closed_at_ns') DESC,length(offer_id) DESC,offer_id DESC LIMIT -1 OFFSET 128)",
      )
      .run();
  }
  async reconcile(reader: FinalizedLivingTownReader): Promise<void> {
    requireStorage(this.enabled, "offer journal capability unavailable");
    const snapshot = await reader.getPendingMerchantOffers(),
      known = this.pending(),
      byId = new Map(snapshot.offers.map((o) => [o.offer_id, o]));
    const old = this.db.prepare("SELECT * FROM town_offer_checkpoint").get();
    requireStorage(
      !old ||
        (BigInt(snapshot.town.block_height) >= BigInt(String(old["height"])) &&
          BigInt(snapshot.town.market_revision) >=
            BigInt(String(old["revision"]))),
      "offer checkpoint regressed",
    );
    const terminals: LivingTownOffer[] = [];
    for (const o of known) {
      if (byId.has(o.offer_id)) {
        requireStorage(
          sameOfferTerms(o, byId.get(o.offer_id)!),
          "pending offer terms changed",
        );
        continue;
      }
      const current = await reader.getOffer(o.offer_id);
      requireStorage(
        current.block_height === snapshot.town.block_height &&
          current.market_revision === snapshot.town.market_revision &&
          current.data.kind === "found" &&
          current.data.offer.status !== "pending" &&
          sameOfferTerms(o, current.data.offer),
        "missing pending offer requires authoritative terminal evidence",
      );
      terminals.push(current.data.offer);
    }
    this.write(() => {
      for (const o of [...terminals, ...snapshot.offers]) this.put(o);
      requireStorage(
        this.pending().length === snapshot.offers.length,
        "offer reconciliation left unaccounted commitments",
      );
      this.db
        .prepare(
          "INSERT INTO town_offer_checkpoint VALUES(1,?,?,?,1) ON CONFLICT(singleton) DO UPDATE SET height=excluded.height,revision=excluded.revision,block_hash=excluded.block_hash,complete=1",
        )
        .run(
          snapshot.town.block_height,
          snapshot.town.market_revision,
          reader.block.hash,
        );
    });
  }
  bind(actionId: string, call: TownCall): void {
    if (!isLivingTownOfferMethod(call.method)) return;
    requireStorage(
      this.enabled &&
        this.db.prepare("SELECT complete FROM town_offer_checkpoint").get()?.[
          "complete"
        ] === 1,
      "complete authoritative offer reconciliation required",
    );
    const a = call.args as Record<string, unknown>;
    let offers: LivingTownOffer[] = [];
    if (call.method === "propose_trade") {
      requireStorage(
        !this.pending().some((o) =>
          [o.buyer, o.seller].some(
            (m) =>
              m === a["buyer_merchant_id"] || m === a["seller_merchant_id"],
          ),
        ),
        "participant already has an unresolved negotiation",
      );
    } else {
      const ids =
        call.method === "expire_offers"
          ? (a["offer_ids"] as string[])
          : [String(a["offer_id"])];
      offers = ids
        .map((id) => this.get(id))
        .filter((o): o is LivingTownOffer => o !== null);
      if (call.method !== "expire_offers")
        requireStorage(
          offers.length === 1 &&
            offers[0]!.status === "pending" &&
            offers[0]!.revision === a["expected_offer_revision"] &&
            (call.method === "cancel_trade"
              ? offers[0]!.buyer
              : offers[0]!.seller) === a["merchant_id"],
          "pending offer/participant binding required",
        );
    }
    this.db
      .prepare("INSERT INTO town_offer_bindings VALUES(?,?)")
      .run(actionId, json(offers));
  }
  confirm(actionId: string, value: unknown): void {
    requireStorage(this.enabled, "offer journal unavailable");
    const e = livingTownOfferEffect(value),
      o = e.outcome;
    const binding = this.db
      .prepare("SELECT offers_json FROM town_offer_bindings WHERE action_id=?")
      .get(actionId);
    requireStorage(binding, "original offer binding missing");
    const bound = (JSON.parse(String(binding["offers_json"])) as unknown[]).map(
      livingTownOffer,
    );
    const offers = o.kind === "offers_expired" ? o.offers : [o.offer];
    for (const offer of offers) {
      if (o.kind !== "trade_proposed")
        requireStorage(
          bound.some((b) => sameOfferTerms(b, offer)),
          "settlement/release changed original offer terms",
        );
      this.put(offer);
    }
    if (o.kind === "trade_proposed") {
      this.db
        .prepare("UPDATE intents SET offer_id=? WHERE id=?")
        .run(o.offer.offer_id, actionId);
      this.db
        .prepare(
          "UPDATE town_offer_bindings SET offers_json=? WHERE action_id=?",
        )
        .run(json([o.offer]), actionId);
    }
    this.db.prepare("UPDATE town_offer_checkpoint SET complete=0").run();
  }
}
