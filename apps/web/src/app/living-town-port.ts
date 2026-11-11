import { LivingTownLiveFeed, TownActivityReset } from "./living-town-live";
import { WalletConnectionError } from "./transaction-errors";
import { AssistantSession } from "./assistant-session";
import { verifyAssistantReview, assistantCallMatches } from "@bot-bazaar/chain";
import type { TownLiveState } from "./living-town-live";
import {
  LivingTownClient,
  livingTownReadEnvelope,
  livingTownTown,
  canonicalLivingTownJson,
  parseLivingTownJson,
  createLivingTownCall,
  livingTownSalesHistoryRead,
  livingTownMarketListingsRead,
  livingTownOffer,
  livingTownGameView,
  livingTownShopDirectory,
} from "@bot-bazaar/chain";
import type {
  LivingTownProof,
  LivingTownCall,
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
import { createTownRpc } from "./town-rpc";

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
  const rpc = createTownRpc(profile.public.rpcUrl, fetcher),
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
  const handoffReceipts = receiptHandoff(
    journal,
    profile.public.workerUrl,
    fetcher,
  );
  async function syncAssistantAudit(): Promise<void> {
    const session = privateSession,
      account = privateAccount;
    if (!session || !account) return;
    for (const a of [await journal.read(), await journal.last()]) {
      if (
        !a?.assistant_review ||
        !a.transactionHash ||
        a.accountId !== account ||
        session !== privateSession ||
        account !== privateAccount
      )
        continue;
      try {
        await session.outcome(
          a.assistant_review.shop_id,
          a.assistant_review.proposal_id,
          a.id,
          a.transactionHash,
          a.referenceBlockHeight,
        );
      } catch {
        /* Retain the original wallet journal; a later owner refresh retries proof lookup. */
      }
    }
  }
  const verified = new Map<string, string>();
  const key = (account: string, shop: TownShop): string =>
    `${prefix}${account}:${shop.shop_id}:${shop.ownership_command_sequence}`;
  function ownership(account: string, shop: TownShop): string | null {
    return verified.get(key(account, shop)) ?? null;
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
  let changed: ((reason?: "focus" | "wallet") => void) | undefined;
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
    changed?.("wallet");
  };
  const initializeWallet = async (): Promise<PortWallet> => {
    const w = await getWallet();
    if (!unsubscribe && changed) unsubscribe = w.subscribe(notify);
    return w;
  };

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
        await syncAssistantAudit();
        return privateSession!.recommendations(shopId);
      },
      async generate(shopId) {
        await this.scope(shopId);
        return privateSession!.generate(shopId);
      },
      async pause(shopId) {
        await this.scope(shopId);
        return privateSession!.pause(shopId);
      },
      async resume(shopId, expectedRevision, policyRevision, mode) {
        await this.scope(shopId);
        return privateSession!.resume(
          shopId,
          expectedRevision,
          policyRevision,
          mode,
        );
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
      let wallet;
      try {
        wallet = await initializeWallet();
      } catch {
        throw new WalletConnectionError("setup");
      }
      return wallet.connect();
    },
    async disconnect() {
      invalidatePrivate();
      await (await initializeWallet()).disconnect();
    },
    subscribe(callback) {
      changed = callback;
      const onFocus = (): void => changed?.("focus");
      const onStorage = (event: StorageEvent): void => {
        if (
          event.key === null ||
          event.key === "meteor-wallet:meteor-account-data" ||
          event.key.startsWith("bot-bazaar:wallet:")
        )
          notify();
        else if (event.key.startsWith("bot-bazaar:living-town:journal:"))
          changed?.("focus");
      };
      globalThis.window?.addEventListener("focus", onFocus);
      globalThis.window?.addEventListener("storage", onStorage);
      return () => {
        invalidatePrivate();
        globalThis.window?.removeEventListener("focus", onFocus);
        globalThis.window?.removeEventListener("storage", onStorage);
        unsubscribe?.();
        unsubscribe = undefined;
        changed = undefined;
      };
    },
    async read(account, signal): Promise<TownObservation> {
      void handoffReceipts();
      const readFetch = scopedFetch(signal);
      if (account !== null) {
        const url = new URL("/api/game-view", profile.public.workerUrl);
        url.searchParams.set("account", account);
        const envelope = livingTownReadEnvelope(livingTownGameView)(await readProjection(url, readFetch));
        if (canonicalLivingTownJson(envelope.deployment) !== canonicalLivingTownJson(profile.identity.deployment) ||
          envelope.checkpoint.verified_code_hash !== profile.identity.codeHash ||
          envelope.snapshot.data.account !== account)
          throw new Error("Player view identity mismatch");
        const view = envelope.snapshot.data;
        const observed = Number(envelope.observed_at_ms);
        if (!Number.isSafeInteger(observed)) throw new Error("Invalid view observation time");
        return {
          accountId: account, town: view.town, player: view.player, shop: view.shop,
          ledger: view.ledger, listings: view.listings, ownListings: view.ownListings,
          production: view.production, recipes: view.recipes,
          merchantOffers: { available: true, items: view.offers,
            stale: envelope.stale, historyGap: view.offersHistoryGap },
          ...(view.upgrade ? { upgrade: view.upgrade } : {}),
          ...(view.assistantPolicy ? { assistantPolicy: view.assistantPolicy,
            assistantOperatorId: profile.identity.operatorId,
            assistantRepriceAvailable: view.assistantRepriceAvailable } : {}),
          chainTimestampNs: envelope.snapshot.block_timestamp_ns,
          receivedAt: observed, stale: envelope.stale || observed > Date.now() ||
            Date.now() - observed > 30000 ||
            Math.abs(Date.now() - Number(BigInt(envelope.snapshot.block_timestamp_ns) / 1000000n)) > 30000,
          ownershipKnown: true, source: "projection", ownershipUrl: view.shop ? ownership(account, view.shop) : null,
        };
      }
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
          // The town projection contains no stock. Read the actual listings from
          // the same checkpoint instead of treating missing stock as an empty shop.
          const listings: TownObservation["listings"] = [];
          const seen = new Set<string>();
          let cursor: string | null = null;
          let receivedAt = observed;
          let stale = r.stale;
          do {
            const url = new URL(
              "/api/market/listings",
              profile.public.workerUrl,
            );
            url.searchParams.set("limit", "50");
            if (cursor) url.searchParams.set("after", cursor);
            const page = livingTownReadEnvelope(livingTownMarketListingsRead)(
              await readProjection(url, readFetch),
            );
            if (
              canonicalLivingTownJson(page.deployment) !==
                canonicalLivingTownJson(r.deployment) ||
              canonicalLivingTownJson(page.checkpoint) !==
                canonicalLivingTownJson(r.checkpoint)
            )
              throw new Error("Town stock snapshot changed");
            const pageTime = Number(page.observed_at_ms);
            if (
              !Number.isSafeInteger(pageTime) ||
              !Number.isFinite(new Date(pageTime).getTime())
            )
              throw new Error("Invalid stock observation time");
            stale ||= page.stale || pageTime > Date.now();
            receivedAt = Math.min(receivedAt, pageTime);
            for (const listing of page.snapshot.data.items) {
              if (seen.has(listing.listing_id) || seen.size >= 2018)
                throw new Error("Invalid stock pagination");
              seen.add(listing.listing_id);
              if (listing.active && BigInt(listing.remaining_quantity) > 0n)
                listings.push(listing);
            }
            cursor = page.snapshot.data.next_cursor;
            if (page.snapshot.data.has_more !== (cursor !== null))
              throw new Error("Invalid stock cursor");
            if (cursor && page.snapshot.data.items.length === 0)
              throw new Error("Empty stock page with cursor");
          } while (cursor);
          let merchantOffers: TownObservation["merchantOffers"] = {
            available: false,
            items: [],
            stale: true,
            historyGap: false,
          };
          if (profile.identity.deployment.state_schema === "2")
            try {
              const page = livingTownReadEnvelope((v: unknown) => {
                if (!Array.isArray(v) || v.length > 140)
                  throw Error("Offer bound");
                return v.map(livingTownOffer);
              })(
                await readProjection(
                  new URL("/api/merchant-offers", profile.public.workerUrl),
                  readFetch,
                ),
              );
              if (
                canonicalLivingTownJson(page.deployment) !==
                  canonicalLivingTownJson(r.deployment) ||
                canonicalLivingTownJson(page.checkpoint) !==
                  canonicalLivingTownJson(r.checkpoint)
              )
                throw Error("Offer snapshot changed");
              const observed = Number(page.observed_at_ms);
              merchantOffers = {
                available: true,
                items: page.snapshot.data,
                stale:
                  page.stale ||
                  !page.history_complete ||
                  !Number.isFinite(observed) ||
                  observed > Date.now() ||
                  Date.now() - observed > 30000,
                historyGap: !page.history_complete,
              };
            } catch {
              /* Keep independently verified stock readable while offer reads are unavailable. */
            }
          return {
            accountId: null,
            town: r.snapshot.data,
            player: null,
            shop: null,
            ledger: null,
            listings,
            merchantOffers,
            chainTimestampNs: r.snapshot.block_timestamp_ns,
            receivedAt,
            stale:
              stale ||
              receivedAt > Date.now() ||
              Date.now() - receivedAt > 30000,
            ownershipKnown: false,
            source: "projection",
            ownershipUrl: null,
          };
        } catch {
          throw new Error("Town reader unavailable");
        }
      }
      throw new Error("Town reader unavailable");
    },
    async browse(cursor, signal): Promise<TownShopPage> {
      if (profile.public.workerUrl) {
        const url = new URL("/api/shops", profile.public.workerUrl);
        url.searchParams.set("limit", "12");
        if (cursor) url.searchParams.set("after", cursor);
        const page = livingTownReadEnvelope(livingTownShopDirectory)(await readProjection(url, scopedFetch(signal)));
        if (canonicalLivingTownJson(page.deployment) !== canonicalLivingTownJson(profile.identity.deployment) ||
          page.checkpoint.verified_code_hash !== profile.identity.codeHash || page.stale)
          throw new Error("Shop directory unavailable");
        return { shops: page.snapshot.data.shops, nextCursor: page.snapshot.data.next_cursor,
          receivedAt: Number(page.observed_at_ms) };
      }
      throw new Error("Shop directory reader unavailable");
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
    async submit(id) {
      await journal.submit(id);
      await handoffReceipts();
      await syncAssistantAudit();
    },
    retryRegistration: (id) => journal.retryRegistration(id),
    pending: () => journal.read(),
    restore: () => journal.restore(),
    last: () => journal.last(),
    async recoverHash(id, hash) {
      await journal.recoverHash(id, hash);
      await handoffReceipts();
    },
    discardPrepared: (id) => journal.discardPrepared(id),
    async reconcile() {
      const attempt = await journal.read();
      const status = await journal.refresh();
      void handoffReceipts();
      await syncAssistantAudit();
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
import { receiptHandoff } from "./living-town-receipt-handoff";
