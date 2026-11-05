import { parsePublicConfig } from "@bot-bazaar/shared";
import type { PublicConfig } from "@bot-bazaar/shared";
import { check, hash32, literal, object } from "../wire.js";
import { parseLivingTownDeployment } from "./wire.js";

const origin = (value: unknown): string => {
  check(typeof value === "string", "origin required");
  const url = new URL(value);
  check(
    url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
    "invalid V2 origin",
  );
  return value;
};
const selection = object({
  schema: literal("bot-bazaar-living-town-selection-v1"),
  public: parsePublicConfig,
  expected: parseLivingTownDeployment,
  code_hash: hash32,
  origin,
});
export function selectLivingTownDeployment(
  value: unknown,
  preservedV1: { public: PublicConfig; origin: string },
): Readonly<ReturnType<typeof selection>> {
  const selected = selection(value),
    legacy = parsePublicConfig(preservedV1.public);
  check(
    selected.public.contractId === selected.expected.contract_id &&
      selected.public.networkId === selected.expected.network_id,
    "V2 selected identity mismatch",
  );
  check(
    selected.public.contractId !== legacy.contractId &&
      selected.origin !== origin(preservedV1.origin) &&
      selected.public.workerUrl !== legacy.workerUrl,
    "V2 must isolate V1 contract, origin and worker",
  );
  return Object.freeze({
    ...selected,
    expected: Object.freeze(selected.expected),
  });
}
