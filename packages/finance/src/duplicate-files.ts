import { sha256Hex } from "@moneo/shared/uploads";

/**
 * Issue 3.8 — duplicate file detection as a warning signal.
 *
 * A repeated SHA-256 is a WARNING, never a uniqueness rule: the schema
 * (Issue 3.1) deliberately puts no unique constraint on `file_sha256`, so
 * re-importing the same bytes with a newer parser — or on purpose — always
 * works. `checkDuplicateFile` compares one fresh digest against the
 * workspace's prior imports and returns either null (no signal) or a
 * human-readable advisory the wizard shows WITHOUT blocking Continue.
 * Row-level identity stays out of scope here on purpose: two legitimate
 * identical purchases must never be suppressed (Issue 4.11 owns matching).
 */

export interface PriorImportFile {
  importId: string;
  fileName: string | null;
  fileSha256: string | null;
  createdAt: string;
}

export interface DuplicateSignal {
  isRepeat: true;
  matches: PriorImportFile[];
  /** At least one prior import carried the same file name. */
  sameName: boolean;
  message: string;
}

/**
 * Compare a fresh upload digest against prior imports of the same
 * workspace. Returns null when there is nothing to warn about (no digest,
 * or no prior import with these bytes).
 */
export function checkDuplicateFile(
  prior: readonly PriorImportFile[],
  sha256: string | null | undefined,
  fileName?: string,
): DuplicateSignal | null {
  const digest = (sha256 ?? "").trim().toLowerCase();
  if (digest === "") {
    return null;
  }
  const matches = prior.filter((item) => (item.fileSha256 ?? "").trim().toLowerCase() === digest);
  if (matches.length === 0) {
    return null;
  }
  const sameName = fileName !== undefined && matches.some((item) => item.fileName === fileName);
  const latest = matches[0] as PriorImportFile;
  const times = matches.length === 1 ? "once" : `${matches.length} times`;
  const message =
    `This exact file was already imported ${times}` +
    (sameName ? "" : ` (latest as "${latest.fileName ?? "unnamed file"}")`) +
    `. Re-importing is safe — existing rows are recognized, not duplicated —` +
    ` but you can stop here if the repeat was accidental.`;
  return { isRepeat: true as const, matches: [...matches], sameName, message };
}

/** Digest helper re-exported beside the check so callers hash bytes one way. */
export function digestBytes(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
