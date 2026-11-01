import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import { clientIp } from "./config.js";
import type { BoundaryConfig } from "./config.js";

interface Bucket {
  tokens: number;
  at: number;
}
export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; status: 400 | 429; code: string; retryAfter: number };

// Both rate and active-response state are process-local, bounded and monotonic.
// A restart refills tokens; these controls are not a billing or signing ledger.
export class ReadLimits {
  private readonly clients = new Map<string, Bucket>();
  private readonly global: Bucket;
  private active = 0;
  constructor(
    private readonly config: BoundaryConfig,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.global = { tokens: 20, at: this.now() };
  }
  private refill(bucket: Bucket, rate: number, time: number): void {
    bucket.tokens = Math.min(
      20,
      bucket.tokens + (Math.max(0, time - bucket.at) * rate) / 1000,
    );
    bucket.at = time;
  }
  admit(request: IncomingMessage): Admission {
    const peer = clientIp(request.socket.remoteAddress ?? ""),
      forwarded = request.headers["x-forwarded-for"];
    let address = peer;
    if (peer && this.config.trustedProxyIps.includes(peer)) {
      // A trusted reverse proxy must overwrite XFF with exactly one client IP.
      address = typeof forwarded === "string" ? clientIp(forwarded) : null;
    }
    if (!address)
      return {
        ok: false,
        status: 400,
        code: "invalid_client_address",
        retryAfter: 0,
      };
    const time = this.now();
    this.refill(this.global, this.config.globalPerSecond, time);
    if (this.global.tokens < 1)
      return {
        ok: false,
        status: 429,
        code: "read_rate_limited",
        retryAfter: Math.max(
          1,
          Math.ceil((1 - this.global.tokens) / this.config.globalPerSecond),
        ),
      };
    let bucket = this.clients.get(address);
    if (!bucket) {
      if (this.clients.size >= 4096) {
        // Expire only fully refilled idle buckets, never evict a throttled client.
        const ttl = Math.max(
          120000,
          (20 * 60000) / this.config.clientPerMinute,
        );
        for (const [ip, old] of this.clients)
          if (time - old.at >= ttl) this.clients.delete(ip);
      }
      if (this.clients.size >= 4096)
        return {
          ok: false,
          status: 429,
          code: "read_rate_limited",
          retryAfter: 60,
        };
      bucket = { tokens: 20, at: time };
      this.clients.set(address, bucket);
    }
    this.refill(bucket, this.config.clientPerMinute / 60, time);
    if (bucket.tokens < 1 || this.global.tokens < 1) {
      const wait = Math.max(
        ((1 - bucket.tokens) * 60) / this.config.clientPerMinute,
        (1 - this.global.tokens) / this.config.globalPerSecond,
      );
      return {
        ok: false,
        status: 429,
        code: "read_rate_limited",
        retryAfter: Math.max(1, Math.ceil(wait)),
      };
    }
    if (this.active >= 8)
      return {
        ok: false,
        status: 429,
        code: "read_concurrency_limited",
        retryAfter: 1,
      };
    bucket.tokens--;
    this.global.tokens--;
    this.active++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (!released) {
          released = true;
          this.active--;
        }
      },
    };
  }
}
