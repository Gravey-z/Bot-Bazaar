import { parsePublicConfig } from "@bot-bazaar/shared";
import type { PublicConfig } from "@bot-bazaar/shared";
import { check, literal, object } from "../wire.js";
import { parseLivingTownIdentity } from "./client.js";
import type { LivingTownIdentity } from "./client.js";
export interface LivingTownWebProfile {
  public: PublicConfig;
  identity: LivingTownIdentity;
}
const profile = object({
  schema: literal("living-town-web-v1"),
  public: parsePublicConfig,
  identity: parseLivingTownIdentity,
});
export function parseLivingTownWebProfile(
  value: unknown,
): LivingTownWebProfile {
  const v = profile(value);
  check(
    v.public.contractId === v.identity.deployment.contract_id &&
      v.public.networkId === v.identity.deployment.network_id,
    "town profile identity mismatch",
  );
  return Object.freeze({ identity: v.identity, public: v.public });
}
