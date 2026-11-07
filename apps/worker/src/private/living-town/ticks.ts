import type { DatabaseSync } from "node:sqlite";
import {
  canonicalLivingTownJson,
  livingTownSnapshot,
  livingTownTown,
  parseU64,
} from "@bot-bazaar/chain";
import type {
  FinalizedLivingTownReader,
  LivingTownIdentity,
} from "@bot-bazaar/chain";
import { json, requireStorage, sha256 } from "../storage/validation.js";
import type { LivingTownExecutionStore } from "./execution-store.js";
import { LivingTownCustomerDemand } from "./customers.js";

export const tickSchema = `
CREATE TABLE town_ticks(sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  slot TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL, seed TEXT NOT NULL,
  config_json TEXT NOT NULL, checkpoint_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','running','completed')),
  skipped_slots TEXT NOT NULL, missed_epochs TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE UNIQUE INDEX one_unresolved_tick ON town_ticks((1)) WHERE state!='completed';
CREATE TABLE town_tick_actions(tick_id TEXT NOT NULL REFERENCES town_ticks(id),
  ordinal INTEGER NOT NULL, action_id TEXT NOT NULL UNIQUE,
  arrival TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('planned','active','completed','failed','expired')),
  resolution_json TEXT, PRIMARY KEY(tick_id,ordinal)) STRICT;
CREATE TRIGGER bound_town_ticks BEFORE INSERT ON town_ticks
  WHEN (SELECT count(*) FROM town_ticks)>=10000
  BEGIN SELECT RAISE(ABORT,'tick journal full'); END;
`;
type Row = Record<string, string | number | bigint | Uint8Array | null>;
export interface TickCheckpoint {
  block: { hash: string; height: string; timestampNs: string };
  codeHash: string;
  town: unknown;
}
export interface TickAction {
  id: string;
  arrival: string;
}

/** Durable scheduling state inside the same exclusive database as economic intents. */
export class TownTickRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(fn: () => T) => T,
    private readonly gate: () => void,
    private readonly identity: LivingTownIdentity,
    private readonly seed: string,
  ) {}
  active(): Row | undefined {
    return this.db
      .prepare("SELECT * FROM town_ticks WHERE state!='completed'")
      .get();
  }
  get(tickId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM town_ticks WHERE id=?").get(tickId);
  }
  actions(tickId: string): Row[] {
    return this.db
      .prepare(
        "SELECT * FROM town_tick_actions WHERE tick_id=? ORDER BY ordinal",
      )
      .all(tickId);
  }
  private checkpoint(checkpoint: TickCheckpoint) {
    const town = livingTownSnapshot(livingTownTown)(checkpoint.town);
    requireStorage(
      canonicalLivingTownJson(town.deployment) ===
        canonicalLivingTownJson(this.identity.deployment) &&
        checkpoint.codeHash === this.identity.codeHash &&
        checkpoint.block.height === town.block_height &&
        checkpoint.block.timestampNs === town.block_timestamp_ns &&
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(checkpoint.block.hash),
      "tick finalized checkpoint identity mismatch",
    );
    parseU64(checkpoint.block.height);
    const elapsed =
      BigInt(town.block_timestamp_ns) - BigInt(town.data.genesis_time_ns);
    requireStorage(
      elapsed >= 0n &&
        (elapsed / 60000000000n).toString() === town.data.epoch &&
        town.data.customer_pool.epoch === town.data.epoch,
      "tick checkpoint epoch is inconsistent",
    );
    return town;
  }
  /** Skip only never-started old-epoch opportunities after all actual intents reconcile. */
  reconcile(checkpoint: TickCheckpoint): void {
    this.gate();
    const town = this.checkpoint(checkpoint);
    this.write(() => {
      const active = this.active();
      if (!active || BigInt(String(active["epoch"])) >= BigInt(town.data.epoch))
        return;
      const original = JSON.parse(
        String(active["checkpoint_json"]),
      ) as TickCheckpoint;
      requireStorage(
        BigInt(town.block_height) >= BigInt(original.block.height) &&
          !this.db.prepare("SELECT id FROM jobs WHERE status='active'").get() &&
          !this.db.prepare("SELECT job_id FROM merchant_locks LIMIT 1").get() &&
          !this.db
            .prepare(
              "SELECT id FROM intents WHERE status IN ('prepared','signed','submitted','unknown') LIMIT 1",
            )
            .get() &&
          !this.actions(String(active["id"])).some(
            (a) => a["state"] === "active",
          ),
        "unresolved economic work prevents old-tick expiry",
      );
      this.db
        .prepare(
          "UPDATE town_tick_actions SET state='expired',resolution_json=? WHERE tick_id=? AND state='planned'",
        )
        .run(
          json({
            kind: "missed_epoch",
            checkpoint: checkpoint.block,
            epoch: town.data.epoch,
          }),
          active["id"]!,
        );
      this.db
        .prepare("UPDATE town_ticks SET state='completed' WHERE id=?")
        .run(active["id"]!);
    });
  }
  skipFunding(checkpoint: TickCheckpoint): boolean {
    this.gate();
    const town = this.checkpoint(checkpoint);
    return this.write(() => {
      const active = this.active();
      if (!active || active["epoch"] !== town.data.epoch) return false;
      const next = this.actions(String(active["id"])).find((a) =>
        ["planned", "active"].includes(String(a["state"])),
      );
      if (
        next?.["arrival"] !== "fund" ||
        (!town.data.paused &&
          town.data.customer_pool.last_funded_epoch !== town.data.epoch)
      )
        return false;
      requireStorage(
        next["state"] === "planned" &&
          BigInt(town.block_height) >=
            BigInt(
              (JSON.parse(String(active["checkpoint_json"])) as TickCheckpoint)
                .block.height,
            ) &&
          !this.db.prepare("SELECT id FROM jobs WHERE status='active'").get(),
        "started funding must reconcile through its journal",
      );
      this.db
        .prepare(
          "UPDATE town_tick_actions SET state='completed',resolution_json=? WHERE action_id=?",
        )
        .run(
          json({
            kind: town.data.paused ? "paused" : "already_allocated",
            checkpoint: checkpoint.block,
          }),
          next["action_id"]!,
        );
      if (
        !this.actions(String(active["id"])).some((a) =>
          ["planned", "active"].includes(String(a["state"])),
        )
      )
        this.db
          .prepare("UPDATE town_ticks SET state='completed' WHERE id=?")
          .run(active["id"]!);
      return true;
    });
  }
  prepare(
    checkpoint: TickCheckpoint,
    cadenceMs: number,
    actions: readonly TickAction[],
  ): Row {
    this.gate();
    requireStorage(
      Number.isInteger(cadenceMs) && cadenceMs >= 30000 && cadenceMs <= 60000,
      "tick cadence must be 30000-60000 milliseconds",
    );
    const town = this.checkpoint(checkpoint);
    const elapsed =
      BigInt(town.block_timestamp_ns) - BigInt(town.data.genesis_time_ns);
    const slot = (elapsed / (BigInt(cadenceMs) * 1000000n)).toString();
    const config = canonicalLivingTownJson({
      policy: "living-town-tick-v1",
      cadenceMs: String(cadenceMs),
      configSha256: this.identity.deployment.config_sha256,
    });
    const tickId = sha256(
      canonicalLivingTownJson([this.identity, this.seed, config, slot]),
    );
    const rank = (arrival: string): number =>
      arrival.startsWith("raw:")
        ? ["crystal", "wood", "herb", "iron"].indexOf(arrival.slice(4))
        : arrival.startsWith("sweep:")
          ? 4 + ["rex", "luna", "bolt"].indexOf(arrival.slice(6))
          : arrival.startsWith("merchant:")
            ? 7 + ["rex", "luna", "bolt"].indexOf(arrival.split(":")[1]!)
            : arrival.startsWith("assistant:")
              ? 10
              : arrival === "fund"
                ? 11
                : 12 + Number(arrival);
    requireStorage(
      actions.length <= 16 &&
        new Set(actions.map((a) => a.id)).size === actions.length &&
        new Set(actions.map((a) => a.arrival)).size === actions.length &&
        actions.every(
          (a) =>
            !a.arrival.startsWith("merchant:") ||
            a.arrival.endsWith(`:${slot}`),
        ) &&
        actions.every(
          (a, i) => i === 0 || rank(a.arrival) > rank(actions[i - 1]!.arrival),
        ) &&
        actions.every(
          (a) =>
            /^[a-f0-9]{64}$/.test(a.id) &&
            (a.arrival === "fund" ||
              /^[0-3]$/.test(a.arrival) ||
              /^(raw:(crystal|wood|herb|iron)|sweep:(rex|luna|bolt)|merchant:(rex|luna|bolt):[0-9]+|assistant:[1-9][0-9]{0,3})$/.test(
                a.arrival,
              )),
        ) &&
        actions
          .filter((a) => /^[0-3]$/.test(a.arrival))
          .every(
            (a, i, arr) =>
              i === 0 || Number(a.arrival) === Number(arr[i - 1]!.arrival) + 1,
          ),
      "invalid bounded tick action plan",
    );
    return this.write(() => {
      const existing = this.get(tickId);
      // Duplicate observations preserve the first checkpoint and plan, even after completion.
      if (existing) return existing;
      const last = this.db
        .prepare("SELECT * FROM town_ticks ORDER BY sequence DESC LIMIT 1")
        .get();
      requireStorage(
        !last || last["config_json"] === config,
        "persisted tick cadence/config cannot change",
      );
      requireStorage(
        !last || BigInt(slot) > BigInt(String(last["slot"])),
        "old tick checkpoint cannot advance scheduler",
      );
      requireStorage(
        !this.active() &&
          !this.db.prepare("SELECT id FROM jobs WHERE status='active'").get() &&
          !this.db.prepare("SELECT job_id FROM merchant_locks LIMIT 1").get() &&
          !this.db
            .prepare(
              "SELECT id FROM intents WHERE status IN ('prepared','signed','submitted','unknown') LIMIT 1",
            )
            .get(),
        "unresolved economic work blocks tick advancement",
      );
      requireStorage(
        !last ||
          BigInt(town.block_height) >
            BigInt(JSON.parse(String(last["checkpoint_json"])).block.height),
        "new tick requires a newer finalized block",
      );
      const sequence = Number(last?.["sequence"] ?? 0) + 1;
      requireStorage(Number.isSafeInteger(sequence), "tick sequence overflow");
      this.db
        .prepare("INSERT INTO town_ticks VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          sequence,
          tickId,
          slot,
          town.data.epoch,
          this.seed,
          config,
          json(checkpoint),
          actions.length ? "prepared" : "completed",
          last
            ? (BigInt(slot) - BigInt(String(last["slot"])) - 1n).toString()
            : "0",
          last && BigInt(town.data.epoch) > BigInt(String(last["epoch"]))
            ? (
                BigInt(town.data.epoch) -
                BigInt(String(last["epoch"])) -
                1n
              ).toString()
            : "0",
          Date.now(),
        );
      for (const [i, a] of actions.entries()) {
        const old = this.db
          .prepare(
            "SELECT j.status AS job_status FROM customer_actions c JOIN jobs j ON j.id=c.id WHERE c.id=?",
          )
          .get(a.id);
        requireStorage(!old, "customer opportunity already scheduled/executed");
        this.db
          .prepare(
            "INSERT INTO town_tick_actions VALUES(?,?,?,?,'planned',NULL)",
          )
          .run(tickId, i, a.id, a.arrival);
      }
      return this.get(tickId)!;
    });
  }
  /** Called in the same transaction that persists the original economic decision. */
  bind(action: { id: string; tick: string; arrival: string }): void {
    const tick = this.active();
    if (!tick) return;
    const next = this.actions(String(tick["id"])).find(
      (a) => a["state"] === "planned" || a["state"] === "active",
    );
    requireStorage(
      tick["epoch"] === action.tick &&
        next?.["state"] === "planned" &&
        next["action_id"] === action.id &&
        next["arrival"] === action.arrival,
      "economic action must match the next persisted tick plan",
    );
    this.db
      .prepare("UPDATE town_tick_actions SET state='active' WHERE action_id=?")
      .run(action.id);
    this.db
      .prepare("UPDATE town_ticks SET state='running' WHERE id=?")
      .run(tick["id"]!);
  }
  /** No caller-supplied timeout/success: only the journal's definitive terminal transition. */
  settled(actionId: string, state: string): void {
    const action = this.db
      .prepare("SELECT tick_id FROM town_tick_actions WHERE action_id=?")
      .get(actionId);
    if (!action) return;
    requireStorage(
      ["completed", "failed", "expired"].includes(state) &&
        this.db.prepare("SELECT status FROM jobs WHERE id=?").get(actionId)?.[
          "status"
        ] === state &&
        !this.db
          .prepare(
            "SELECT id FROM intents WHERE job_id=? AND status IN ('prepared','signed','submitted','unknown')",
          )
          .get(actionId),
      "known tick action outcome required",
    );
    this.db
      .prepare(
        "UPDATE town_tick_actions SET state=? WHERE action_id=? AND state='active'",
      )
      .run(state, actionId);
    if (
      !this.actions(String(action["tick_id"])).some((a) =>
        ["planned", "active"].includes(String(a["state"])),
      )
    )
      this.db
        .prepare("UPDATE town_ticks SET state='completed' WHERE id=?")
        .run(action["tick_id"]!);
  }
}

/** One bounded scheduler observation; no timer, credential loader or parallel signer. */
export class LivingTownTickScheduler {
  private busy = false;
  constructor(
    private readonly store: LivingTownExecutionStore,
    private readonly demand: LivingTownCustomerDemand,
    readonly cadenceMs = 60000,
  ) {}
  async prepare(
    reader: FinalizedLivingTownReader,
    prefix: readonly TickAction[] = [],
  ): Promise<Row> {
    requireStorage(!this.busy, "tick observation already in progress");
    this.busy = true;
    try {
      this.store.gate();
      requireStorage(
        canonicalLivingTownJson(reader.identity) ===
          canonicalLivingTownJson(this.store.identity),
        "tick reader identity mismatch",
      );
      const town = await reader.getTown();
      const actions: TickAction[] = [...prefix];
      if (!town.data.paused) {
        const fundingId = sha256(
          canonicalLivingTownJson([
            "living-town-customer-fund-v1",
            this.store.identity,
            this.store.seed,
            town.data.epoch,
          ]),
        );
        if (
          BigInt(town.data.customer_pool.last_funded_epoch) <
            BigInt(town.data.epoch) &&
          !this.store.get(fundingId)
        )
          actions.push({ id: fundingId, arrival: "fund" });
        for (const a of this.demand.arrivals(
          town,
          this.store.seed,
          town.data.epoch,
        ))
          if (!this.store.get(a.customerId))
            actions.push({ id: a.customerId, arrival: a.arrivalIndex });
      }
      return this.store.ticks.prepare(
        { block: reader.block, codeHash: reader.identity.codeHash, town },
        this.cadenceMs,
        actions,
      );
    } finally {
      this.busy = false;
    }
  }
}
