import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "near-api-js";
import type { LivingTownClient } from "@bot-bazaar/chain";

export class AssistantAuthError extends Error {
  constructor(public readonly status: number) {
    super("Assistant authentication unavailable");
  }
}
export interface AssistantFacts {
  authorize(account: string, key: string, shop: string): Promise<boolean>;
}
/** Each access checks both key and shop at the same verified finalized block. */
export function assistantFacts(client: LivingTownClient): AssistantFacts {
  return {
    async authorize(account, key, shop) {
      const reader = await client.finalized();
      const [access, snapshot] = await Promise.all([
        reader.getAccessKey(account, key),
        reader.getShop(shop),
      ]);
      return (
        access.permission === "FullAccess" &&
        snapshot.data?.owner.kind === "player" &&
        snapshot.data.owner.account_id === account
      );
    },
  };
}
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
  accountId: string;
  shopId: string;
  publicKey: string;
  expiresAt: number;
}
const hash = (s: string): string =>
  createHash("sha256").update(s).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");
export function assistantOrigin(value: string): string {
  const u = new URL(value);
  if (
    u.origin !== value ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw new Error("Exact HTTPS or loopback assistant origin required");
  return value;
}
/** NEP-413: SHA256(Borsh(u32 tag, message, 32-byte nonce, recipient, None)). */
export function assistantMessageHash(c: AssistantChallenge): Uint8Array {
  const text = (s: string): Buffer => {
    const bytes = Buffer.from(s, "utf8"),
      size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061);
  return createHash("sha256")
    .update(
      Buffer.concat([
        tag,
        text(c.message),
        Buffer.from(c.nonce, "base64"),
        text(c.recipient),
        Buffer.from([0]),
      ]),
    )
    .digest();
}

/** Ephemeral auth only: restart invalidates all sessions/challenges, no economic state. */
export class AssistantAuth {
  private readonly challenges = new Map<string, AssistantChallenge>();
  private readonly sessions = new Map<string, Session>();
  readonly origin: string;
  constructor(
    origin: string,
    private readonly deployment: string,
    private readonly facts: AssistantFacts,
    private readonly now: () => number = Date.now,
  ) {
    this.origin = assistantOrigin(origin);
    if (!deployment || deployment.length > 2048)
      throw new Error("Invalid deployment");
  }
  private cleanup(): void {
    for (const [id, c] of this.challenges)
      if (c.expiresAt <= this.now()) this.challenges.delete(id);
    for (const [id, s] of this.sessions)
      if (s.expiresAt <= this.now()) this.sessions.delete(id);
  }
  challenge(accountId: string, shopId: string): AssistantChallenge {
    this.cleanup();
    if (
      !(
        /^[a-f0-9]{64}$/.test(accountId) ||
        /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+testnet$/.test(accountId)
      ) ||
      accountId.length > 64 ||
      !/^[1-9][0-9]{0,19}$/.test(shopId) ||
      BigInt(shopId) > 18446744073709551615n
    )
      throw new AssistantAuthError(400);
    if (this.challenges.size >= 1024) throw new AssistantAuthError(429);
    const id = token(),
      nonce = randomBytes(32).toString("base64"),
      expiresAt = this.now() + 120000;
    const c: AssistantChallenge = {
      id,
      accountId,
      shopId,
      nonce,
      expiresAt,
      recipient: this.origin,
      message: JSON.stringify({
        purpose: "Bot Bazaar private assistant session; no spending approval",
        domain: this.origin,
        deployment: this.deployment,
        accountId,
        shopId,
        challengeId: id,
        expiresAt,
      }),
    };
    this.challenges.set(id, c);
    return { ...c };
  }
  async verify(input: {
    id: string;
    accountId: string;
    publicKey: string;
    signature: string;
  }): Promise<{
    token: string;
    accountId: string;
    shopId: string;
    expiresAt: number;
  }> {
    const c = this.challenges.get(input.id);
    // Consume before awaiting RPC: simultaneous verifies cannot reuse a nonce.
    this.challenges.delete(input.id);
    if (!c || c.expiresAt <= this.now() || c.accountId !== input.accountId)
      throw new AssistantAuthError(401);
    try {
      const sig = Buffer.from(input.signature, "base64");
      if (
        !input.publicKey.startsWith("ed25519:") ||
        sig.length !== 64 ||
        sig.toString("base64") !== input.signature ||
        !PublicKey.from(input.publicKey).verify(assistantMessageHash(c), sig) ||
        !(await this.facts.authorize(c.accountId, input.publicKey, c.shopId))
      )
        throw new AssistantAuthError(401);
    } catch {
      throw new AssistantAuthError(401);
    }
    if (c.expiresAt <= this.now()) throw new AssistantAuthError(401);
    this.cleanup();
    if (this.sessions.size >= 1024) throw new AssistantAuthError(429);
    const raw = token(),
      expiresAt = this.now() + 600000;
    this.sessions.set(hash(raw), {
      accountId: c.accountId,
      shopId: c.shopId,
      publicKey: input.publicKey,
      expiresAt,
    });
    return { token: raw, accountId: c.accountId, shopId: c.shopId, expiresAt };
  }
  async scope(
    raw: string,
    shopId: string,
  ): Promise<{
    accountId: string;
    shopId: string;
    expiresAt: number;
  }> {
    this.cleanup();
    const id = hash(raw),
      s = this.sessions.get(id);
    if (!s || s.expiresAt <= this.now() || s.shopId !== shopId)
      throw new AssistantAuthError(401);
    let allowed = false;
    try {
      allowed = await this.facts.authorize(s.accountId, s.publicKey, shopId);
    } catch {
      /* RPC failure never authenticates. */
    }
    if (!allowed || this.sessions.get(id) !== s || s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      throw new AssistantAuthError(401);
    }
    return { accountId: s.accountId, shopId, expiresAt: s.expiresAt };
  }
  revoke(raw: string): void {
    this.sessions.delete(hash(raw));
  }
}
