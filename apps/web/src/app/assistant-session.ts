export interface AssistantChallenge {
  id: string;
  accountId: string;
  shopId: string;
  message: string;
  recipient: string;
  nonce: string;
  expiresAt: number;
}
interface Session {
  token: string;
  accountId: string;
  shopId: string;
  expiresAt: number;
}
interface Identity {
  accountId: string | null;
  version: number;
}

/** Memory only. Owner UI must notify on account/network/logout changes. */
export class AssistantSession {
  private session: Session | null = null;
  private generation = 0;
  private pending = false;
  private sessionVersion = -1;
  constructor(
    private readonly origin: string,
    private readonly deployment: string,
    private readonly identity: () => Identity,
    private readonly sign: (
      account: string,
      challenge: AssistantChallenge,
    ) => Promise<{
      accountId: string;
      publicKey: string;
      signature: string;
    }>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error("Invalid assistant origin");
  }
  private async request(
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<unknown> {
    const response = await this.fetcher(
      new URL(`/private/assistant/${path}`, this.origin),
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok) throw new Error("Assistant session unavailable");
    if (!response.body) throw new Error("Invalid assistant response");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("Invalid assistant response");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  }
  invalidate(): void {
    const old = this.session;
    this.session = null;
    this.generation++;
    if (old) void this.request("logout", {}, old.token).catch(() => {});
  }
  async authenticate(shopId: string): Promise<void> {
    if (this.pending) throw new Error("Assistant sign-in pending");
    this.invalidate();
    this.pending = true;
    const initial = this.identity(),
      generation = this.generation;
    const current = (): boolean =>
      generation === this.generation &&
      initial.accountId === this.identity().accountId &&
      initial.version === this.identity().version;
    try {
      if (!initial.accountId) throw new Error("Wallet required");
      const c = (await this.request("challenge", {
        accountId: initial.accountId,
        shopId,
      })) as AssistantChallenge;
      if (
        !current() ||
        !c ||
        typeof c !== "object" ||
        typeof c.id !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(c.id) ||
        c.accountId !== initial.accountId ||
        c.shopId !== shopId ||
        c.recipient !== this.origin ||
        typeof c.message !== "string" ||
        c.message.length > 4096 ||
        typeof c.nonce !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(c.nonce) ||
        !Number.isSafeInteger(c.expiresAt) ||
        c.expiresAt <= Date.now()
      )
        throw new Error("Invalid assistant challenge");
      const message: unknown = JSON.parse(c.message);
      if (!message || typeof message !== "object" || Array.isArray(message))
        throw new Error("Invalid assistant message");
      const m = message as Record<string, unknown>;
      if (
        m["purpose"] !==
          "Bot Bazaar private assistant session; no spending approval" ||
        m["domain"] !== this.origin ||
        m["deployment"] !== this.deployment ||
        m["accountId"] !== c.accountId ||
        m["shopId"] !== c.shopId ||
        m["challengeId"] !== c.id ||
        m["expiresAt"] !== c.expiresAt
      )
        throw new Error("Assistant challenge identity mismatch");
      const signed = await this.sign(initial.accountId, c);
      if (!current() || signed.accountId !== initial.accountId)
        throw new Error("Wallet changed");
      const session = (await this.request("verify", {
        id: c.id,
        ...signed,
      })) as Session;
      if (
        !current() ||
        session.accountId !== initial.accountId ||
        session.shopId !== shopId ||
        typeof session.token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(session.token) ||
        !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt <= Date.now()
      ) {
        if (typeof session.token === "string")
          void this.request("logout", {}, session.token).catch(() => {});
        throw new Error("Wallet changed or session invalid");
      }
      this.session = session;
      this.sessionVersion = initial.version;
    } finally {
      this.pending = false;
    }
  }
  async scope(shopId: string): Promise<unknown> {
    const s = this.session,
      initial = this.identity(),
      generation = this.generation;
    if (
      !s ||
      this.sessionVersion !== initial.version ||
      s.accountId !== initial.accountId ||
      s.shopId !== shopId ||
      s.expiresAt <= Date.now()
    ) {
      this.invalidate();
      throw new Error("Assistant sign-in required");
    }
    try {
      const value = await this.request(`shops/${shopId}/scope`, {}, s.token);
      const scope = value as Partial<Session> | null;
      if (
        !scope ||
        typeof scope !== "object" ||
        scope.accountId !== s.accountId ||
        scope.shopId !== shopId ||
        scope.expiresAt !== s.expiresAt ||
        scope.expiresAt <= Date.now() ||
        generation !== this.generation ||
        initial.accountId !== this.identity().accountId ||
        initial.version !== this.identity().version
      )
        throw new Error("Wallet changed");
      return value;
    } catch (error) {
      if (this.session === s && generation === this.generation)
        this.invalidate();
      throw error;
    }
  }
  async recommendations(shopId: string): Promise<unknown> {
    return this.operation(shopId, "recommendations");
  }
  async outcome(
    shopId: string,
    proposalId: string,
    attemptId: string,
    transactionHash: string,
    referenceBlockHeight: string,
  ): Promise<unknown> {
    return this.operation(shopId, "outcome", {
      proposalId,
      attemptId,
      transactionHash,
      referenceBlockHeight,
    });
  }
  async review(shopId: string, proposalId: string): Promise<unknown> {
    return this.operation(shopId, "review", { proposalId });
  }
  async dismiss(shopId: string, proposalId: string): Promise<unknown> {
    return this.operation(shopId, "dismiss", { proposalId });
  }
  async accept(
    shopId: string,
    review: unknown,
    attemptId: string,
    call: unknown,
  ): Promise<unknown> {
    return this.operation(shopId, "accept", { review, attemptId, call });
  }
  async generate(shopId: string): Promise<unknown> {
    return this.operation(shopId, "generate");
  }
  async pause(shopId: string): Promise<unknown> {
    return this.operation(shopId, "pause");
  }
  async resume(
    shopId: string,
    expectedRevision: string,
    policyRevision: string,
    mode: "recommendations" | "auto_reprice",
  ): Promise<unknown> {
    return this.operation(shopId, "resume", {
      expectedRevision,
      policyRevision,
      mode,
    });
  }
  async configure(
    shopId: string,
    mode: "off" | "recommendations",
  ): Promise<unknown> {
    return this.operation(shopId, "configuration", { mode });
  }
  async configureRestock(
    shopId: string,
    expectedRevision: string,
    limits: import("@bot-bazaar/chain").AssistantRestockLimits,
  ): Promise<unknown> {
    return this.operation(shopId, "restock", { expectedRevision, limits });
  }
  private async operation(
    shopId: string,
    action: string,
    body: unknown = {},
  ): Promise<unknown> {
    const s = this.session,
      identity = this.identity(),
      generation = this.generation;
    if (
      !s ||
      s.shopId !== shopId ||
      s.accountId !== identity.accountId ||
      this.sessionVersion !== identity.version ||
      s.expiresAt <= Date.now()
    ) {
      this.invalidate();
      throw new Error("Assistant sign-in required");
    }
    const value = await this.request(
      `shops/${shopId}/${action}`,
      body,
      s.token,
    );
    if (
      this.session !== s ||
      generation !== this.generation ||
      this.identity().accountId !== identity.accountId ||
      this.identity().version !== identity.version ||
      s.expiresAt <= Date.now()
    )
      throw new Error("Wallet changed");
    return value;
  }
}
