import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseLivingTownWebProfile } from "@bot-bazaar/chain";
import { readBoundedFile } from "../living-town/config.js";
import { parseBoundaryConfig } from "../read-api/config.js";

export function guestCheck(value: unknown, code = "guest_configuration_invalid"): asserts value {
  if (!value) throw new Error(code);
}
export function guestObject(value: unknown, keys: string[]): Record<string, unknown> {
  guestCheck(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join());
  return value as Record<string, unknown>;
}
function absolute(value: unknown): string {
  guestCheck(typeof value === "string" && isAbsolute(value)); return resolve(value);
}
function integer(value: unknown, min: number, max: number): number {
  guestCheck(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max); return value;
}
function money(value: unknown): string {
  guestCheck(typeof value === "string" && /^[1-9][0-9]{0,29}$/.test(value)); return value;
}
export function guestConfig(value: unknown) {
  const r = guestObject(value, ["profile_file", "data_dir", "encryption_key_file", "funder_key_file", "funding_witness_file", "receipt_outbox",
    "parent_account_id", "frontend_origin", "trusted_proxy_ips", "port", "poll_ms", "session_ttl_seconds",
    "guest_funding_yocto", "creation_fee_reserve_yocto", "total_funding_cap_yocto", "daily_funding_cap_yocto",
    "max_guests", "max_guests_per_day", "max_guests_per_ip_day"]);
  const profile = parseLivingTownWebProfile(readBoundedFile(absolute(r["profile_file"]), 32768));
  const parent = r["parent_account_id"];
  guestCheck(typeof parent === "string" && parent.length <= 45 &&
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(parent));
  guestCheck(![profile.identity.ownerId, profile.identity.operatorId, profile.public.contractId,
    ...Object.values(profile.identity.controllers)].includes(parent), "dedicated_guest_parent_required");
  const origin = r["frontend_origin"];
guestCheck(typeof origin === "string");

// Browser access is separate from the existing custody binding.
const browserOrigin =
  process.env["GUEST_BROWSER_ORIGIN"] ?? origin;

guestCheck(
  browserOrigin === origin ||
  browserOrigin === "https://bot-bazaar.pages.dev",
  "guest_browser_origin_invalid"
);
  guestCheck(Array.isArray(r["trusted_proxy_ips"]) && r["trusted_proxy_ips"].every(v => typeof v === "string"));
  const boundary = parseBoundaryConfig({ WORKER_ALLOWED_ORIGINS: origin,
    WORKER_TRUSTED_PROXY_IPS: (r["trusted_proxy_ips"] as string[]).join(","),
    WORKER_READS_PER_MINUTE: "30", WORKER_READS_PER_SECOND: "5" });
  guestCheck(boundary.allowedOrigins.length === 1);
  const directory = absolute(r["data_dir"]), masterFile = absolute(r["encryption_key_file"]),
    funderFile = absolute(r["funder_key_file"]), witnessFile = absolute(r["funding_witness_file"]);
  for (const file of [masterFile, funderFile, witnessFile]) {
    const rel = relative(directory, file);
    guestCheck(rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel), "guest_secrets_must_be_outside_database_directory");
  }
  guestCheck(new Set([masterFile, funderFile, witnessFile, absolute(r["profile_file"])]).size === 4);
  const outbox = absolute(r["receipt_outbox"]);
  const contains = (dir: string, file: string) => {
    const rel = relative(dir, file); return !rel || (!(rel === ".." || rel.startsWith(".." + sep)) && !isAbsolute(rel));
  };
  guestCheck(!contains(directory, outbox) && !contains(outbox, directory));
  for (const file of [masterFile, funderFile, witnessFile, absolute(r["profile_file"])])
    guestCheck(!contains(outbox, file), "guest_public_receipts_must_not_contain_secrets");
  const funding = money(r["guest_funding_yocto"]), feeReserve = money(r["creation_fee_reserve_yocto"]),
    totalCap = money(r["total_funding_cap_yocto"]), dailyCap = money(r["daily_funding_cap_yocto"]);
  guestCheck(BigInt(funding) >= 10n ** 22n && BigInt(funding) <= 10n ** 23n);
  guestCheck(BigInt(feeReserve) >= 10n ** 21n && BigInt(feeReserve) <= 10n ** 23n);
  guestCheck(BigInt(dailyCap) >= BigInt(funding) + BigInt(feeReserve) && BigInt(dailyCap) <= BigInt(totalCap));
  return Object.freeze({ profile, parent, boundary, directory, masterFile, funderFile, witnessFile, outbox, origin, browserOrigin,
    funding, feeReserve, totalCap, dailyCap,
    port: integer(r["port"], 1024, 65535), pollMs: integer(r["poll_ms"], 1000, 60000),
    sessionTtlMs: integer(r["session_ttl_seconds"], 3600, 604800) * 1000,
    // Retained for compatibility with existing custody bindings; creation counts
    // are recorded but no longer limited. Monetary funding caps still apply.
    maxGuests: integer(r["max_guests"], 1, 1000), maxDaily: integer(r["max_guests_per_day"], 1, 100),
    maxIpDaily: integer(r["max_guests_per_ip_day"], 1, 20) });
}
export type GuestConfig = ReturnType<typeof guestConfig>;
