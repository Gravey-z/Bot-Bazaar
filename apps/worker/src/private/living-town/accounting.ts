import type { DatabaseSync } from "node:sqlite";
import {
  canonicalLivingTownJson,
  livingTownHistoryEntry,
  livingTownCostSummary,
} from "@bot-bazaar/chain";
import type {
  LivingTownIndexedReceipt,
  LivingTownIndexedCompletion,
} from "@bot-bazaar/chain";
import { livingTownItemIds } from "@bot-bazaar/shared";
import { requireStorage } from "../storage/validation.js";
import {
  allocateOutputCosts,
  costTotal,
  decodeCostUnits,
  encodeCostUnits,
} from "./cost-lots.js";
import type { CostUnit } from "./cost-lots.js";

type Effect = Extract<
  (LivingTownIndexedReceipt | LivingTownIndexedCompletion)["status"],
  { kind: "succeeded" }
>["result"];
type History = ReturnType<typeof livingTownHistoryEntry>;
const actorKey = (
  actor:
    | { kind: "player"; account_id: string }
    | { kind: "merchant"; merchant_id: string },
): string =>
  actor.kind === "player"
    ? `account:${actor.account_id}`
    : `merchant:${actor.merchant_id}`;
const json = canonicalLivingTownJson;

/** Runs only inside the projection's receipt/event transaction. Balances are independent. */
export class LivingTownAccounting {
  constructor(private readonly db: DatabaseSync) {}
  through(): string {
    return String(
      this.db.prepare("SELECT through_sequence FROM cost_cursor").get()![
        "through_sequence"
      ],
    );
  }
  private units(actor: string, item: string): CostUnit[] {
    const row = this.db
      .prepare("SELECT units FROM cost_inventory WHERE actor=? AND item=?")
      .get(actor, item);
    return row ? decodeCostUnits(row["units"] as Uint8Array) : [];
  }
  private put(actor: string, item: string, units: CostUnit[]): void {
    this.db
      .prepare(
        "INSERT INTO cost_inventory VALUES(?,?,?) ON CONFLICT(actor,item) DO UPDATE SET units=excluded.units",
      )
      .run(actor, item, encodeCostUnits(units));
  }
  private take(
    actor: string,
    item: string,
    quantity: number,
    skip = 0,
  ): CostUnit[] {
    const units = this.units(actor, item);
    const knownActor = !!this.db
      .prepare("SELECT actor FROM cost_actors WHERE actor=?")
      .get(actor);
    requireStorage(
      !knownActor || units.length >= skip + quantity,
      "FIFO receipt history contradicts stock",
    );
    while (units.length < skip + quantity)
      units.push({ cost: null, source: "0", ordinal: String(units.length) });
    const taken = units.splice(skip, quantity);
    this.put(actor, item, units);
    return taken;
  }
  /** Record confirmed facts even if earlier acquisition/production evidence is missing. */
  record(result: Effect): void {
    const o = result.data.outcome,
      seq = result.event_sequence;
    const proof = this.db
      .prepare(
        "SELECT r.*,e.log_index,EXISTS(SELECT 1 FROM projection_proofs p WHERE p.tx_hash=r.tx_hash) AS available FROM projection_events e JOIN projection_receipts r ON r.receipt_id=e.receipt_id WHERE e.event_sequence=?",
      )
      .get(seq)!;
    const add = (
      actor: string,
      kind: History["kind"],
      item: History["item_id"],
      quantity: string | null,
      gold: string,
      status: History["cost_status"],
    ): void => {
      const row = livingTownHistoryEntry({
        event_sequence: seq,
        kind,
        item_id: item,
        quantity,
        gold_amount: gold,
        cogs: null,
        profit: null,
        production_cost: null,
        cost_status: status,
        transaction_hash: proof["tx_hash"],
        receipt_id: proof["receipt_id"],
        log_index: proof["log_index"],
        block_hash: proof["block_hash"],
        block_height: proof["block_height"],
        block_timestamp_ns: result.block_timestamp_ns,
        proof_available: proof["available"] === 1,
      });
      this.db
        .prepare("INSERT INTO sales_history VALUES(?,?,?)")
        .run(seq, actor, json(row));
    };
    if (o.kind === "player_registered")
      add(
        `account:${o.player.account_id}`,
        "player_grant",
        null,
        null,
        o.player.ledger.gold.held,
        "not_applicable",
      );
    if (o.kind === "raw_purchased") {
      add(
        actorKey(o.buyer.actor),
        "material_purchase",
        o.trade.item_id,
        o.trade.quantity,
        o.trade.total_price,
        "known",
      );
      add(
        actorKey(o.seller.actor),
        "material_sale",
        o.trade.item_id,
        o.trade.quantity,
        o.trade.total_price,
        "unknown",
      );
    }
    if (o.kind === "customer_sale")
      add(
        actorKey(o.seller.actor),
        "customer_sale",
        o.trade.item_id,
        o.trade.quantity,
        o.trade.total_price,
        "unknown",
      );
    if (o.kind === "production_started" || o.kind === "production_completed")
      add(
        actorKey(o.job.owner),
        o.kind,
        o.job.output_item,
        o.job.output_quantity,
        "0",
        "unknown",
      );
  }
  private cost(seq: string, actor: string, values: Partial<History>): void {
    const row = this.db
      .prepare(
        "SELECT body FROM sales_history WHERE event_sequence=? AND actor=?",
      )
      .get(seq, actor);
    requireStorage(row, "missing accounting history fact");
    const entry = livingTownHistoryEntry({
      ...JSON.parse(String(row["body"])),
      ...values,
    });
    this.db
      .prepare(
        "UPDATE sales_history SET body=? WHERE event_sequence=? AND actor=?",
      )
      .run(json(entry), seq, actor);
  }
  /** Only contiguous verified events advance FIFO. Late receipts fill gaps without rewinding balances. */
  advance(): void {
    let through = BigInt(this.through());
    while (true) {
      const seq = (through + 1n).toString(),
        row = this.db
          .prepare(
            "SELECT payload FROM projection_events WHERE event_sequence=?",
          )
          .get(seq);
      if (!row) break;
      const result = (JSON.parse(String(row["payload"])) as { result: Effect })
          .result,
        o = result.data.outcome;
      if (o.kind === "player_registered") {
        const actor = actorKey(o.player.ledger.actor);
        requireStorage(
          !this.db
            .prepare("SELECT actor FROM cost_actors WHERE actor=?")
            .get(actor),
          "duplicate accounting registration",
        );
        this.db.prepare("INSERT INTO cost_actors VALUES(?)").run(actor);
        for (const item of livingTownItemIds)
          this.put(
            actor,
            item,
            allocateUnknown(o.player.ledger.inventory.held[item], seq),
          );
      }
      if (o.kind === "raw_purchased") {
        const actor = actorKey(o.buyer.actor),
          item = o.trade.item_id;
        const units = this.units(actor, item);
        units.push(
          ...allocateOutputCosts(o.trade.total_price, o.trade.quantity, seq),
        );
        this.put(actor, item, units);
        requireStorage(
          units.length === Number(o.buyer.inventory.held[item]),
          "FIFO purchase quantity mismatch",
        );
      }
      if (o.kind === "production_started") {
        const actor = actorKey(o.job.owner),
          inputs: CostUnit[] = [];
        // Listing/trade reservations keep their oldest lot identities; crafting takes available units.
        const parts = livingTownItemIds.map((item) => {
          const count = Number(o.job.inputs_consumed[item]),
            skip =
              Number(o.ledger.inventory.listing_reserved[item]) +
              Number(o.ledger.inventory.trade_reserved[item]);
          const units = count ? this.take(actor, item, count, skip) : [];
          inputs.push(...units);
          return { item, units };
        });
        const total = costTotal(inputs);
        this.db.prepare("INSERT INTO cost_jobs VALUES(?,?,?)").run(
          o.job.job_id,
          actor,
          json({
            cost: total,
            quantity: o.job.output_quantity,
            item: o.job.output_item,
            completed: false,
            start_sequence: seq,
          }),
        );
        for (const part of parts)
          this.db
            .prepare("INSERT INTO cost_job_inputs VALUES(?,?,?)")
            .run(o.job.job_id, part.item, encodeCostUnits(part.units));
        this.cost(seq, actor, {
          production_cost: total,
          cost_status: total === null ? "unknown" : "known",
        });
      }
      if (o.kind === "production_completed") {
        const actor = actorKey(o.job.owner),
          stored = this.db
            .prepare("SELECT actor,body FROM cost_jobs WHERE job_id=?")
            .get(o.job.job_id);
        const job = stored
          ? (JSON.parse(String(stored["body"])) as {
              cost: string | null;
              quantity: string;
              item: string;
              completed: boolean;
              start_sequence: string;
            })
          : null;
        requireStorage(
          !job ||
            (stored!["actor"] === actor &&
              !job.completed &&
              job.quantity === o.job.output_quantity &&
              job.item === o.job.output_item),
          "production cost/job mismatch",
        );
        const cost = job?.cost ?? null,
          units = this.units(actor, o.job.output_item);
        units.push(...allocateOutputCosts(cost, o.job.output_quantity, seq));
        this.put(actor, o.job.output_item, units);
        if (job)
          this.db
            .prepare("UPDATE cost_jobs SET body=? WHERE job_id=?")
            .run(json({ ...job, completed: true }), o.job.job_id);
        this.cost(seq, actor, {
          production_cost: cost,
          cost_status: cost === null ? "unknown" : "known",
        });
      }
      if (o.kind === "customer_sale") {
        const actor = actorKey(o.seller.actor),
          units = this.take(actor, o.trade.item_id, Number(o.trade.quantity));
        const cost = costTotal(units);
        this.cost(seq, actor, {
          cogs: cost,
          profit:
            cost === null
              ? null
              : (BigInt(o.trade.total_price) - BigInt(cost)).toString(),
          cost_status: cost === null ? "unknown" : "known",
        });
        this.db
          .prepare(
            "INSERT INTO customer_fulfillment VALUES(?,?,?) ON CONFLICT(actor,item) DO UPDATE SET event_sequence=excluded.event_sequence",
          )
          .run(actor, o.trade.item_id, seq);
      }
      through++;
      this.db
        .prepare("UPDATE cost_cursor SET through_sequence=?")
        .run(through.toString());
    }
  }
  history(actor: string, through: string): History[] {
    return this.db
      .prepare(
        "SELECT body FROM sales_history WHERE actor=? ORDER BY length(event_sequence),event_sequence",
      )
      .all(actor)
      .map((r) => livingTownHistoryEntry(JSON.parse(String(r["body"]))))
      .filter((r) => BigInt(r.event_sequence) <= BigInt(through));
  }
  summary(
    actor: string,
    through: string,
  ): ReturnType<typeof livingTownCostSummary> {
    const rows = this.history(actor, through),
      sales = rows.filter(
        (r) => r.kind === "customer_sale" || r.kind === "material_sale",
      );
    const sum = (kind: History["kind"]): string =>
      rows
        .filter((r) => r.kind === kind)
        .reduce((n, r) => n + BigInt(r.gold_amount), 0n)
        .toString();
    const revenue = sales.reduce((n, r) => n + BigInt(r.gold_amount), 0n),
      known =
        BigInt(this.through()) >= BigInt(through) &&
        sales.every((r) => r.cogs !== null),
      cogs = known ? sales.reduce((n, r) => n + BigInt(r.cogs!), 0n) : null;
    const complete = BigInt(this.through()) >= BigInt(through);
    return livingTownCostSummary({
      recorded_grants: sum("player_grant"),
      recorded_material_spending: sum("material_purchase"),
      recorded_sales_revenue: revenue.toString(),
      recorded_upgrade_spending: "0",
      recorded_cogs: cogs?.toString() ?? null,
      recorded_profit: cogs === null ? null : (revenue - cogs).toString(),
      cost_history_complete: complete,
      through_event_sequence:
        BigInt(this.through()) < BigInt(through) ? this.through() : through,
      gap_from_sequence: complete
        ? null
        : (BigInt(this.through()) + 1n).toString(),
    });
  }
  fulfillment(actor: string, item: string, through: string): string | null {
    requireStorage(
      BigInt(this.through()) >= BigInt(through),
      "confirmed fulfillment history incomplete",
    );
    return (
      this.history(actor, through)
        .filter((r) => r.kind === "customer_sale" && r.item_id === item)
        .at(-1)?.event_sequence ?? null
    );
  }
}
function allocateUnknown(count: string, source: string): CostUnit[] {
  return count === "0" ? [] : allocateOutputCosts(null, count, source);
}
