import {
  LivingTownClient,
  canonicalLivingTownJson,
  createLivingTownCall,
  createLivingTownCompletionCall,
  livingTownCommandDigest,
  parseLivingTownIdentity,
  parseLivingTownJson,
  parseU64,
  planLivingTownProduction,
} from "@bot-bazaar/chain";
import type {
  LivingTownCall,
  LivingTownCompletionCall,
  LivingTownCompletionStatus,
  LivingTownIdentity,
  LivingTownMethod,
  LivingTownReceiptStatus,
} from "@bot-bazaar/chain";
import type { WalletStorage } from "./wallet-context";
import { walletTransactionHash } from "./registration-reader";

export class LivingTownNotOpenedError extends Error {}
export type TownTransactionMethod = LivingTownMethod | "complete_production";
type TownCall = LivingTownCall | LivingTownCompletionCall;
export type TownTransactionStatus =
  LivingTownReceiptStatus | LivingTownCompletionStatus;
async function attemptDigest(
  identity: LivingTownIdentity,
  account: string,
  call: TownCall,
): Promise<string> {
  if (call.method !== "complete_production")
    return livingTownCommandDigest(identity.deployment, account, call);
  const bytes = new TextEncoder().encode(
    canonicalLivingTownJson({ identity, account, call }),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
const decodeCall = (method: TownTransactionMethod, args: unknown): TownCall =>
  method === "complete_production"
    ? createLivingTownCompletionCall(args)
    : createLivingTownCall(method, args);
type Phase =
  | "prepared"
  | "awaiting_wallet"
  | "unknown"
  | "submitted"
  | "confirmed"
  | "failed"
  | "not_submitted";
export interface LivingTownAttempt {
  readonly id: string;
  readonly accountId: string;
  readonly call: TownCall;
  readonly digest: string;
  readonly referenceBlockHeight: string;
  readonly phase: Phase;
  readonly transactionHash: string | null;
  readonly hashSource: "wallet" | "manual" | null;
}
interface Envelope {
  schema: "bot-bazaar:living-town:journal:1";
  identity: LivingTownIdentity;
  pending: LivingTownAttempt | null;
  last: LivingTownAttempt | null;
}
export type LivingTownLock = <T>(
  name: string,
  work: () => Promise<T>,
) => Promise<T>;
const browserLock: LivingTownLock = async (name, work) => {
  if (!globalThis.navigator?.locks)
    throw new Error("Cross-tab transaction locking is unavailable");
  return navigator.locks.request(name, work);
};
function requireValue(value: unknown): asserts value {
  if (!value)
    throw new Error(
      "Living Town transaction journal is unavailable or invalid",
    );
}
const exact = (v: unknown, keys: string[]): Record<string, unknown> => {
  requireValue(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join() === keys.sort().join(),
  );
  return v as Record<string, unknown>;
};
// Public owner commands and non-command claims share one pending slot/lock.
// Completion digests bind local intent only; they are not command sequences.
export class LivingTownTransactions {
  private readonly key: string;
  private readonly identity: LivingTownIdentity;
  constructor(
    private readonly client: LivingTownClient,
    private readonly storage: WalletStorage,
    private readonly send: (
      account: string,
      call: TownCall,
    ) => Promise<unknown>,
    private readonly lock: LivingTownLock = browserLock,
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.identity = parseLivingTownIdentity(client.identity);
    this.key = `bot-bazaar:living-town:journal:1:${this.identity.deployment.network_id}:${this.identity.deployment.genesis_hash}:${this.identity.deployment.contract_id}`;
  }
  private async decodeAttempt(v: unknown): Promise<LivingTownAttempt | null> {
    if (v === null) return null;
    const r = exact(v, [
        "id",
        "accountId",
        "call",
        "digest",
        "referenceBlockHeight",
        "phase",
        "transactionHash",
        "hashSource",
      ]),
      c = exact(r["call"], ["method", "args", "gas", "deposit"]);
    requireValue(
      typeof r["id"] === "string" &&
        /^[a-f0-9-]{36}$/.test(r["id"]) &&
        typeof r["accountId"] === "string" &&
        [
          "prepared",
          "awaiting_wallet",
          "unknown",
          "submitted",
          "confirmed",
          "failed",
          "not_submitted",
        ].includes(String(r["phase"])),
    );
    const call = decodeCall(c["method"] as TownTransactionMethod, c["args"]);
    requireValue(
      c["gas"] === call.gas &&
        c["deposit"] === "0" &&
        BigInt(parseU64(r["referenceBlockHeight"])) > 0n &&
        r["digest"] ===
          (await attemptDigest(this.identity, r["accountId"], call)),
    );
    requireValue(
      (r["transactionHash"] === null && r["hashSource"] === null) ||
        (typeof r["transactionHash"] === "string" &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r["transactionHash"]) &&
          ["wallet", "manual"].includes(String(r["hashSource"]))),
    );
    requireValue(
      !["submitted", "confirmed", "failed"].includes(String(r["phase"])) ||
        r["transactionHash"] !== null,
    );
    requireValue(
      !["prepared", "awaiting_wallet", "not_submitted"].includes(
        String(r["phase"]),
      ) || r["transactionHash"] === null,
    );
    requireValue(r["phase"] !== "failed" || r["hashSource"] === "wallet");
    return { ...r, call } as unknown as LivingTownAttempt;
  }
  private async load(): Promise<Envelope> {
    const raw = this.storage.getItem(this.key);
    if (raw === null)
      return {
        schema: "bot-bazaar:living-town:journal:1",
        identity: this.identity,
        pending: null,
        last: null,
      };
    requireValue(raw.length <= 32768);
    const r = exact(parseLivingTownJson(raw), [
      "schema",
      "identity",
      "pending",
      "last",
    ]);
    requireValue(
      r["schema"] === "bot-bazaar:living-town:journal:1" &&
        canonicalLivingTownJson(parseLivingTownIdentity(r["identity"])) ===
          canonicalLivingTownJson(this.identity),
    );
    const pending = await this.decodeAttempt(r["pending"]),
      last = await this.decodeAttempt(r["last"]);
    requireValue(
      !pending ||
        ["prepared", "awaiting_wallet", "unknown", "submitted"].includes(
          pending.phase,
        ),
    );
    requireValue(
      !last || ["confirmed", "failed", "not_submitted"].includes(last.phase),
    );
    return {
      schema: "bot-bazaar:living-town:journal:1",
      identity: this.identity,
      pending,
      last,
    };
  }
  private async save(e: Envelope) {
    const raw = JSON.stringify(e);
    requireValue(raw.length <= 32768);
    this.storage.setItem(this.key, raw);
    requireValue(this.storage.getItem(this.key) === raw);
    await this.load();
  }
  async read(): Promise<LivingTownAttempt | null> {
    return (await this.load()).pending;
  }
  async last(): Promise<LivingTownAttempt | null> {
    return (await this.load()).last;
  }
  private async admit(account: string, call: TownCall) {
    const reader = await this.client.finalized(),
      d = this.identity;
    requireValue(
      ![
        d.deployment.contract_id,
        d.ownerId,
        d.operatorId,
        ...Object.values(d.controllers),
      ].includes(account),
    );
    if (call.method === "complete_production") {
      const player = await reader.getPlayer(account);
      requireValue(player.data?.shop_id);
      const page = await reader.getProductionJobs({
        shop_id: player.data.shop_id,
        status: "running",
        after_id: null,
        limit: "50",
        expected_market_revision: player.market_revision,
      });
      const job = page.data.items.find((j) => j.job_id === call.args.job_id);
      requireValue(
        job &&
          job.status === "running" &&
          job.owner.kind === "player" &&
          job.owner.account_id === account &&
          BigInt(job.ready_at_ns) <= BigInt(reader.block.timestampNs),
      );
      return reader;
    }
    const lookup = await reader.getCommand(account, call.args.command.sequence);
    requireValue(
      lookup.data.kind === "not_applied" &&
        lookup.data.next_sequence === call.args.command.sequence,
    );
    const now = BigInt(reader.block.timestampNs),
      expiry = BigInt(call.args.command.valid_until_ns);
    requireValue(
      call.args.command.config_version === d.deployment.config_version &&
        expiry > now &&
        expiry <= now + 600_000_000_000n,
    );
    if (call.method === "start_production") {
      const a = call.args;
      requireValue(
        "shop_id" in a &&
          "recipe_id" in a &&
          "quantity" in a &&
          "recipe_version" in a &&
          "expected_shop_revision" in a,
      );
      const town = await reader.getTown(),
        shop = await reader.getShop(a.shop_id);
      requireValue(
        !town.data.paused &&
          shop.data?.owner.kind === "player" &&
          shop.data.owner.account_id === account &&
          shop.data.revision === a.expected_shop_revision,
      );
      const recipes = await reader.getRecipes({
        after_id: null,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      const recipe = recipes.data.items.find(
        (r) => r.recipe.recipe_id === a.recipe_id,
      )?.recipe;
      requireValue(recipe && recipe.version === a.recipe_version);
      const terms = planLivingTownProduction(
        recipe,
        d.deployment.config_version,
        a.quantity,
        reader.block.timestampNs,
      );
      const ledger = (await reader.getShopInventory(a.shop_id)).data;
      const jobs = await reader.getProductionJobs({
        shop_id: a.shop_id,
        status: "running",
        after_id: null,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      requireValue(
        !jobs.data.has_more &&
          jobs.data.items.length < Number(shop.data.production_slots),
      );
      for (const [id, q] of Object.entries(terms.inputs_consumed))
        requireValue(
          BigInt(
            ledger.inventory.available[
              id as keyof typeof terms.inputs_consumed
            ],
          ) >= BigInt(q),
        );
      const output = terms.output_item;
      requireValue(
        BigInt(ledger.inventory.held[output]) +
          BigInt(ledger.inventory.production_output_reserved[output]) +
          BigInt(ledger.inventory.trade_inbound_reserved[output]) +
          BigInt(terms.output_quantity) <=
          1000n,
      );
    }
    if (call.method === "set_listing" || call.method === "cancel_listing") {
      const town = await reader.getTown(),
        player = await reader.getPlayer(account);
      requireValue(
        player.data?.shop_id &&
          (!town.data.paused || call.method === "cancel_listing"),
      );
      const shop = await reader.getShop(player.data.shop_id);
      requireValue(
        shop.data?.owner.kind === "player" &&
          shop.data.owner.account_id === account,
      );
      const listings = await reader.getListings({
        shop_id: player.data.shop_id,
        item_id: null,
        active_only: false,
        after_id: null,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      requireValue(!listings.data.has_more && listings.data.items.length <= 2);
      const args = call.args as Record<string, unknown>;
      if (call.method === "set_listing") {
        requireValue(
          args["shop_id"] === player.data.shop_id &&
            ["health_potion", "iron_tool"].includes(String(args["item_id"])),
        );
        const listing = listings.data.items.find(
          (l) => l.item_id === args["item_id"],
        );
        requireValue(
          (listing?.revision ?? null) === args["expected_listing_revision"],
        );
        const ledger = (await reader.getShopInventory(player.data.shop_id))
            .data,
          item = args["item_id"] as "health_potion" | "iron_tool";
        requireValue(
          BigInt(String(args["quantity"])) <=
            BigInt(ledger.inventory.available[item]) +
              BigInt(listing?.remaining_quantity ?? "0"),
        );
      } else {
        const listing = listings.data.items.find(
          (l) => l.listing_id === args["listing_id"],
        );
        requireValue(
          listing?.active &&
            listing.owner.kind === "player" &&
            listing.owner.account_id === account &&
            listing.revision === args["expected_listing_revision"],
        );
      }
    }
    requireValue(
      call.method !== "schedule_market_event" &&
        call.method !== "allocate_raw_supply" &&
        call.method !== "sweep_merchant_treasury" &&
        call.method !== "fund_customer_budget" &&
        call.method !== "settle_customer_purchase",
    );
    return reader;
  }
  async prepare(
    account: string,
    method: TownTransactionMethod,
    args: unknown,
  ): Promise<LivingTownAttempt> {
    return this.lock(this.key, async () => {
      const e = await this.load();
      requireValue(e.pending === null);
      const call = decodeCall(method, args),
        reader = await this.admit(account, call),
        digest = await attemptDigest(this.identity, account, call);
      const a: LivingTownAttempt = {
        id: this.uuid(),
        accountId: account,
        call,
        digest,
        referenceBlockHeight: reader.block.height,
        phase: "prepared",
        transactionHash: null,
        hashSource: null,
      };
      await this.save({ ...e, pending: a });
      return a;
    });
  }
  async submit(id: string): Promise<void> {
    return this.lock(this.key, async () => {
      const e = await this.load(),
        a = e.pending;
      requireValue(a?.id === id && a.phase === "prepared");
      await this.admit(a.accountId, a.call);
      // Persist the irreversible handoff boundary BEFORE entering the wallet.
      await this.save({ ...e, pending: { ...a, phase: "awaiting_wallet" } });
      try {
        const result = await this.send(a.accountId, a.call),
          hash = walletTransactionHash(result);
        await this.save({
          ...e,
          pending: {
            ...a,
            phase: hash ? "submitted" : "unknown",
            transactionHash: hash,
            hashSource: hash ? "wallet" : null,
          },
        });
      } catch (error) {
        if (error instanceof LivingTownNotOpenedError)
          await this.save({
            ...e,
            pending: null,
            last: { ...a, phase: "not_submitted" },
          });
        else await this.save({ ...e, pending: { ...a, phase: "unknown" } });
      }
    });
  }
  async restore(): Promise<LivingTownAttempt | null> {
    return this.lock(this.key, async () => {
      const e = await this.load();
      if (e.pending && e.pending.phase === "awaiting_wallet")
        await this.save({ ...e, pending: { ...e.pending, phase: "unknown" } });
      return this.read();
    });
  }
  async recoverHash(id: string, hash: string): Promise<void> {
    return this.lock(this.key, async () => {
      const e = await this.load(),
        a = e.pending;
      requireValue(
        a?.id === id &&
          !a.transactionHash &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash),
      );
      await this.save({
        ...e,
        pending: {
          ...a,
          phase: "unknown",
          transactionHash: hash,
          hashSource: "manual",
        },
      });
    });
  }
  async discardPrepared(id: string): Promise<void> {
    return this.lock(this.key, async () => {
      const e = await this.load();
      requireValue(e.pending?.id === id && e.pending.phase === "prepared");
      await this.save({
        ...e,
        pending: null,
        last: { ...e.pending, phase: "not_submitted" },
      });
    });
  }
  async refresh(): Promise<TownTransactionStatus | null> {
    return this.lock(this.key, async () => {
      const e = await this.load(),
        a = e.pending;
      if (!a) return null;
      // Absence/pruning of get_command never unlocks an unresolved wallet attempt.
      if (!a.transactionHash) return null;
      const proof = {
        transactionHash: a.transactionHash,
        signerId: a.accountId,
        deployment: this.identity.deployment,
        call: a.call,
        referenceBlockHeight: a.referenceBlockHeight,
      };
      const status =
        a.call.method === "complete_production"
          ? await this.client.completionReceipt({ ...proof, call: a.call })
          : await this.client.receipt({ ...proof, call: a.call });
      if (
        status.kind === "succeeded" ||
        (status.kind === "failed" && a.hashSource === "wallet")
      )
        await this.save({
          ...e,
          pending: null,
          last: {
            ...a,
            phase: status.kind === "succeeded" ? "confirmed" : "failed",
          },
        });
      else
        await this.save({
          ...e,
          pending: {
            ...a,
            phase: status.kind === "pending" ? "submitted" : "unknown",
          },
        });
      return status;
    });
  }
}
