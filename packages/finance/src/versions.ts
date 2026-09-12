import { CommandError } from "./commands.js";

/**
 * Issue 5.2 — optimistic entity versions (shared helper).
 *
 * Every mutable canonical row (`transactions`, `accounts`, `categories`,
 * `counterparties`) carries `version BIGINT NOT NULL DEFAULT 1`. A command
 * that changes a row compares the caller's `expectedVersion` (when supplied)
 * against the loaded row and increments on success:
 *
 *   Tab A reads v3 → writes (expected 3) → v4.
 *   Tab B still holds v3 → writes (expected 3) → VERSION_CONFLICT.
 *
 * The generic executor (`executeCommand`) already enforces the comparison
 * via `currentVersionOf`; these helpers keep the convention — initial
 * value, increment, and conflict error — in one place so Issue 5.3/5.4/5.7
 * commands cannot drift apart. Undo (Issue 5.4) reuses the same rule: a
 * compensating write against a moved version fails instead of overwriting
 * newer work.
 */

/** Version assigned to a newly inserted versioned row. */
export function initialVersion(): number {
  return 1;
}

/** Next version after a successful mutation. */
export function nextVersion(current: number): number {
  return current + 1;
}

/**
 * Throw `CommandError(VERSION_CONFLICT)` when the caller pinned a stale
 * version. A null/undefined expectation means "no guard" (fire-and-forget
 * writes such as automated normalization); any concrete number must match.
 */
export function assertVersionMatch(
  current: number,
  expected: number | null | undefined,
  entityLabel: string,
): void {
  if (expected === undefined || expected === null) {
    return;
  }
  if (expected !== current) {
    throw new CommandError(
      "VERSION_CONFLICT",
      `stale version for ${entityLabel}: expected ${expected}, current ${current}`,
      { expectedVersion: expected, currentVersion: current },
    );
  }
}
