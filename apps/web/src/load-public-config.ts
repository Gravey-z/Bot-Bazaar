import { ConfigurationError, parsePublicConfig } from "@bot-bazaar/shared";
import type { PublicConfig } from "@bot-bazaar/shared";

export async function loadPublicConfig(url: URL): Promise<PublicConfig> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ConfigurationError(
      "could not load config.json; check the web deployment and refresh",
    );
  }
  if (!response.ok) {
    throw new ConfigurationError(
      "config.json is unavailable; configure and rebuild the website",
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ConfigurationError("config.json must contain valid JSON");
  }
  return parsePublicConfig(value);
}
