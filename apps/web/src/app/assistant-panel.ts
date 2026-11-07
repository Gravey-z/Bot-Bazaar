import {
  assistantHistory,
  verifyAssistantReview,
  assistantRestockLimits,
} from "@bot-bazaar/chain";
import type {
  AssistantManualReview,
  AssistantPublicProposal,
  AssistantRestockLimits,
  AssistantAuditEntry,
} from "@bot-bazaar/chain";
import type { TownPort } from "./living-town-controller";
type Port = NonNullable<TownPort["assistant"]>;
export interface AssistantPanelState {
  signedIn: boolean;
  busy: boolean;
  mode: string;
  stale: boolean;
  message: string;
  proposals: AssistantPublicProposal[];
  review: AssistantManualReview | null;
  restock: AssistantRestockLimits | null;
  revision: string | null;
  paused: boolean | null;
  pausePolicyRevision: string | null;
  pausePending: boolean;
  pauseConfirmed: boolean;
  audit: AssistantAuditEntry[];
  automaticAuditAvailable: boolean;
}
const initial: AssistantPanelState = {
  signedIn: false,
  busy: false,
  mode: "off",
  stale: true,
  message: "",
  proposals: [],
  review: null,
  restock: null,
  revision: null,
  paused: null,
  pausePolicyRevision: null,
  pausePending: false,
  pauseConfirmed: false,
  audit: [],
  automaticAuditAvailable: false,
};
export class AssistantPanel {
  private scope: { account: string; shop: string } | null = null;
  private version = 0;
  private locallyPaused = false;
  private value: AssistantPanelState = { ...initial };
  constructor(
    private readonly port: () => Port | undefined,
    private readonly transact: (review: AssistantManualReview) => Promise<void>,
    private readonly changed: (state: AssistantPanelState) => void,
    private readonly revoke?: (account: string, shop: string) => Promise<void>,
  ) {}
  get state(): AssistantPanelState {
    return this.value;
  }
  private publish(p: Partial<AssistantPanelState>): void {
    this.value = { ...this.value, ...p };
    this.changed(this.value);
  }
  setScope(account: string | null, shop: string | null): void {
    if (account === this.scope?.account && shop === this.scope?.shop) return;
    this.port()?.logout();
    this.version++;
    this.locallyPaused = false;
    this.scope = account && shop ? { account, shop } : null;
    this.value = { ...initial };
    this.changed(this.value);
  }
  close(): void {
    this.setScope(null, null);
  }
  private history(value: unknown): void {
    const h = assistantHistory(value),
      scope = this.scope;
    if (!scope) throw new Error("No assistant scope");
    const closed = new Set(
      h.decisions
        .filter((d) => d.status !== "reviewed")
        .map((d) => d.proposal_id),
    );
    if (
      [...h.proposals, ...h.audit].some(
        (p) => p.owner_account_id !== scope.account || p.shop_id !== scope.shop,
      )
    )
      throw new Error("Assistant scope mismatch");
    this.publish({
      mode: h.mode,
      audit: h.audit,
      automaticAuditAvailable: h.automaticAuditAvailable,
      stale: h.stale,
      proposals:
        h.paused || this.locallyPaused
          ? []
          : h.proposals.filter((p) => !closed.has(p.proposal_id)),
      restock: h.restock,
      revision: h.revision,
      paused: this.locallyPaused ? true : h.paused,
      pausePolicyRevision: h.pausePolicyRevision,
      pauseConfirmed: h.paused === true,
    });
  }
  private async work(
    action: (p: Port, s: { account: string; shop: string }) => Promise<void>,
  ): Promise<void> {
    if (this.value.busy || !this.scope) return;
    const version = this.version,
      scope = this.scope,
      port = this.port();
    if (!port) return;
    this.publish({ busy: true, message: "" });
    try {
      await action(port, scope);
    } catch {
      if (version === this.version)
        this.publish({
          signedIn: false,
          proposals: [],
          audit: [],
          review: null,
          message:
            "Assistant session or recommendation is unavailable. Sign in or refresh and review the current terms.",
        });
    } finally {
      if (version === this.version) this.publish({ busy: false });
    }
  }
  async signIn(): Promise<void> {
    return this.work(async (p, s) => {
      const version = this.version;
      await p.authenticate(s.account, s.shop);
      if (version !== this.version) return;
      const history = await p.recommendations!(s.shop);
      if (version !== this.version) return;
      this.history(history);
      this.publish({ signedIn: true });
    });
  }
  async refresh(): Promise<void> {
    return this.work(async (p, s) => {
      const v = this.version;
      const h = await p.recommendations!(s.shop);
      if (v === this.version) this.history(h);
    });
  }
  async activate(): Promise<void> {
    if (this.value.paused) return;
    return this.work(async (p, s) => {
      const v = this.version;
      await p.configure!(s.shop, "recommendations");
      if (v !== this.version) return;
      const h = await p.recommendations!(s.shop);
      if (v === this.version) this.history(h);
    });
  }
  async generate(): Promise<void> {
    if (this.value.paused) return;
    return this.work(async (p, s) => {
      const v = this.version;
      const h = await p.generate!(s.shop);
      if (v === this.version) {
        this.history(h);
        this.publish({ review: null });
      }
    });
  }
  async configureRestock(value: unknown): Promise<void> {
    let limits: AssistantRestockLimits;
    try {
      limits = assistantRestockLimits(value);
    } catch {
      this.publish({
        message:
          "Use whole game-gold amounts within the displayed ranges and select permitted materials.",
      });
      return;
    }
    return this.work(async (p, s) => {
      const revision = this.value.revision;
      if (!revision || !this.value.signedIn) throw new Error("Sign in first");
      const v = this.version;
      await p.configureRestock!(s.shop, revision, limits);
      if (v !== this.version) return;
      const h = await p.recommendations!(s.shop);
      if (v === this.version) {
        this.history(h);
        this.publish({
          review: null,
          message:
            "Advisory restock limits saved. Purchases still require your wallet approval.",
        });
      }
    });
  }
  async review(id: string): Promise<void> {
    if (this.value.paused) return;
    return this.work(async (p, s) => {
      const v = this.version;
      if (
        this.value.stale ||
        !this.value.proposals.some((x) => x.proposal_id === id)
      )
        throw new Error("Suggestion unavailable");
      const r = await verifyAssistantReview(await p.review!(s.shop, id));
      if (v !== this.version) return;
      if (
        r.proposal.owner_account_id !== s.account ||
        r.proposal.shop_id !== s.shop ||
        r.proposal.proposal_id !== id
      )
        throw new Error("Review mismatch");
      this.publish({ review: r });
    });
  }
  cancelReview(): void {
    this.publish({ review: null });
  }
  async dismiss(id: string): Promise<void> {
    return this.work(async (p, s) => {
      const v = this.version;
      const h = await p.dismiss!(s.shop, id);
      if (v === this.version) {
        this.history(h);
        this.publish({ review: null });
      }
    });
  }
  async accept(): Promise<void> {
    if (this.value.paused) return;
    const review = this.value.review;
    if (!review) return;
    return this.work(async (p, s) => {
      const v = this.version;
      await this.transact(review);
      if (v !== this.version) return;
      this.publish({ review: null });
      const h = await p.recommendations!(s.shop);
      if (v === this.version) this.history(h);
    });
  }
  async pause(): Promise<void> {
    if (!this.scope || this.value.pausePending) return;
    const scope = this.scope,
      version = ++this.version,
      port = this.port();
    this.locallyPaused = true;
    this.publish({
      paused: true,
      pausePending: true,
      pauseConfirmed: false,
      busy: true,
      proposals: [],
      review: null,
      stale: true,
      message:
        "Pause requested. Worker confirmation and onchain revocation are pending.",
    });
    try {
      if (!port?.pause) throw new Error("Worker pause unavailable");
      const h = await port.pause(scope.shop);
      if (version !== this.version) return;
      this.history(h);
      if (!this.value.pauseConfirmed)
        throw new Error("Worker pause unconfirmed");
      this.publish({
        message:
          "Worker paused. Onchain revocation remains pending until finalized; already-submitted transactions may still settle.",
      });
    } catch {
      if (version !== this.version) return;
      this.publish({
        paused: true,
        signedIn: false,
        pauseConfirmed: false,
        message:
          "Worker pause could not be confirmed. Revoke onchain permission to stop independent dispatch; transactions already handed to the wallet or submitted may still settle.",
      });
    }
    try {
      if (version === this.version)
        await this.revoke?.(scope.account, scope.shop);
    } finally {
      if (version === this.version)
        this.publish({ busy: false, pausePending: false });
    }
  }
  async resume(
    mode: "recommendations" | "auto_reprice",
    policyRevision: string,
  ): Promise<void> {
    if (!this.value.paused || !this.value.signedIn || !this.value.revision)
      return;
    return this.work(async (p, s) => {
      const v = this.version,
        h = await p.resume!(s.shop, this.value.revision!, policyRevision, mode);
      if (v === this.version) {
        if (assistantHistory(h).paused !== false)
          throw new Error("Resume not confirmed");
        this.locallyPaused = false;
        this.history(h);
        this.publish({
          review: null,
          message: "Assistant resumed by explicit owner approval.",
        });
      }
    });
  }
}
