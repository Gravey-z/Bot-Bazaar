import {
  LivingTownClient,
  createRpcTransport,
  livingTownReadEnvelope,
  livingTownTown,
  canonicalLivingTownJson,
  parseLivingTownJson,
  createLivingTownCall,
} from "@bot-bazaar/chain";
import type {
  LivingTownProof,
  LivingTownIdentity,
  LivingTownCall,
} from "@bot-bazaar/chain";
import type { LivingTownProfile } from "./living-town-profile";
import type {
  TownPort,
  TownObservation,
  TownShop,
} from "./living-town-controller";
import type { WalletStorage } from "./wallet-context";
import { createWalletPort } from "./wallet-adapter";
import { LivingTownTransactions } from "./living-town-transactions";

type PortWallet = Awaited<ReturnType<typeof createWalletPort>>;
export function townTransactionUrl(
  explorer: string,
  hash: string,
): string | null {
  if (
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) ||
    new URL(explorer).origin !== "https://testnet.nearblocks.io"
  )
    return null;
  return new URL(
    `txns/${encodeURIComponent(hash)}`,
    "https://testnet.nearblocks.io/",
  ).href;
}
async function readProjection(
  url: URL,
  fetcher: typeof fetch,
): Promise<unknown> {
  const r = await fetcher(url, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok || !r.body) throw new Error("Town read unavailable");
  const reader = r.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const p = await reader.read();
    if (p.done) break;
    size += p.value.length;
    if (size > 262144) {
      await reader.cancel();
      throw new Error("Town read too large");
    }
    chunks.push(p.value);
  }
  const bytes = new Uint8Array(size);
  let i = 0;
  for (const c of chunks) {
    bytes.set(c, i);
    i += c.length;
  }
  return parseLivingTownJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
}
export function createLivingTownPort(
  profile: LivingTownProfile,
  storage: WalletStorage,
  fetcher: typeof fetch = fetch,
  loadWallet: () => Promise<PortWallet> = () =>
    createWalletPort(profile.public, storage),
): TownPort {
  const rpc = createRpcTransport(profile.public.rpcUrl, fetcher),
    client = new LivingTownClient(profile.identity, rpc);
  let wallet: Promise<PortWallet> | undefined;
  const getWallet = (): Promise<PortWallet> =>
    (wallet ??= loadWallet().catch((error) => {
      wallet = undefined;
      throw error;
    }));
  const journal = new LivingTownTransactions(
    client,
    storage,
    async (account, call) =>
      (await getWallet()).livingTown(account, call, client.identity),
  );
  const prefix = `bot-bazaar:living-town:ownership:1:${profile.identity.deployment.genesis_hash}:${profile.identity.deployment.contract_id}:`;
  const sessionProofs = new Map<string, LivingTownProof>(),
    verified = new Map<string, string>();
  const key = (account: string, shop: TownShop): string =>
    `${prefix}${account}:${shop.shop_id}:${shop.ownership_command_sequence}`;
  async function ownership(
    account: string,
    shop: TownShop,
  ): Promise<string | null> {
    const k = key(account, shop);
    if (verified.has(k)) return verified.get(k)!;
    try {
      let proof = sessionProofs.get(k);
      if (!proof) {
        const raw = storage.getItem(k);
        if (!raw || raw.length > 8192) return null;
        const parsed = parseLivingTownJson(raw) as {
          identity: LivingTownIdentity;
          proof: LivingTownProof;
        };
        if (
          !parsed ||
          Object.keys(parsed).sort().join() !== "identity,proof" ||
          canonicalLivingTownJson(parsed.identity) !==
            canonicalLivingTownJson(profile.identity)
        )
          return null;
        proof = parsed.proof;
      }
      if (
        proof.signerId !== account ||
        proof.call.method !== "create_shop" ||
        proof.call.args.command.sequence !== shop.ownership_command_sequence
      )
        return null;
      const status = await client.receipt(proof);
      if (
        status.kind !== "succeeded" ||
        status.result.data.outcome.kind !== "shop_created" ||
        status.result.data.outcome.shop.shop_id !== shop.shop_id
      )
        return null;
      const url = townTransactionUrl(
        profile.public.explorerUrl,
        proof.transactionHash,
      );
      if (url) verified.set(k, url);
      return url;
    } catch {
      return null;
    }
  }
  let unsubscribe: (() => void) | undefined;
  let changed: (() => void) | undefined;
  const initializeWallet = async (): Promise<PortWallet> => {
    const w = await getWallet();
    if (!unsubscribe && changed) unsubscribe = w.subscribe(changed);
    return w;
  };
  return {
    async accounts() {
      return (await initializeWallet()).accounts();
    },
    async connect() {
      return (await initializeWallet()).connect();
    },
    async disconnect() {
      await (await initializeWallet()).disconnect();
    },
    subscribe(callback) {
      changed = callback;
      return () => {
        unsubscribe?.();
        unsubscribe = undefined;
        changed = undefined;
      };
    },
    async read(account): Promise<TownObservation> {
      if (account === null) {
        try {
          const r = livingTownReadEnvelope(livingTownTown)(
            await readProjection(
              new URL("/api/town", profile.public.workerUrl),
              fetcher,
            ),
          );
          if (
            canonicalLivingTownJson(r.deployment) !==
              canonicalLivingTownJson(profile.identity.deployment) ||
            r.checkpoint.verified_code_hash !== profile.identity.codeHash
          )
            throw new Error("Town view identity mismatch");
          const observed = Number(r.observed_at_ms);
          if (
            !Number.isSafeInteger(observed) ||
            !Number.isFinite(new Date(observed).getTime())
          )
            throw new Error("Invalid observation time");
          return {
            accountId: null,
            town: r.snapshot.data,
            player: null,
            shop: null,
            ledger: null,
            listings: [],
            receivedAt: observed,
            stale: r.stale,
            ownershipKnown: false,
            source: "projection",
            ownershipUrl: null,
          };
        } catch {
          /* A configured spectator can also use verified finalized public chain reads. */
        }
      }
      const reader = await client.finalized(),
        town = await reader.getTown(),
        player = account ? await reader.getPlayer(account) : null;
      const listings = await reader.getListings({
        shop_id: null,
        item_id: null,
        active_only: true,
        after_id: null,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      let shop: TownShop | null = null,
        ledger = player?.data?.ledger ?? null;
      if (player?.data?.shop_id) {
        const s = await reader.getShop(player.data.shop_id);
        if (
          !s.data ||
          s.data.owner.kind !== "player" ||
          s.data.owner.account_id !== account ||
          s.market_revision !== town.market_revision
        )
          throw new Error("Shop owner mismatch");
        shop = s.data;
        const inv = await reader.getShopInventory(s.data.shop_id);
        if (inv.market_revision !== town.market_revision)
          throw new Error("Shop inventory revision mismatch");
        ledger = inv.data;
      }
      if (player && player.market_revision !== town.market_revision)
        throw new Error("Player revision mismatch");
      return {
        accountId: account,
        town: town.data,
        player: player?.data ?? null,
        shop,
        ledger,
        listings: listings.data.items,
        receivedAt: Date.now(),
        stale: false,
        ownershipKnown: account !== null,
        source: "chain",
        ownershipUrl: account && shop ? await ownership(account, shop) : null,
      };
    },
    async prepare(account, method, args) {
      const reader = await client.finalized(),
        lookup = await reader.getCommand(account, "18446744073709551615");
      const high = lookup.data.high_water;
      if (BigInt(high) === 18446744073709551615n)
        throw new Error("Command sequence exhausted");
      const sequence = (BigInt(high) + 1n).toString();
      const command = {
        sequence,
        config_version: profile.identity.deployment.config_version,
        valid_until_ns: (
          BigInt(reader.block.timestampNs) + 300_000_000_000n
        ).toString(),
      };
      return journal.prepare(account, method, { ...args, command });
    },
    submit: (id) => journal.submit(id),
    pending: () => journal.read(),
    restore: () => journal.restore(),
    recoverHash: (id, hash) => journal.recoverHash(id, hash),
    discardPrepared: (id) => journal.discardPrepared(id),
    async reconcile() {
      const attempt = await journal.read();
      const status = await journal.refresh();
      if (
        attempt &&
        status?.kind === "succeeded" &&
        status.result.data.outcome.kind === "shop_created"
      ) {
        const shop = status.result.data.outcome.shop;
        if (
          shop.owner.kind === "player" &&
          shop.owner.account_id === attempt.accountId
        ) {
          const proof: LivingTownProof = {
            transactionHash: status.transactionHash,
            signerId: attempt.accountId,
            deployment: profile.identity.deployment,
            call: createLivingTownCall(
              attempt.call.method,
              attempt.call.args,
            ) as LivingTownCall,
            referenceBlockHeight: attempt.referenceBlockHeight,
          };
          const k = key(attempt.accountId, shop);
          sessionProofs.set(k, proof);
          const url = townTransactionUrl(
            profile.public.explorerUrl,
            status.transactionHash,
          );
          if (url) verified.set(k, url);
          try {
            storage.setItem(
              k,
              JSON.stringify({ identity: profile.identity, proof }),
            );
          } catch {
            /* A verified session link remains usable if the archive cannot be saved. */
          }
        }
      }
      return status;
    },
  };
}
