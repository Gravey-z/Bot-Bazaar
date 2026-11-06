import { parseLivingTownU128, parseU64 } from "@bot-bazaar/chain";
import { requireStorage } from "../storage/validation.js";

export interface CostUnit {
  cost: string | null;
  source: string;
  ordinal: string;
}
/** 32-byte units + known bitset/count: 32,129 bytes at the 1,000-unit cap. */
export function encodeCostUnits(units: readonly CostUnit[]): Uint8Array {
  requireStorage(units.length <= 1000, "cost inventory cap exceeded");
  const bits = Math.ceil(units.length / 8),
    bytes = Buffer.alloc(4 + bits + units.length * 32);
  bytes.writeUInt32BE(units.length);
  units.forEach((u, i) => {
    const offset = 4 + bits + i * 32;
    if (u.cost !== null) {
      const cost = BigInt(parseLivingTownU128(u.cost));
      bytes[4 + Math.floor(i / 8)]! |= 1 << (i % 8);
      bytes.writeBigUInt64BE(cost >> 64n, offset);
      bytes.writeBigUInt64BE(cost & ((1n << 64n) - 1n), offset + 8);
    }
    bytes.writeBigUInt64BE(BigInt(parseU64(u.source)), offset + 16);
    bytes.writeBigUInt64BE(BigInt(parseU64(u.ordinal)), offset + 24);
  });
  return bytes;
}
export function decodeCostUnits(raw: Uint8Array): CostUnit[] {
  const b = Buffer.from(raw);
  requireStorage(
    b.length >= 4 && b.length <= 32768,
    "invalid cost inventory bytes",
  );
  const count = b.readUInt32BE(),
    bits = Math.ceil(count / 8);
  requireStorage(
    count <= 1000 && b.length === 4 + bits + count * 32,
    "invalid cost inventory length",
  );
  return Array.from({ length: count }, (_, i) => {
    const offset = 4 + bits + i * 32;
    return {
      cost:
        b[4 + Math.floor(i / 8)]! & (1 << (i % 8))
          ? (
              (b.readBigUInt64BE(offset) << 64n) +
              b.readBigUInt64BE(offset + 8)
            ).toString()
          : null,
      source: b.readBigUInt64BE(offset + 16).toString(),
      ordinal: b.readBigUInt64BE(offset + 24).toString(),
    };
  });
}
export function costTotal(units: readonly CostUnit[]): string | null {
  return units.some((u) => u.cost === null)
    ? null
    : parseLivingTownU128(
        units.reduce((n, u) => n + BigInt(u.cost!), 0n).toString(),
      );
}
export function allocateOutputCosts(
  total: string | null,
  count: string,
  source: string,
): CostUnit[] {
  const q = BigInt(parseU64(count));
  requireStorage(q > 0n && q <= 1000n, "invalid cost allocation quantity");
  const cost = total === null ? null : BigInt(parseLivingTownU128(total));
  return Array.from({ length: Number(q) }, (_, i) => ({
    cost:
      cost === null
        ? null
        : (cost / q + (BigInt(i) < cost % q ? 1n : 0n)).toString(),
    source: parseU64(source),
    ordinal: String(i),
  }));
}
