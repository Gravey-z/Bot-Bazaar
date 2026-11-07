import {
  assistantHistory,
  verifyAssistantReview,
  assistantRestockLimits,
} from "@bot-bazaar/chain";
import type {
  AssistantManualReview,
  AssistantPublicProposal,
  AssistantRestockLimits,
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
};
export class AssistantPanel {
  private scope: { account: string; shop: string } | null = null;
  private version = 0;
  private value: AssistantPanelState = { ...initial };
  constructor(
    private readonly port: () => Port | undefined,
    private readonly transact: (review: AssistantManualReview) => Promise<void>,
    private readonly changed: (state: AssistantPanelState) => void,
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
      h.proposals.some(
        (p) => p.owner_account_id !== scope.account || p.shop_id !== scope.shop,
      )
    )
      throw new Error("Assistant scope mismatch");
    this.publish({
      mode: h.mode,
      stale: h.stale,
      proposals: h.proposals.filter((p) => !closed.has(p.proposal_id)),
      restock: h.restock,
      revision: h.revision,
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
    return this.work(async (p, s) => {
      const v = this.version;
      await p.configure!(s.shop, "recommendations");
      if (v !== this.version) return;
      const h = await p.recommendations!(s.shop);
      if (v === this.version) this.history(h);
    });
  }
  async generate(): Promise<void> {
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
}
