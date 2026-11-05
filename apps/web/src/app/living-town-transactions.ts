import {
  LivingTownClient,
  canonicalLivingTownJson,
  createLivingTownCall,
  livingTownCommandDigest,
  parseLivingTownIdentity,
  parseLivingTownJson,
  parseU64,
} from "@bot-bazaar/chain";
import type {
  LivingTownCall,
  LivingTownIdentity,
  LivingTownMethod,
  LivingTownReceiptStatus,
} from "@bot-bazaar/chain";
import type { WalletStorage } from "./wallet-context";
import { walletTransactionHash } from "./registration-reader";

export class LivingTownNotOpenedError extends Error {}
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
  readonly call: LivingTownCall;
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
// Public command intent only. V1 journal keys and codecs remain independent.
export class LivingTownTransactions {
  private readonly key: string;
  private readonly identity: LivingTownIdentity;
  constructor(
    private readonly client: LivingTownClient,
    private readonly storage: WalletStorage,
    private readonly send: (
      account: string,
      call: LivingTownCall,
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
    const call = createLivingTownCall(
      c["method"] as LivingTownMethod,
      c["args"],
    );
    requireValue(
      c["gas"] === call.gas &&
        c["deposit"] === "0" &&
        BigInt(parseU64(r["referenceBlockHeight"])) > 0n &&
        r["digest"] ===
          (await livingTownCommandDigest(
            this.identity.deployment,
            r["accountId"],
            call,
          )),
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
  private async admit(account: string, call: LivingTownCall) {
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
    return reader;
  }
  async prepare(
    account: string,
    method: LivingTownMethod,
    args: unknown,
  ): Promise<LivingTownAttempt> {
    return this.lock(this.key, async () => {
      const e = await this.load();
      requireValue(e.pending === null);
      const call = createLivingTownCall(method, args),
        reader = await this.admit(account, call),
        digest = await livingTownCommandDigest(
          this.identity.deployment,
          account,
          call,
        );
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
  async refresh(): Promise<LivingTownReceiptStatus | null> {
    return this.lock(this.key, async () => {
      const e = await this.load(),
        a = e.pending;
      if (!a) return null;
      // Absence/pruning of get_command never unlocks an unresolved wallet attempt.
      if (!a.transactionHash) return null;
      const status = await this.client.receipt({
        transactionHash: a.transactionHash,
        signerId: a.accountId,
        deployment: this.identity.deployment,
        call: a.call,
        referenceBlockHeight: a.referenceBlockHeight,
      });
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
