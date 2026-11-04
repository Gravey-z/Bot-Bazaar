import { createMarketCall } from "@bot-bazaar/chain";
import type { PublicConfig } from "@bot-bazaar/shared";

export type PlayerMethod = "register_player" | "buy_from_merchant";
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
    requireValue(raw.length <= 4096);
    const value = JSON.parse(raw) as WalletContext;
    requireValue(
      value &&
        [
          "accountId,call,contractId,createdAt,id,kind,networkId,returnUrl,version",
          "accountId,call,contractId,createdAt,id,kind,networkId,returnUrl,transactionHash,version",
        ].includes(Object.keys(value).sort().join()),
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
          value.transactionHash === undefined,
      );
    else {
      requireValue(
        value.kind === "transaction" &&
          isTestnetAccount(value.accountId) &&
          value.call &&
          Object.keys(value.call).sort().join() === "args,method" &&
          ["register_player", "buy_from_merchant"].includes(value.call.method),
      );
      createMarketCall(value.call.method, value.call.args);
      requireValue(
        value.transactionHash === undefined ||
          (typeof value.transactionHash === "string" &&
            /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.transactionHash)),
      );
    }
    return value;
  }
  beginConnect(): WalletContext {
    return this.save("connect", null, null);
  }
  prepareTransaction(
    accountId: string,
    method: PlayerMethod,
    args: unknown,
  ): WalletContext {
    requireValue(
      isTestnetAccount(accountId) &&
        ["register_player", "buy_from_merchant"].includes(method),
    );
    const call = createMarketCall(method, args);
    return this.save("transaction", accountId, { method, args: call.args });
  }
  private save(
    kind: WalletContext["kind"],
    accountId: string | null,
    call: WalletContext["call"],
  ): WalletContext {
    requireValue(this.config.networkId === "testnet" && !this.read());
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
  private recordHash(id: string, hash: string, method: PlayerMethod): void {
    const context = this.read();
    requireValue(
      context?.id === id &&
        context.call?.method === method &&
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) &&
        (!context.transactionHash || context.transactionHash === hash),
    );
    this.storage.setItem(
      this.key,
      JSON.stringify({ ...context, transactionHash: hash }),
    );
    requireValue(this.read()?.transactionHash === hash);
  }
  // Called only after a finalized player proves registration exists, a verified
  // final failed receipt, or a request that never reached the wallet.
  finishRegistration(id: string): void {
    this.finishPlayerCall(id, "register_player");
  }
  finishPurchase(id: string): void {
    this.finishPlayerCall(id, "buy_from_merchant");
  }
  private finishPlayerCall(id: string, method: PlayerMethod): void {
    const context = this.read();
    requireValue(context?.id === id && context.call?.method === method);
    this.storage.removeItem(this.key);
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
