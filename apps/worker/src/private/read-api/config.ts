import { ConfigurationError } from "@bot-bazaar/shared";
import { isIP } from "node:net";

export interface BoundaryConfig {
  readonly allowedOrigins: readonly string[];
  readonly trustedProxyIps: readonly string[];
  readonly clientPerMinute: number;
  readonly globalPerSecond: number;
}

export const defaultBoundary: BoundaryConfig = Object.freeze({
  allowedOrigins: Object.freeze([]),
  trustedProxyIps: Object.freeze([]),
  clientPerMinute: 120,
  globalPerSecond: 10,
});

export function clientIp(value: string): string | null {
  if (value.includes("%") || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // Socket peers commonly represent IPv4 addresses in mapped IPv6 form.
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16),
    low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function parseBoundaryConfig(
  env: Readonly<Record<string, string | undefined>>,
): BoundaryConfig {
  const list = (name: string): string[] => {
    const raw = env[name];
    if (raw === undefined || raw === "") return [];
    const parts = raw.split(",").map((part) => part.trim());
    if (raw.length > 4096 || parts.length > 16 || parts.some((part) => !part))
      throw new ConfigurationError(
        `${name} must be a bounded comma-separated list`,
      );
    return parts;
  };
  const allowedOrigins = list("WORKER_ALLOWED_ORIGINS").map((origin) => {
    try {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        url.hostname.includes("*") ||
        url.username ||
        url.password ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw new Error();
      return origin;
    } catch {
      throw new ConfigurationError(
        "WORKER_ALLOWED_ORIGINS requires exact HTTPS origins or loopback HTTP origins",
      );
    }
  });
  const trustedProxyIps = list("WORKER_TRUSTED_PROXY_IPS").map((value) => {
    const address = clientIp(value);
    if (!address)
      throw new ConfigurationError(
        "WORKER_TRUSTED_PROXY_IPS requires literal IP addresses",
      );
    return address;
  });
  const integer = (name: string, fallback: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > max)
      throw new ConfigurationError(
        `${name} is outside the supported positive integer range`,
      );
    return Number(raw);
  };
  return Object.freeze({
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    trustedProxyIps: Object.freeze([...new Set(trustedProxyIps)]),
    clientPerMinute: integer("WORKER_READS_PER_MINUTE", 120, 600),
    globalPerSecond: integer("WORKER_READS_PER_SECOND", 10, 100),
  });
}
