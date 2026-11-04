import { createMarketCall, parseU64 } from "@bot-bazaar/chain";
import type { PublicConfig } from "@bot-bazaar/shared";

export type PlayerMethod = "register_player" | "buy_from_merchant";
export type TransactionPhase =
  | "prepared"
  | "awaiting_wallet"
  | "submitted"
  | "unknown"
  | "rejected"
  | "failed"
  | "confirmed"
  | "registered"
  | "not_submitted";
const phases: readonly TransactionPhase[] = [
  "prepared",
  "awaiting_wallet",
  "submitted",
  "unknown",
  "rejected",
  "failed",
  "confirmed",
  "registered",
  "not_submitted",
];
const terminal = new Set<TransactionPhase>([
  "rejected",
  "failed",
  "confirmed",
  "registered",
  "not_submitted",
]);
export interface WalletContext {
  readonly version: 1;
  readonly id: string;
  readonly networkId: "testnet";
  readonly contractId: string;
  readonly accountId: string | null;
  readonly kind: "connect" | "transaction";
  readonly createdAt: number;
  readonly returnUrl: string;
  readonly call: { method: PlayerMethod; args: unknown } | null;
  readonly transactionHash?: string;
  readonly lifecycle?: {
    readonly phase: TransactionPhase;
    readonly updatedAt: number;
  };
  readonly returnConsumed?: boolean;
  readonly referenceBlockHeight?: string;
  readonly transactionSource?: "wallet" | "return" | "manual";
}
export interface WalletStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function isTestnetAccount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 64 &&
    (/^[a-f0-9]{64}$/.test(value) ||
      /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(
        value,
      ))
  );
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Wallet context is unavailable or invalid.");
}

// Public intent only. A callback is a hint for later receipt reconciliation,
// never proof of sign-in, rejection, execution or finality.
export class WalletContextStore {
  private readonly key: string;
  private readonly route: URL;
  constructor(
    private readonly config: Pick<PublicConfig, "networkId" | "contractId">,
    private readonly storage: WalletStorage,
    pageUrl: string,
    private readonly uuid: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = Date.now,
  ) {
    this.key = `bot-bazaar:wallet-context:v1:${config.networkId}:${config.contractId}`;
    this.route = new URL(pageUrl);
    requireValue(
      this.route.protocol === "https:" ||
        (this.route.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(this.route.hostname)),
    );
    this.route.search = "";
    this.route.hash = "";
  }
  read(): WalletContext | null {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return null;
    return this.decode(raw);
  }
  private decode(raw: string): WalletContext {
    requireValue(raw.length <= 4096);
    const value = JSON.parse(raw) as WalletContext;
    requireValue(
      value &&
        [
          "accountId",
          "call",
          "contractId",
          "createdAt",
          "id",
          "kind",
          "networkId",
          "returnUrl",
          "version",
        ].every((key) => Object.hasOwn(value, key)) &&
        Object.keys(value).every((key) =>
          [
            "accountId",
            "call",
            "contractId",
            "createdAt",
            "id",
            "kind",
            "networkId",
            "returnUrl",
            "version",
            "transactionHash",
            "lifecycle",
            "returnConsumed",
            "referenceBlockHeight",
            "transactionSource",
          ].includes(key),
        ),
    );
    requireValue(
      value.version === 1 &&
        value.networkId === "testnet" &&
        value.networkId === this.config.networkId &&
        value.contractId === this.config.contractId &&
        typeof value.id === "string" &&
        /^[a-f0-9-]{36}$/.test(value.id) &&
        Number.isSafeInteger(value.createdAt) &&
        value.createdAt >= 0,
    );
    const callback = new URL(value.returnUrl);
    requireValue(
      callback.origin === this.route.origin &&
        callback.pathname === this.route.pathname &&
        callback.search === `?bbWalletState=${value.id}` &&
        !callback.hash,
    );
    if (value.kind === "connect")
      requireValue(
        value.accountId === null &&
          value.call === null &&
          value.transactionHash === undefined &&
          value.lifecycle === undefined &&
          value.returnConsumed === undefined &&
          value.referenceBlockHeight === undefined &&
          value.transactionSource === undefined,
      );
    else {
      requireValue(
        value.kind === "transaction" &&
          isTestnetAccount(value.accountId) &&
          value.call &&
          Object.keys(value.call).sort().join() === "args,method" &&
          ["register_player", "buy_from_merchant"].includes(value.call.method),
      );
      requireValue(
        value.returnConsumed === undefined ||
          typeof value.returnConsumed === "boolean",
      );
      if (value.referenceBlockHeight !== undefined)
        requireValue(BigInt(parseU64(value.referenceBlockHeight)) > 0n);
      requireValue(
        value.transactionSource === undefined ||
          (!!value.transactionHash &&
            ["wallet", "return", "manual"].includes(value.transactionSource)),
      );
      requireValue(
        value.lifecycle === undefined ||
          (value.lifecycle !== null &&
            typeof value.lifecycle === "object" &&
            !Array.isArray(value.lifecycle)),
      );
      if (value.lifecycle) {
        requireValue(
          Object.keys(value.lifecycle).sort().join() === "phase,updatedAt" &&
            phases.includes(value.lifecycle.phase) &&
            Number.isSafeInteger(value.lifecycle.updatedAt) &&
            value.lifecycle.updatedAt >= value.createdAt,
        );
        requireValue(
          !["submitted", "confirmed"].includes(value.lifecycle.phase) ||
            !!value.transactionHash,
        );
      }
      createMarketCall(value.call.method, value.call.args);
      requireValue(
        value.transactionHash === undefined ||
          (typeof value.transactionHash === "string" &&
            /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.transactionHash)),
      );
    }
    return value;
  }
  lastTransaction(): WalletContext | null {
    const raw = this.storage.getItem(`${this.key}:last`);
    if (raw === null) return null;
    const value = this.decode(raw);
    requireValue(
      value.kind === "transaction" &&
        value.lifecycle &&
        terminal.has(value.lifecycle.phase),
    );
    return value;
  }
  beginConnect(): WalletContext {
    return this.save("connect", null, null);
  }
  prepareTransaction(
    accountId: string,
    method: PlayerMethod,
    args: unknown,
    referenceBlockHeight?: string,
  ): WalletContext {
    requireValue(
      isTestnetAccount(accountId) &&
        ["register_player", "buy_from_merchant"].includes(method),
    );
    const call = createMarketCall(method, args);
    if (referenceBlockHeight !== undefined)
      requireValue(BigInt(parseU64(referenceBlockHeight)) > 0n);
    return this.save(
      "transaction",
      accountId,
      { method, args: call.args },
      referenceBlockHeight,
    );
  }
  private save(
    kind: WalletContext["kind"],
    accountId: string | null,
    call: WalletContext["call"],
    referenceBlockHeight?: string,
  ): WalletContext {
    requireValue(this.config.networkId === "testnet" && !this.read());
    if (kind === "transaction") this.lastTransaction();
    const id = this.uuid();
    requireValue(/^[a-f0-9-]{36}$/.test(id));
    const returnUrl = new URL(this.route);
    returnUrl.searchParams.set("bbWalletState", id);
    const context: WalletContext = {
      version: 1,
      id,
      networkId: "testnet",
      contractId: this.config.contractId,
      accountId,
      kind,
      createdAt: this.now(),
      returnUrl: returnUrl.href,
      call,
      ...(referenceBlockHeight !== undefined ? { referenceBlockHeight } : {}),
      ...(kind === "transaction"
        ? { lifecycle: { phase: "prepared" as const, updatedAt: this.now() } }
        : {}),
    };
    this.storage.setItem(this.key, JSON.stringify(context));
    requireValue(this.read()?.id === id);
    return context;
  }
  finishConnect(id: string): void {
    const context = this.read();
    requireValue(context?.kind === "connect" && context.id === id);
    this.storage.removeItem(this.key);
  }
  recordRegistrationHash(id: string, hash: string): void {
    this.recordHash(id, hash, "register_player");
  }
  recordPurchaseHash(id: string, hash: string): void {
    this.recordHash(id, hash, "buy_from_merchant");
  }
  progress(
    id: string,
    phase: "awaiting_wallet" | "submitted" | "unknown",
  ): void {
    const value = this.read();
    requireValue(
      value?.kind === "transaction" &&
        value.id === id &&
        !terminal.has(value.lifecycle?.phase ?? "unknown"),
    );
    if (phase === "awaiting_wallet")
      requireValue(
        value.lifecycle?.phase === "prepared" && !value.transactionHash,
      );
    if (phase === "submitted") requireValue(!!value.transactionHash);
    const updated = {
      ...value,
      lifecycle: { phase, updatedAt: Math.max(this.now(), value.createdAt) },
    };
    this.storage.setItem(this.key, JSON.stringify(updated));
    requireValue(this.read()?.lifecycle?.phase === phase);
  }
  settle(
    id: string,
    phase: "rejected" | "failed" | "confirmed" | "registered" | "not_submitted",
  ): void {
    const value = this.read();
    if (value === null && this.lastTransaction()?.id === id) return;
    requireValue(value?.kind === "transaction" && value.id === id);
    requireValue(phase !== "confirmed" || !!value.transactionHash);
    const settled = {
      ...value,
      lifecycle: { phase, updatedAt: Math.max(this.now(), value.createdAt) },
    };
    const raw = JSON.stringify(settled);
    this.decode(raw);
    // Archive before releasing the pending lock. Failed persistence keeps it locked.
    this.storage.setItem(`${this.key}:last`, raw);
    requireValue(this.storage.getItem(`${this.key}:last`) === raw);
    this.storage.removeItem(this.key);
    requireValue(this.read() === null);
  }
  private recordHash(
    id: string,
    hash: string,
    method: PlayerMethod,
    source: "wallet" | "return" | "manual" = "wallet",
  ): void {
    const context = this.read();
    requireValue(
      context?.id === id &&
        context.call?.method === method &&
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) &&
        (!context.transactionHash ||
          context.transactionHash === hash ||
          (context.transactionSource &&
            context.transactionSource !== "wallet" &&
            (source === "wallet" ||
              (source === "manual" &&
                context.lifecycle?.phase === "unknown")))),
    );
    this.storage.setItem(
      this.key,
      JSON.stringify({
        ...context,
        transactionHash: hash,
        transactionSource:
          context.transactionHash === hash &&
          context.transactionSource === "wallet"
            ? "wallet"
            : source,
        lifecycle: {
          phase:
            source === "wallet" || context.transactionSource === "wallet"
              ? "submitted"
              : "unknown",
          updatedAt: Math.max(this.now(), context.createdAt),
        },
      }),
    );
    requireValue(this.read()?.transactionHash === hash);
  }
  // Called only after a finalized player proves registration exists, a verified
  // final failed receipt, or a request that never reached the wallet.
  finishRegistration(
    id: string,
    phase:
      "confirmed" | "registered" | "failed" | "not_submitted" = "not_submitted",
  ): void {
    this.finishPlayerCall(id, "register_player", phase);
  }
  finishPurchase(
    id: string,
    phase: "confirmed" | "failed" | "not_submitted" = "not_submitted",
  ): void {
    this.finishPlayerCall(id, "buy_from_merchant", phase);
  }
  private finishPlayerCall(
    id: string,
    method: PlayerMethod,
    phase: "confirmed" | "failed" | "registered" | "not_submitted",
  ): void {
    const context = this.read();
    if (context === null && this.lastTransaction()?.id === id) return;
    requireValue(context?.id === id && context.call?.method === method);
    this.settle(id, phase);
  }
  recoverHash(
    id: string,
    hash: string,
    source: "wallet" | "return" | "manual" = "manual",
  ): void {
    const context = this.read();
    requireValue(
      context?.kind === "transaction" && context.id === id && context.call,
    );
    this.recordHash(id, hash, context.call.method, source);
  }
  consumeReturn(pageUrl: string): "none" | "invalid" | "accepted" {
    const page = new URL(pageUrl);
    if (
      !["bbWalletState", "transactionHashes", "errorCode", "errorMessage"].some(
        (key) => page.searchParams.has(key),
      )
    )
      return "none";
    const context = this.read();
    if (
      !context ||
      context.kind !== "transaction" ||
      !this.returned(pageUrl) ||
      context.returnConsumed
    )
      return "invalid";
    for (const key of [
      "bbWalletState",
      "transactionHashes",
      "errorCode",
      "errorMessage",
      "account_id",
      "networkId",
      "contractId",
    ])
      if (page.searchParams.getAll(key).length > 1) return "invalid";
    if (
      (page.searchParams.has("account_id") &&
        page.searchParams.get("account_id") !== context.accountId) ||
      (page.searchParams.has("networkId") &&
        page.searchParams.get("networkId") !== context.networkId) ||
      (page.searchParams.has("contractId") &&
        page.searchParams.get("contractId") !== context.contractId)
    )
      return "invalid";
    const hash = page.searchParams.get("transactionHashes");
    if (
      hash !== null &&
      (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) ||
        (context.transactionHash && context.transactionHash !== hash))
    )
      return "invalid";
    // The nonce-only URL is the outbound page, not a completed callback.
    if (hash === null && !page.searchParams.has("errorCode")) return "none";
    if (hash) this.recoverHash(context.id, hash, "return");
    const updated = this.read();
    requireValue(updated?.id === context.id);
    this.storage.setItem(
      this.key,
      JSON.stringify({
        ...updated,
        returnConsumed: true,
        lifecycle: {
          phase:
            hash && updated.transactionSource === "wallet"
              ? "submitted"
              : "unknown",
          updatedAt: Math.max(this.now(), context.createdAt),
        },
      }),
    );
    requireValue(this.read()?.returnConsumed === true);
    return "accepted";
  }
  returned(pageUrl: string): boolean {
    const page = new URL(pageUrl);
    const context = this.read();
    return (
      !!context &&
      page.origin === this.route.origin &&
      page.pathname === this.route.pathname &&
      page.searchParams.getAll("bbWalletState").length === 1 &&
      page.searchParams.get("bbWalletState") === context.id
    );
  }
}
