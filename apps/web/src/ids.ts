// E01-S03 application-side UUIDv7 (architecture §125: generate in code
// because CI runs PostgreSQL 17 without uuidv7()). 48-bit millisecond
// timestamp + 74 CSPRNG bits with version/variant nibbles. Lexicographically
// sortable by creation time within the same millisecond clock.

import { randomBytes } from "node:crypto";

export function uuidv7(nowMs = Date.now()): string {
  const rand = randomBytes(10);
  const timeHex = nowMs.toString(16).padStart(12, "0").slice(-12);
  const b = [...rand];
  b[0] = (b[0] & 0x0f) | 0x70; // version 7
  b[2] = (b[2] & 0x3f) | 0x80; // variant 10
  const hex = Buffer.from(b).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8)}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
