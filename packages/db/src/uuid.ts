import { randomBytes, randomUUID } from "node:crypto";

/**
 * Minimal UUIDv7 generator (RFC 9562 §5.7): 48-bit big-endian Unix millis,
 * `0111` version nibble, `10xx` variant bits, 74 random bits.
 *
 * Ids are generated application-side and used as `$defaultFn` for every
 * `users` / `workspaces` / `security_audit_events` primary key, so rows are
 * time-ordered without depending on a database extension.
 */
export function uuidv7(nowMillis: number = Date.now()): string {
  if (!Number.isInteger(nowMillis) || nowMillis < 0 || nowMillis > 0xffffffffffff) {
    throw new RangeError(`uuidv7 timestamp out of range: ${nowMillis}`);
  }
  const bytes = randomBytes(16);
  const timeHex = nowMillis.toString(16).padStart(12, "0");
  for (let i = 0; i < 6; i += 1) {
    const pair = timeHex.slice(i * 2, i * 2 + 2);
    const parsed = Number.parseInt(pair, 16);
    if (Number.isNaN(parsed)) {
      throw new RangeError(`uuidv7 timestamp out of range: ${nowMillis}`);
    }
    bytes[i] = parsed;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** True when `id` parses as a version-7 UUID (any case, canonical hyphenation). */
export function isUuidV7(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Strict workspace/row id guard used before interpolating an id into
 * `SET LOCAL app.current_workspace = '…'`. Placeholders are not allowed in
 * PostgreSQL `SET`, so only a regex-validated id may be interpolated.
 */
export function assertUuid(id: string, label = "id"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid ${label}: not a UUID`);
  }
  return id;
}

/** Node's built-in v4 generator, re-exported for tests that need non-v7 ids. */
export { randomUUID };
