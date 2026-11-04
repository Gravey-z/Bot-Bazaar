import {
  ConfigurationError,
  parsePublicConfig,
  parseWebDeployment,
} from "@bot-bazaar/shared";
import type { WebDeployment } from "@bot-bazaar/shared";
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

export async function loadPublicDeployment(url: URL): Promise<WebDeployment> {
  const descriptor = async (): Promise<WebDeployment> => {
    try {
      const response = await fetch(new URL("deployment.json", url), {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok || !response.body)
        throw new Error("Unavailable deployment");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 65536) {
          await reader.cancel();
          throw new Error("Deployment exceeds limit");
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return parseWebDeployment(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch {
      throw new ConfigurationError(
        "deployment.json is unavailable or invalid; preserve original wallet records and restore the reviewed site configuration",
      );
    }
  };
  const [config, deployment] = await Promise.all([
    loadPublicConfig(url),
    descriptor(),
  ]);
  if (JSON.stringify(config) !== JSON.stringify(deployment.current))
    throw new ConfigurationError(
      "config.json and deployment.json disagree; refresh the complete deployment without deleting wallet records",
    );
  return deployment;
}
