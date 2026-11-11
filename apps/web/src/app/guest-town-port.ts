import { LivingTownClient, canonicalLivingTownJson, createLivingTownCall,
  createLivingTownCompletionCall, guestActionRequest, guestActionMethod, playerReceiptProof,
  livingTownCommandDigest, livingTownJsonDigest } from "@bot-bazaar/chain";
import { guestActivityPage } from "@bot-bazaar/chain";
import type { GuestActivityPage } from "@bot-bazaar/chain";
import type { GuestActionRequest, LivingTownIdentity } from "@bot-bazaar/chain";
import type { LivingTownProfile } from "./living-town-profile";
import type { TownPort } from "./living-town-controller";
import type { LivingTownAttempt } from "./living-town-transactions";
import type { WalletStorage } from "./wallet-context";
import { createLivingTownPort } from "./living-town-port";
import { createTownRpc } from "./town-rpc";

export interface GuestUiState {
  mode: "wallet" | "guest";
  status: "idle" | "provisioning" | "active" | "failed" | "unavailable";
  accountId: string | null;
  displayId?: string | null;
  registrationObserved?: boolean;
  message: string;
  activity?: GuestActivityPage | null;
  activityLoading?: boolean;
  activityError?: string;
}
interface PublicAction {
  requestId: string; request: GuestActionRequest;
  status: "queued" | "signed" | "unknown" | "confirmed" | "failed";
  proof: unknown; result: unknown; error: string | null; transactionHash: string | null;
}
interface GuestRecord {
  guestId: string; accountId: string; status: "provisioning" | "active" | "failed" | "blocked";
  registrationObserved?: boolean;
  pendingAction: PublicAction | null;
}
interface SavedGuestAttempt { attempt: LivingTownAttempt; request: GuestActionRequest; }
interface Journal { identity: LivingTownIdentity; pending: SavedGuestAttempt | null; last: LivingTownAttempt | null; }
type PlayerMode = "wallet" | "guest" | "disconnected";

export function createPlayerTownPort(profile: LivingTownProfile, storage: WalletStorage,
  update: (state: GuestUiState) => void, fetcher: typeof fetch = fetch): TownPort {
  const wallet = createLivingTownPort(profile, storage, fetcher);
  const client = new LivingTownClient(profile.identity, createTownRpc(profile.public.rpcUrl, fetcher));
  const prefix = `bot-bazaar:guest:${profile.identity.deployment.genesis_hash}:${profile.identity.deployment.contract_id}:${profile.identity.codeHash}`;
  let mode: PlayerMode = "wallet";
  try {
    const saved = storage.getItem(prefix + ":mode");
    if (saved === "guest" || saved === "disconnected") mode = saved;
  }
  catch { /* Browsing and the existing wallet error handling remain available. */ }
  let guest: GuestRecord | null = null, csrf = "", changed: ((reason?: "focus" | "wallet") => void) | undefined;
  let restoring: Promise<void> | undefined;
  let restoredAt = 0, apiRetryAt = 0, lastActivityAt = 0;
  let activity: GuestActivityPage | null = null, activityLoading = false, activityError = "", activityEpoch = 0;
  const emit = (message = "", unavailable = false) => update({ mode: mode === "guest" ? "guest" : "wallet",
    status: mode !== "guest" ? "idle" : unavailable ? "unavailable" : !guest ? "idle" : guest.status === "blocked" ? "failed" : guest.status,
    accountId: mode === "guest" ? guest?.accountId ?? null : null, message: mode === "guest" ? message : "",
    displayId: mode === "guest" && guest ? `Guest-${guest.accountId.split(".")[0]!.replace(/^g-/, "").slice(0, 6)}` : null,
    registrationObserved: mode === "guest" && guest?.registrationObserved === true,
    activity: mode === "guest" ? activity : null, activityLoading: mode === "guest" && activityLoading,
    activityError: mode === "guest" ? activityError : "" });
  const journalKey = () => `${prefix}:journal:${guest?.guestId ?? "unresolved"}`;
  function load(): Journal {
    const raw = storage.getItem(journalKey());
    if (!raw) return { identity: profile.identity, pending: null, last: null };
    if (raw.length > 32768) throw new Error("Guest request journal unavailable");
    const value = JSON.parse(raw) as Journal;
    if (canonicalLivingTownJson(value.identity) !== canonicalLivingTownJson(profile.identity)) throw new Error("Guest deployment changed");
    if (value.pending) {
      const request = guestActionRequest(value.pending.request), a = value.pending.attempt;
      if (a.id !== request.requestId || guestActionMethod(request.action) !== a.call.method)
        throw new Error("Guest request journal changed");
      if (guest && a.accountId !== guest.accountId) throw new Error("Original guest identity required");
    }
    return value;
  }
  function save(journal: Journal): void {
    const body = JSON.stringify(journal); if (body.length > 32768) throw new Error("Guest journal capacity");
    storage.setItem(journalKey(), body);
    if (storage.getItem(journalKey()) !== body) throw new Error("Guest journal unavailable");
  }
  async function api(path: string, body?: unknown, expectedGuestId?: string): Promise<Record<string, unknown>> {
    if (Date.now() < apiRetryAt) throw new Error("Guest service is cooling down after a rate limit. Your session and original request are retained; try again shortly.");
    const response = await fetcher(`/api/guest/${path}`, { method: body === undefined ? "GET" : "POST",
      credentials: "include", cache: "no-store", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Guest-CSRF": csrf }),
        ...(expectedGuestId ? { "X-Guest-Id": expectedGuestId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      apiRetryAt = Date.now() + Math.min(300000, Math.max(15000, Number.isFinite(seconds) ? seconds * 1000 : 15000));
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      await response.body?.cancel();
      throw new Error("Guest API is not available at this address. Configure the guest backend and the web server's GUEST_API_URL, then restart the web server.");
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error("Guest service unavailable");
    let text = "";
    try {
      const decoder = new TextDecoder();
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true });
        if (text.length > 262144) throw new Error("Guest response too large"); }
    } finally { await reader.cancel(); }
    const result = JSON.parse(text) as Record<string, unknown>;
    if (!response.ok) {
      const messages: Record<string, string> = {
        guest_session_required: "Your guest session could not be restored. Start guest mode again.",
        guest_session_changed: "Your guest session changed. Restore the original session before retrying this request.",
        guest_original_action_pending: "Another guest action is pending. Check its original request.",
        guest_funding_cap: "Guest creation is temporarily full. Try again later.",
        guest_creation_quota: "Guest creation is temporarily limited. Try again later.",
        guest_action_limit: "This guest has reached its action allowance.",
        guest_rate_limited: "Guest requests are temporarily limited. Wait a moment before checking again.",
        guest_service_unavailable: "Guest backend is unreachable. Check that the configured guest service is running and GUEST_API_URL points to it.",
        guest_not_configured: "Guest play needs one-time setup: data/living-town-guest.local.json with a dedicated funded Testnet parent and custody keys. After setup, restart dev:web.",
        guest_request_id_conflict: "Saved guest request details do not match. Keep the original request.",
      };
      throw new Error(messages[String(result["error"])] ?? "Guest service unavailable. Your original request has been retained.");
    }
    return result;
  }
  async function attemptFrom(action: PublicAction): Promise<LivingTownAttempt> {
    const request = guestActionRequest(action.request), method = guestActionMethod(request.action);
    let call = method === "complete_production" ? createLivingTownCompletionCall(request.parameters)
      : createLivingTownCall(method, { ...request.parameters, command: { sequence: "1",
        config_version: profile.identity.deployment.config_version, valid_until_ns: request.validUntilNs } });
    let referenceBlockHeight = "1";
    if (action.proof) {
      const proof = playerReceiptProof(action.proof);
      if (proof.signerId !== guest?.accountId || canonicalLivingTownJson(proof.deployment) !== canonicalLivingTownJson(profile.identity.deployment))
        throw new Error("Guest receipt identity mismatch");
      call = proof.call; referenceBlockHeight = proof.referenceBlockHeight;
    }
    const accountId = guest!.accountId;
    return { id: request.requestId, accountId, call, referenceBlockHeight,
      digest: call.method === "complete_production" ? await livingTownJsonDigest(call)
        : await livingTownCommandDigest(profile.identity.deployment, accountId, call),
      phase: "unknown", transactionHash: action.transactionHash, hashSource: action.transactionHash ? "wallet" : null };
  }
  async function restoreGuest(force = false): Promise<void> {
    if (restoring) return restoring;
    if (!force && csrf && Date.now() - restoredAt < 5000) return;
    restoring = (async () => {
      const previous = guest?.status + ":" + guest?.accountId;
      const previousGuest = guest?.guestId;
      try {
        const result = await api("me");
        if (canonicalLivingTownJson(result["identity"]) !== canonicalLivingTownJson(profile.identity)) throw new Error("Guest deployment mismatch");
        if (typeof result["csrfToken"] !== "string" || !/^[a-f0-9]{64}$/.test(result["csrfToken"])) throw new Error("Guest session unavailable");
        csrf = result["csrfToken"];
        restoredAt = Date.now();
        guest = (result["guest"] ?? null) as GuestRecord | null;
        if (previousGuest !== guest?.guestId) { activity = null; activityError = ""; activityEpoch++; activityLoading = false; }
        if (guest && (!/^[a-z0-9_.-]+\.testnet$/.test(guest.accountId) || guest.accountId.length > 64)) throw new Error("Invalid guest identity");
        const journal = load(); let adopted = false;
        if (guest?.pendingAction && !journal.pending) {
          save({ ...journal, pending: { attempt: await attemptFrom(guest.pendingAction), request: guestActionRequest(guest.pendingAction.request) } });
          adopted = true;
        }
        emit(guest?.status === "provisioning" ? "Creating your guest account…" : "Guest progress is temporary. Keep this browser session.");
        if (previous !== guest?.status + ":" + guest?.accountId || adopted) changed?.("wallet");
      } catch (error) {
        restoredAt = 0; activityEpoch++; activityLoading = false;
        emit(error instanceof Error ? error.message : "Guest service unavailable. Your saved request has been retained.", true); throw error;
      }
    })().finally(() => { restoring = undefined; });
    return restoring;
  }
  function setMode(value: PlayerMode): void { storage.setItem(prefix + ":mode", value); mode = value; activityEpoch++; activityLoading = false; emit(); }
  async function refreshActivity(more = false, automatic = false): Promise<void> {
    if (automatic && Date.now() - lastActivityAt < 15000) return;
    if (mode !== "guest" || !guest || activityLoading || (more && !activity?.nextBefore)) return;
    const epoch = ++activityEpoch, id = guest.guestId, account = guest.accountId;
    const before = more ? activity!.nextBefore : null;
    activityLoading = true; activityError = ""; emit();
    lastActivityAt = Date.now();
    try {
      const response = await api(`activity${before ? `?before=${before}` : ""}`, undefined, id);
      const page = guestActivityPage(response["activity"]);
      if (mode !== "guest" || guest?.guestId !== id || epoch !== activityEpoch) return;
      if (page.accountId !== account || page.items.some(row => row.accountId !== account ||
        (row.status === "confirmed" && !row.verified) || (row.verified && (!row.transactionHash || !row.blockHeight))))
        throw new Error("Guest activity identity or evidence mismatch");
      const old = activity;
      const entries = new Map((old?.items ?? []).map(row => [row.requestId, row]));
      for (const row of page.items) entries.set(row.requestId, row);
      const items = [...entries.values()].sort((a, b) => BigInt(a.cursor) > BigInt(b.cursor) ? -1 : 1).slice(0, 100);
      activity = { ...page, items, nextBefore: more ? page.nextBefore : old && old.items.length > 10 ? old.nextBefore : page.nextBefore };
    } catch {
      if (epoch === activityEpoch) activityError = "Guest activity could not be refreshed. Retained entries may be out of date.";
    } finally {
      if (epoch === activityEpoch) { activityLoading = false; emit(); }
    }
  }
  async function submitGuest(id: string): Promise<void> {
    await restoreGuest();
    if (mode !== "guest") throw new Error("Guest mode changed; original request retained");
    const journal = load(), pending = journal.pending;
    if (!pending || pending.attempt.id !== id || pending.attempt.accountId !== guest?.accountId) throw new Error("Original guest request required");
    const expectedGuestId = guest!.guestId;
    // Persist the HTTP handoff boundary before dispatch. Lost responses are
    // recovered by this exact request ID, never by preparing another action.
    save({ ...journal, pending: { ...pending, attempt: { ...pending.attempt, phase: "unknown" } } });
    const result = await api("actions", pending.request, expectedGuestId), action = result["action"] as PublicAction;
    if (guest?.guestId !== expectedGuestId || mode !== "guest") throw new Error("Guest session changed; original request retained");
    const latest = load();
    if (latest.pending?.attempt.id === id) save({ ...latest, pending: { request: pending.request, attempt: await attemptFrom(action) } });
  }
  emit();
  const port: TownPort = {
    ...wallet,
    ...(wallet.assistant ? { assistant: { ...wallet.assistant, authenticate: async (account: string, shop: string) => {
      if (mode === "guest") throw new Error("Connect your own wallet to use the private assistant");
      await wallet.assistant!.authenticate(account, shop);
    } } } : {}),
    guest: {
      isGuest: () => mode === "guest",
      async start() {
        // Wallet and guest requests have separate journals and signers. Switching
        // modes retains the wallet's original request for a later reconnect.
        setMode("guest"); await restoreGuest(true);
        if (mode !== "guest") throw new Error("Guest mode changed");
        if (!guest) { await api("start", {}); await restoreGuest(true); }
      },
      async retry() { const pending = load().pending; if (pending) await submitGuest(pending.attempt.id); },
      refreshActivity,
    },
    async accounts() {
      if (mode === "disconnected") return [];
      if (mode !== "guest") return wallet.accounts();
      await restoreGuest(); return guest?.status === "active" ? [{ accountId: guest.accountId }] : [];
    },
    async connect() {
      // Keep guest requests in their own journal while explicitly switching to
      // a wallet. This never re-signs or abandons the server's original work.
      setMode("wallet"); return wallet.connect();
    },
    async disconnect() {
      if (mode === "disconnected") return;
      if (mode !== "guest") return wallet.disconnect();
      if (load().pending) throw new Error("Resolve your guest request before disconnecting");
      // Keep the HttpOnly session cookie and request journal for reconnection.
      // Only the visible connection mode is stored in browser-readable storage.
      setMode("disconnected");
    },
    subscribe(callback) {
      changed = callback;
      const stop = wallet.subscribe(reason => { if (mode === "wallet" || reason === "focus") callback(reason); });
      const storageChanged = (event: StorageEvent) => {
        if (event.key === prefix + ":mode") {
          const saved = storage.getItem(prefix + ":mode");
          mode = saved === "guest" || saved === "disconnected" ? saved : "wallet";
          emit(); callback("wallet");
        } else if (mode === "guest" && event.key?.startsWith(prefix + ":journal:")) callback("focus");
      };
      window.addEventListener("storage", storageChanged);
      return () => { changed = undefined; stop(); window.removeEventListener("storage", storageChanged); };
    },
    async read(account, signal) {
      if (mode === "guest") { await restoreGuest(); void refreshActivity(false, true); }
      return wallet.read(account, signal);
    },
    async prepare(account, method, args, review) {
      if (mode === "disconnected") throw new Error("Connect a player before preparing an action");
      if (mode !== "guest") return wallet.prepare(account, method, args, review);
      if (review || method === "set_assistant_permissions") throw new Error("Guest assistant actions are unavailable");
      await restoreGuest();
      if (guest?.status !== "active" || guest.accountId !== account || load().pending) throw new Error("Guest not ready");
      const reader = await client.finalized();
      if (guest?.accountId !== account || mode !== "guest") throw new Error("Guest session changed");
      const request = guestActionRequest({ requestId: crypto.randomUUID(), action: method === "buy_from_merchant" ? "buy_item" : method,
        parameters: args, validUntilNs: (BigInt(reader.block.timestampNs) + 300_000_000_000n).toString() });
      const fake: PublicAction = { requestId: request.requestId, request, status: "queued", proof: null, result: null, error: null, transactionHash: null };
      const attempt = { ...await attemptFrom(fake), phase: "prepared" as const };
      save({ ...load(), pending: { attempt, request } }); return attempt;
    },
    async submit(id) { if (mode === "disconnected") throw new Error("Reconnect the original player before submitting"); if (mode === "guest") await submitGuest(id); else await wallet.submit(id); },
    async pending() { return mode === "disconnected" ? null : mode === "guest" ? load().pending?.attempt ?? null : wallet.pending(); },
    async restore() { if (mode === "disconnected") return null; if (mode !== "guest") return wallet.restore(); await restoreGuest(); return load().pending?.attempt ?? null; },
    async last() { return mode === "disconnected" ? null : mode === "guest" ? load().last : (await wallet.last?.()) ?? null; },
    async reconcile() {
      if (mode === "disconnected") return null;
      if (mode !== "guest") return wallet.reconcile();
      await restoreGuest(); const journal = load(), pending = journal.pending;
      if (!pending || pending.attempt.phase === "prepared") return null;
      if (pending.attempt.accountId !== guest?.accountId) throw new Error("Original guest session required");
      const expectedGuestId = guest!.guestId;
      const response = await api(`actions/${pending.attempt.id}`, undefined, expectedGuestId), action = response["action"] as PublicAction;
      if (guest?.guestId !== expectedGuestId || mode !== "guest") throw new Error("Guest session changed");
      const attempt = await attemptFrom(action);
      if (action.status === "failed" && action.error === "guest_registration_expired" &&
        attempt.call.method === "register_player") {
        save({ ...journal, pending: null, last: { ...attempt, phase: "failed" } });
        emit("Your earlier registration expired. Guest setup will prepare a fresh registration.");
        return null;
      }
      if (action.status === "failed" && !action.proof) {
        save({ ...journal, pending: null, last: { ...attempt, phase: "not_submitted" } });
        emit(action.error === "guest_review_expired" ? "Your review expired. Review the current terms again."
          : "Guest action was not submitted. Refresh the current shop and review again."); return null;
      }
      save({ ...journal, pending: { ...pending, attempt } });
      if (!action.proof) return null;
      const proof = playerReceiptProof(action.proof);
      const status = proof.call.method === "complete_production" ? await client.completionReceipt({ ...proof, call: proof.call })
        : await client.receipt({ ...proof, call: proof.call });
      if (guest?.guestId !== expectedGuestId || mode !== "guest") throw new Error("Guest session changed");
      if (status.kind === "succeeded" && proof.call.method === "create_shop" && status.result.data.outcome.kind === "shop_created") {
        const shop = status.result.data.outcome.shop;
        if (shop.owner.kind === "player" && shop.owner.account_id === pending.attempt.accountId) {
          storage.setItem(`bot-bazaar:living-town:ownership:1:${profile.identity.deployment.genesis_hash}:${profile.identity.deployment.contract_id}:${pending.attempt.accountId}:${shop.shop_id}:${shop.ownership_command_sequence}`,
            JSON.stringify({ identity: profile.identity, proof }));
        }
      }
      if (status.kind === "succeeded" || status.kind === "failed")
        save({ ...load(), pending: null, last: { ...attempt, phase: status.kind === "succeeded" ? "confirmed" : "failed" } });
      return status;
    },
    async retryRegistration(id) { if (mode === "guest") await submitGuest(id); else await wallet.retryRegistration?.(id); },
    async recoverHash(id, hash) { if (mode === "guest") throw new Error("Guest hashes are recovered by the server"); await wallet.recoverHash(id, hash); },
    async discardPrepared(id) {
      if (mode !== "guest") return wallet.discardPrepared(id);
      const journal = load();
      if (journal.pending?.attempt.id !== id || journal.pending.attempt.phase !== "prepared") throw new Error("Guest request already handed off");
      save({ ...journal, pending: null, last: { ...journal.pending.attempt, phase: "not_submitted" } });
    },
  };
  return port;
}
