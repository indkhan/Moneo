export type Direction = "up" | "down" | "flat";
export type Delta = { amount: string; percent: string | null; direction: Direction };
type Money = (minor: bigint | string, currency: string) => string;

export const directionOf = (minor: bigint): Direction => minor > 0n ? "up" : minor < 0n ? "down" : "flat";

export function percentText(part: bigint, whole: bigint): string | null {
  if (whole <= 0n) return null;
  const basisPoints = part * 10000n / whole, size = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${basisPoints > 0n ? "+" : basisPoints < 0n ? "-" : ""}${size / 100n}.${(size % 100n).toString().padStart(2, "0")}%`;
}

export function delta(from: bigint, to: bigint, currency: string, money: Money): Delta {
  const moved = to - from;
  return { amount: `${moved > 0n ? "+" : ""}${money(moved, currency)}`, percent: percentText(moved, from), direction: directionOf(moved) };
}
