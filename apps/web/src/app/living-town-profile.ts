import { parseLivingTownJson } from "@bot-bazaar/chain";
import { InjectionToken } from "@angular/core";

export type { LivingTownWebProfile as LivingTownProfile } from "@bot-bazaar/chain";
import type { LivingTownWebProfile as LivingTownProfile } from "@bot-bazaar/chain";
export type LivingTownSetup =
  | { kind: "ready"; profile: LivingTownProfile }
  | { kind: "unconfigured" | "unavailable" };
export const LIVING_TOWN_SETUP = new InjectionToken<LivingTownSetup>(
  "living-town-setup",
);
export { parseLivingTownWebProfile as parseLivingTownProfile } from "@bot-bazaar/chain";
import { parseLivingTownWebProfile as parseLivingTownProfile } from "@bot-bazaar/chain";
export async function loadLivingTownSetup(
  base: URL,
  fetcher: typeof fetch = fetch,
): Promise<LivingTownSetup> {
  try {
    const response = await fetcher(new URL("living-town.json", base), {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (
      response.status === 404 ||
      response.headers.get("content-type")?.includes("text/html")
    )
      return { kind: "unconfigured" };
    if (!response.ok || !response.body)
      throw new Error("Town profile unavailable");
    const reader = response.body.getReader(),
      parts: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      length += r.value.length;
      if (length > 16384) {
        await reader.cancel();
        throw new Error("Town profile too large");
      }
      parts.push(r.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.length;
    }
    return {
      kind: "ready",
      profile: parseLivingTownProfile(
        parseLivingTownJson(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ),
      ),
    };
  } catch {
    return { kind: "unavailable" };
  }
}
