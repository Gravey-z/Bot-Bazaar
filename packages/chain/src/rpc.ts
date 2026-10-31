import { check, record } from "./wire.js";

export type RpcTransport = (
  method: string,
  params: unknown,
) => Promise<unknown>;
export class ChainRpcError extends Error {
  constructor(public readonly code: string) {
    super(`Chain RPC: ${code}`);
    this.name = "ChainRpcError";
  }
}
export function parseTestnetRpcUrl(value: string): string {
  const url = new URL(value);
  check(
    [
      "https://test.rpc.fastnear.com/",
      "https://archival-rpc.testnet.near.org/",
    ].includes(url.href),
    "unapproved Testnet RPC endpoint",
  );
  return url.href;
}
export function createRpcTransport(
  url: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10000,
): RpcTransport {
  const endpoint = parseTestnetRpcUrl(url);
  check(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000,
    "invalid RPC timeout",
  );
  let sequence = 0;
  return async (method, params) => {
    try {
      const id = `bot-bazaar-${++sequence}`;
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || !response.body)
        throw new ChainRpcError("UNAVAILABLE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new ChainRpcError("RESPONSE_TOO_LARGE");
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const envelope = record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      check(
        envelope["jsonrpc"] === "2.0" && envelope["id"] === id,
        "RPC envelope identity mismatch",
      );
      if (Object.hasOwn(envelope, "error")) {
        const error = record(envelope["error"]);
        const cause =
          error["cause"] === undefined ? {} : record(error["cause"]);
        const code = cause["name"];
        throw new ChainRpcError(
          code === "UNKNOWN_TRANSACTION" ? code : "REJECTED",
        );
      }
      check(Object.hasOwn(envelope, "result"), "missing RPC result");
      return envelope["result"];
    } catch (error) {
      if (error instanceof ChainRpcError) throw error;
      // Transport errors and provider messages never expose signed bytes or credentials.
      throw new ChainRpcError("UNAVAILABLE_OR_INVALID_RESPONSE");
    }
  };
}

export function encodeArguments(args: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeBytes(value: unknown): unknown {
  check(
    Array.isArray(value) &&
      value.length <= 256 * 1024 &&
      value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    "invalid view bytes",
  );
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value)),
  );
}
export function decodeBase64Json(value: unknown): unknown {
  check(
    typeof value === "string" &&
      value.length <= 350000 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
    "invalid base64 result",
  );
  const binary = atob(value);
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    ),
  );
}
