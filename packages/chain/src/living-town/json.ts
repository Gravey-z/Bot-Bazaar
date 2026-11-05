import { check } from "../wire.js";

// Preserve repeated-key detection before an exact-key DTO sees parsed values.
export function parseLivingTownJson(text: string): unknown {
  check(new TextEncoder().encode(text).length <= 262144, "V2 JSON too large");
  let offset = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[offset] ?? "x")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const c = text[offset++];
      if (c === "\\") offset++;
      else if (c === '"')
        return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new Error("Unterminated V2 JSON string");
  };
  const value = (depth: number): unknown => {
    check(depth <= 32, "V2 JSON nesting limit");
    whitespace();
    if (text[offset] === '"') return string();
    if (text[offset] === "{" || text[offset] === "[") {
      const isObject = text[offset++] === "{";
      const close = isObject ? "}" : "]";
      const result: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      const items: unknown[] = [];
      whitespace();
      if (text[offset] === close) {
        offset++;
        return isObject ? result : items;
      }
      while (offset < text.length) {
        whitespace();
        if (isObject) {
          check(text[offset] === '"', "V2 JSON key expected");
          const key = string();
          whitespace();
          check(
            text[offset++] === ":" && !Object.hasOwn(result, key),
            "duplicate or invalid V2 JSON key",
          );
          result[key] = value(depth + 1);
        } else items.push(value(depth + 1));
        whitespace();
        if (text[offset] === close) {
          offset++;
          return isObject ? result : items;
        }
        check(text[offset++] === ",", "V2 JSON separator expected");
      }
      throw new Error("Unterminated V2 JSON container");
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/.test(text[offset]!)) offset++;
    check(offset > start, "V2 JSON value expected");
    return JSON.parse(text.slice(start, offset)) as unknown;
  };
  const result = value(0);
  whitespace();
  check(offset === text.length, "trailing V2 JSON");
  return result;
}
export function canonicalLivingTownJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    check(
      Object.keys(value).length === value.length &&
        Object.keys(value).every((key, index) => key === String(index)),
      "V2 canonical JSON requires dense arrays",
    );
    return `[${value.map(canonicalLivingTownJson).join(",")}]`;
  }
  check(
    typeof value === "object" &&
      value !== null &&
      [Object.prototype, null].includes(
        Object.getPrototypeOf(value) as object | null,
      ),
    "V2 canonical JSON requires JSON values and string integers",
  );
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalLivingTownJson(row[key])}`)
    .join(",")}}`;
}
export async function livingTownJsonDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalLivingTownJson(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
