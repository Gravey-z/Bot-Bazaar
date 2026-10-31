export function readBackoff(
  failures: number,
  baseMs = 3000,
  capMs = 30000,
): number {
  if (
    !Number.isSafeInteger(failures) ||
    failures < 0 ||
    !Number.isSafeInteger(baseMs) ||
    baseMs < 1 ||
    !Number.isSafeInteger(capMs) ||
    capMs < baseMs
  )
    throw new Error("invalid read retry policy");
  return Math.min(capMs, baseMs * 2 ** Math.min(Math.max(failures - 1, 0), 20));
}
