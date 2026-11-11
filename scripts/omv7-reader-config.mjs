import { existsSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { parsePublicConfig } from "../packages/shared/dist/index.js";

export function projectionInitialization(directory, allowCreate) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Regular projection directory required");
  if (existsSync(join(directory, "living-town.sqlite"))) return false;
  if (allowCreate !== "true" || readdirSync(directory).length !== 0)
    throw Error(
      "No projection database: explicitly allow creation in a new empty volume; never reset an established projection",
    );
  return true;
}

export function omv7ReaderConfig(profile, env) {
  const target = env.V2_RELEASE_TARGET;
  if (!["local", "public"].includes(target))
    throw Error("Select local or public V2 release target");
  const pub = parsePublicConfig({
    ...profile.public,
    workerUrl: env.V2_WORKER_URL,
  });
  const origin = new URL(env.V2_FRONTEND_ORIGIN);
  if (
    origin.origin !== env.V2_FRONTEND_ORIGIN ||
    origin.username ||
    origin.password
  )
    throw Error(
      "V2_FRONTEND_ORIGIN must be an exact origin without a trailing slash",
    );
  if (target === "public") {
    for (const url of [origin, new URL(pub.workerUrl)]) {
      if (
        url.protocol !== "https:" ||
        !url.hostname.includes(".") ||
        url.hostname.endsWith(".localhost") ||
        url.hostname.endsWith(".local") ||
        /^[\d.]+$/.test(url.hostname) ||
        url.hostname.includes(":")
      )
        throw Error("Public services require HTTPS DNS origins");
    }
  } else if (
    pub.workerUrl !== "http://127.0.0.1:3011/" ||
    origin.origin !== "http://127.0.0.1:4201"
  ) {
    throw Error("Local Compose must use the documented loopback origins");
  }
  return {
    schema: "bot-bazaar-living-town-reader-v1",
    identity: profile.identity,
    public: pub,
    data_dir: "/data/projection",
    receipt_inbox: null,
    backup_directory: null,
    agent_activity_inbox: null,
    trusted_proxy_ips: [],
    port: "3011",
    poll_ms: "3000",
    allowed_origins: [origin.origin],
  };
}
