import { LivingTownLiveFeed, TownActivityReset } from "./living-town-live";
import { AssistantSession } from "./assistant-session";
import { verifyAssistantReview, assistantCallMatches } from "@bot-bazaar/chain";
import type { TownLiveState } from "./living-town-live";
import {
  LivingTownClient,
  FinalizedLivingTownReader,
  createRpcTransport,
  livingTownReadEnvelope,
  livingTownTown,
  canonicalLivingTownJson,
  parseLivingTownJson,
  createLivingTownCall,
  livingTownSalesHistoryRead,
  livingTownMarketListingsRead,
} from "@bot-bazaar/chain";
import type {
  LivingTownProof,
  LivingTownIdentity,
  LivingTownCall,
  LivingTownAssistantPolicy,
  livingTownProductionJob,
} from "@bot-bazaar/chain";
import type { LivingTownProfile } from "./living-town-profile";
import type {
  TownPort,
  TownObservation,
  TownShop,
  TownShopPage,
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
  // One immutable deployment per port/document. A new profile gets a new port
  // and its own journal; outstanding work never changes signing targets.
  profile = {
    ...profile,
    public: Object.freeze({ ...profile.public }),
    identity: client.identity,
  };
  const scopedFetch =
    (signal?: AbortSignal): typeof fetch =>
    (input, init) =>
      fetcher(input, {
        ...init,
        signal: signal
          ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
          : (init?.signal ?? null),
      });
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
    undefined,
    undefined,
    async (review, account, call, attemptId, stage) => {
      const session = privateSession,
        version = privateVersion;
      if (
        !session ||
        privateAccount !== account ||
        review.owner_account_id !== account
      )
        throw new Error("Assistant sign-in and current review required");
      if (stage === "prepare") {
        const current = await verifyAssistantReview(
          await session.review(review.shop_id, review.proposal_id),
        );
        if (
          version !== privateVersion ||
          privateAccount !== account ||
          current.review_id !== review.review_id ||
          !assistantCallMatches(current, call)
        )
          throw new Error("Assistant review changed");
      } else {
        const result = (await session.accept(
          review.shop_id,
          review,
          attemptId,
          call,
        )) as { accepted?: unknown; review_id?: unknown; attempt_id?: unknown };
        if (
          !result ||
          result.accepted !== true ||
          result.review_id !== review.review_id ||
          result.attempt_id !== attemptId ||
          version !== privateVersion
        )
          throw new Error("Assistant acceptance unavailable");
      }
    },
  );
  const prefix = `bot-bazaar:living-town:ownership:1:${profile.identity.deployment.genesis_hash}:${profile.identity.deployment.contract_id}:`;
  const sessionProofs = new Map<string, LivingTownProof>(),
    verified = new Map<string, string>();
  const key = (account: string, shop: TownShop): string =>
    `${prefix}${account}:${shop.shop_id}:${shop.ownership_command_sequence}`;
  async function ownership(
    account: string,
    shop: TownShop,
    proofClient = client,
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
      const status = await proofClient.receipt(proof);
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
  async function salesPage<T>(
    path: string,
    cursor: string | null,
    decode: (v: unknown) => T,
    signal?: AbortSignal,
  ) {
    const url = new URL(path, profile.public.workerUrl);
    url.searchParams.set("limit", "20");
    if (cursor !== null) url.searchParams.set("after", cursor);
    const r = livingTownReadEnvelope(decode)(
      await readProjection(url, scopedFetch(signal)),
    );
    if (
      canonicalLivingTownJson(r.deployment) !==
        canonicalLivingTownJson(profile.identity.deployment) ||
      r.checkpoint.verified_code_hash !== profile.identity.codeHash
    )
      throw new Error("Sales view identity mismatch");
    const receivedAt = Number(r.observed_at_ms);
    if (
      !Number.isSafeInteger(receivedAt) ||
      !Number.isFinite(new Date(receivedAt).getTime())
    )
      throw new Error("Invalid sales observation time");
    return {
      data: r.snapshot.data,
      receivedAt,
      stale:
        r.stale || receivedAt > Date.now() || Date.now() - receivedAt > 30000,
      historyComplete: r.history_complete,
    };
  }
  let unsubscribe: (() => void) | undefined;
  let changed: (() => void) | undefined;
  let privateSession: AssistantSession | undefined;
  let privateAccount: string | null = null;
  let privateVersion = 0;
  const invalidatePrivate = (): void => {
    privateAccount = null;
    privateVersion++;
    privateSession?.invalidate();
  };
  const notify = (): void => {
    invalidatePrivate();
    changed?.();
  };
  const initializeWallet = async (): Promise<PortWallet> => {
    const w = await getWallet();
    if (!unsubscribe && changed) unsubscribe = w.subscribe(notify);
    return w;
  };
  let directory:
    | {
        reader: Awaited<ReturnType<LivingTownClient["finalized"]>>;
        nextId: bigint;
        upperId: bigint;
        revision: string;
        startedAt: number;
        cursor: string | null;
        sessionId: string;
      }
    | undefined;
  let directoryEpoch = 0;
  return {
    assistant: {
      async authenticate(accountId, shopId) {
        invalidatePrivate();
        const version = privateVersion;
        const w = await initializeWallet();
        const accounts = await w.accounts();
        if (
          version !== privateVersion ||
          !accounts.some((a) => a.accountId === accountId)
        )
          throw new Error("Wallet changed");
        privateAccount = accountId;
        privateSession ??= new AssistantSession(
          globalThis.location.origin,
          canonicalLivingTownJson(profile.identity),
          () => ({ accountId: privateAccount, version: privateVersion }),
          async (account, challenge) =>
            (await getWallet()).signAssistantChallenge(account, challenge),
          fetcher,
        );
        await privateSession.authenticate(shopId);
      },
      async scope(shopId) {
        const version = privateVersion;
        try {
          const w = await initializeWallet();
          const accounts = await w.accounts();
          if (version !== privateVersion) throw new Error("Wallet changed");
          if (
            !privateAccount ||
            !accounts.some((a) => a.accountId === privateAccount)
          )
            throw new Error("Wallet changed");
          if (!privateSession) throw new Error("Assistant sign-in required");
          return await privateSession.scope(shopId);
        } catch (error) {
          if (version === privateVersion) invalidatePrivate();
          throw error;
        }
      },
      logout: invalidatePrivate,
      async review(shopId, proposalId) {
        await this.scope(shopId);
        return verifyAssistantReview(
          await privateSession!.review(shopId, proposalId),
        );
      },
      async dismiss(shopId, proposalId) {
        await this.scope(shopId);
        return privateSession!.dismiss(shopId, proposalId);
      },
      async recommendations(shopId) {
        await this.scope(shopId);
        return privateSession!.recommendations(shopId);
      },
      async generate(shopId) {
        await this.scope(shopId);
        return privateSession!.generate(shopId);
      },
      async configure(shopId, mode) {
        await this.scope(shopId);
        return privateSession!.configure(shopId, mode);
      },
      async configureRestock(shopId, expectedRevision, limits) {
        await this.scope(shopId);
        return privateSession!.configureRestock(
          shopId,
          expectedRevision,
          limits,
        );
      },
    },
    ...(profile.public.workerUrl
      ? {
          watchActivity: (publish: (state: TownLiveState) => void) => {
            const stream = new LivingTownLiveFeed(
              profile.identity,
              new URL("/api/events/stream", profile.public.workerUrl).href,
              async (cursor, signal) => {
                const url = new URL("/api/events", profile.public.workerUrl);
                url.searchParams.set("limit", "50");
                if (cursor) url.searchParams.set("after", cursor);
                return readProjection(url, async (input, init) => {
                  const r = await scopedFetch(signal)(input, init);
                  if (r.status === 409 || r.status === 410)
                    throw new TownActivityReset();
                  return r;
                });
              },
              publish,
            );
            stream.start();
            return () => stream.stop();
          },
        }
      : {}),
    async market(cursor, signal) {
      const r = await salesPage(
        "/api/market/listings",
        cursor,
        livingTownMarketListingsRead,
        signal,
      );
      return {
        items: r.data.items,
        nextCursor: r.data.next_cursor,
        stale: r.stale,
        receivedAt: r.receivedAt,
      };
    },
    async history(shopId, cursor, signal) {
      const r = await salesPage(
        `/api/shops/${shopId}/history`,
        cursor,
        livingTownSalesHistoryRead,
        signal,
      );
      if (r.data.shop_id !== shopId)
        throw new Error("Sales history shop mismatch");
      return {
        shopId,
        items: r.data.items,
        costs: r.data.costs,
        nextCursor: r.data.next_cursor,
        stale: r.stale,
        receivedAt: r.receivedAt,
        historyComplete: r.historyComplete,
      };
    },
    async accounts() {
      try {
        const accounts = await (await initializeWallet()).accounts();
        if (
          privateAccount &&
          !accounts.some((a) => a.accountId === privateAccount)
        )
          invalidatePrivate();
        return accounts;
      } catch (error) {
        invalidatePrivate();
        throw error;
      }
    },
    async connect() {
      return (await initializeWallet()).connect();
    },
    async disconnect() {
      invalidatePrivate();
      await (await initializeWallet()).disconnect();
    },
    subscribe(callback) {
      changed = callback;
      const onStorage = (event: StorageEvent): void => {
        if (
          event.key === null ||
          event.key === "meteor-wallet:meteor-account-data" ||
          event.key.startsWith("bot-bazaar:living-town:journal:") ||
          event.key.startsWith("bot-bazaar:wallet:")
        )
          notify();
      };
      globalThis.window?.addEventListener("focus", callback);
      globalThis.window?.addEventListener("storage", onStorage);
      return () => {
        invalidatePrivate();
        globalThis.window?.removeEventListener("focus", callback);
        globalThis.window?.removeEventListener("storage", onStorage);
        unsubscribe?.();
        unsubscribe = undefined;
        changed = undefined;
      };
    },
    async read(account, signal): Promise<TownObservation> {
      const readFetch = scopedFetch(signal);
      const readClient = new LivingTownClient(
        profile.identity,
        createRpcTransport(profile.public.rpcUrl, readFetch),
      );
      if (account === null) {
        try {
          const r = livingTownReadEnvelope(livingTownTown)(
            await readProjection(
              new URL("/api/town", profile.public.workerUrl),
              readFetch,
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
      const reader = await readClient.finalized(),
        town = await reader.getTown(),
        player = account ? await reader.getPlayer(account) : null;
      const recipes = await reader.getRecipes({
        after_id: null,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      if (recipes.data.has_more || recipes.data.items.length !== 2)
        throw new Error("Recipe catalogue unavailable");
      const listings = await reader.getListings({
        shop_id: null,
        item_id: null,
        active_only: true,
        after_id: null,
        limit: "50",
        expected_market_revision: town.market_revision,
      });
      let ownListings:
        ReturnType<typeof livingTownMarketListingsRead>["items"] | undefined;
      let shop: TownShop | null = null,
        ledger = player?.data?.ledger ?? null;
      let assistantPolicy: LivingTownAssistantPolicy | undefined;
      const production: {
        items: ReturnType<typeof livingTownProductionJob>[];
        historyGap: boolean;
      } = { items: [], historyGap: false };
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
        if (
          (await reader.getFoundation()).data.supported_methods.includes(
            "get_assistant_policy",
          )
        ) {
          assistantPolicy = (await reader.getAssistantPolicy(shop.shop_id))
            .data;
        }
        const owned = await reader.getListings({
          shop_id: shop.shop_id,
          item_id: null,
          active_only: false,
          after_id: null,
          limit: "50",
          expected_market_revision: town.market_revision,
        });
        if (
          owned.data.has_more ||
          owned.data.items.length > 2 ||
          owned.data.items.some(
            (l) => l.owner.kind !== "player" || l.owner.account_id !== account,
          )
        )
          throw new Error("Owned listings unavailable");
        ownListings = owned.data.items;
        const inv = await reader.getShopInventory(s.data.shop_id);
        if (inv.market_revision !== town.market_revision)
          throw new Error("Shop inventory revision mismatch");
        ledger = inv.data;
        let after: string | null = null;
        for (let n = 0; n < 6; n++) {
          const page = await reader.getProductionJobs({
            shop_id: shop.shop_id,
            status: "all",
            after_id: after,
            limit: "50",
            expected_market_revision: town.market_revision,
          });
          production.items.push(...page.data.items);
          production.historyGap ||= page.data.history_gap;
          if (!page.data.has_more) break;
          if (
            n === 5 ||
            page.data.next_after_id === null ||
            BigInt(page.data.next_after_id) <= BigInt(after ?? "0")
          )
            throw new Error("Production page bound exceeded");
          after = page.data.next_after_id;
        }
      }
      if (player && player.market_revision !== town.market_revision)
        throw new Error("Player revision mismatch");
      return {
        accountId: account,
        town: town.data,
        player: player?.data ?? null,
        shop,
        ...(assistantPolicy ? { assistantPolicy } : {}),
        ...(assistantPolicy
          ? {
              assistantOperatorId: profile.identity.operatorId,
              assistantRepriceAvailable: (
                await reader.getFoundation()
              ).data.supported_methods.includes("assistant_reprice"),
            }
          : {}),
        ledger,
        listings: listings.data.items,
        ...(ownListings ? { ownListings } : {}),
        receivedAt: Date.now(),
        stale: false,
        ownershipKnown: account !== null,
        production,
        recipes: recipes.data.items.map((r) => r.recipe),
        chainTimestampNs: reader.block.timestampNs,
        source: "chain",
        ownershipUrl:
          account && shop ? await ownership(account, shop, readClient) : null,
      };
    },
    async browse(cursor, signal): Promise<TownShopPage> {
      const epoch = ++directoryEpoch;
      const browseRpc = createRpcTransport(
        profile.public.rpcUrl,
        scopedFetch(signal),
      );
      let session = directory;
      if (cursor === null) {
        const reader = await new LivingTownClient(
          profile.identity,
          browseRpc,
        ).finalized();
        const town = await reader.getTown();
        const upperId = BigInt(town.data.next_shop_id);
        if (upperId > BigInt(town.data.limits.max_players) + 4n)
          throw new Error("Shop directory capacity mismatch");
        session = {
          reader,
          nextId: 1n,
          upperId,
          revision: town.market_revision,
          startedAt: Date.now(),
          cursor: null,
          sessionId: crypto.randomUUID(),
        };
      } else if (!session || cursor !== session.cursor) {
        throw new Error("Shop directory cursor mismatch");
      }
      if (
        !session ||
        Date.now() < session.startedAt ||
        Date.now() - session.startedAt > 30000
      )
        throw new Error("Shop directory snapshot expired");
      // Reuse the admitted finalized block with a new cancellable transport.
      const reader = new FinalizedLivingTownReader(
        browseRpc,
        profile.identity,
        session.reader.block,
      );
      const end =
        session.nextId + 12n < session.upperId
          ? session.nextId + 12n
          : session.upperId;
      const ids: string[] = [];
      for (let id = session.nextId; id < end; id++) ids.push(id.toString());
      const rows = await Promise.all(ids.map((id) => reader.getShop(id)));
      if (
        signal?.aborted ||
        epoch !== directoryEpoch ||
        Date.now() < session.startedAt ||
        Date.now() - session.startedAt > 30000
      )
        throw new Error("Shop directory cancelled or expired");
      if (rows.some((row) => row.market_revision !== session.revision))
        throw new Error("Shop directory revision mismatch");
      const nextCursor =
        end < session.upperId
          ? `${session.sessionId}:${reader.block.hash}:${end}`
          : null;
      directory = { ...session, nextId: end, cursor: nextCursor };
      return {
        shops: rows.flatMap((row) =>
          row.data?.owner.kind === "player" ? [row.data] : [],
        ),
        nextCursor,
        receivedAt: session.startedAt,
      };
    },
    async prepare(account, method, args, assistantReview) {
      if (method === "complete_production")
        return journal.prepare(account, method, args);
      const reader = await client.finalized(),
        lookup = await reader.getCommand(account, "18446744073709551615");
      const high = lookup.data.high_water;
      if (BigInt(high) === 18446744073709551615n)
        throw new Error("Command sequence exhausted");
      const sequence = (BigInt(high) + 1n).toString();
      const command = {
        sequence,
        config_version: profile.identity.deployment.config_version,
        valid_until_ns: (assistantReview
          ? BigInt(assistantReview.proposal.expires_at_ns)
          : BigInt(reader.block.timestampNs) + 300_000_000_000n
        ).toString(),
      };
      return journal.prepare(
        account,
        method,
        { ...args, command },
        assistantReview,
      );
    },
    submit: (id) => journal.submit(id),
    pending: () => journal.read(),
    restore: () => journal.restore(),
    last: () => journal.last(),
    recoverHash: (id, hash) => journal.recoverHash(id, hash),
    discardPrepared: (id) => journal.discardPrepared(id),
    async reconcile() {
      const attempt = await journal.read();
      const status = await journal.refresh();
      if (
        attempt &&
        attempt.call.method !== "complete_production" &&
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
