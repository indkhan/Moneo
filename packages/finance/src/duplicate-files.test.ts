import { describe, expect, it } from "vitest";
import { checkDuplicateFile, digestBytes, type PriorImportFile } from "./duplicate-files.js";

/**
 * Issue 3.8 — duplicate file detection as a warning signal.
 *
 * Proves: no digest (or no match) yields no signal; a repeated digest
 * yields a repeat signal with every matching import attached; same-name vs
 * renamed repeats are distinguished in the message; matching is
 * case-insensitive on the hex; prior rows with null digests never match;
 * the message always states the non-blocking guarantee; and the digest
 * helper matches the upload pipeline's SHA-256.
 */

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function prior(overrides: Partial<PriorImportFile> = {}): PriorImportFile {
  return {
    importId: "11111111-1111-4111-8111-111111111111",
    fileName: "statement.csv",
    fileSha256: DIGEST_A,
    createdAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("checkDuplicateFile", () => {
  it("returns null when there is nothing to compare or no match", () => {
    expect(checkDuplicateFile([prior()], null)).toBeNull();
    expect(checkDuplicateFile([prior()], undefined)).toBeNull();
    expect(checkDuplicateFile([prior()], "  ")).toBeNull();
    expect(checkDuplicateFile([prior()], DIGEST_B, "statement.csv")).toBeNull();
    expect(checkDuplicateFile([], DIGEST_A, "statement.csv")).toBeNull();
  });

  it("signals a same-name repeat with its match attached", () => {
    const signal = checkDuplicateFile([prior()], DIGEST_A, "statement.csv");
    expect(signal?.isRepeat).toBe(true);
    expect(signal?.sameName).toBe(true);
    expect(signal?.matches).toHaveLength(1);
    expect(signal?.matches[0]?.importId).toBe("11111111-1111-4111-8111-111111111111");
    expect(signal?.message).toContain("already imported once");
    expect(signal?.message).toContain("not duplicated");
  });

  it("names the latest file when the bytes arrive under a new name", () => {
    const signal = checkDuplicateFile(
      [
        prior({ fileName: "august.csv" }),
        prior({ importId: "22222222-2222-4222-8222-222222222222", fileName: "august-2.csv" }),
      ],
      DIGEST_A,
      "september.csv",
    );
    expect(signal?.isRepeat).toBe(true);
    expect(signal?.sameName).toBe(false);
    expect(signal?.matches).toHaveLength(2);
    expect(signal?.message).toContain("2 times");
    expect(signal?.message).toContain("august.csv");
  });

  it("matches digests case-insensitively and skips null-hash priors", () => {
    const signal = checkDuplicateFile(
      [prior({ fileSha256: null }), prior({ fileSha256: DIGEST_A.toUpperCase() })],
      DIGEST_A,
    );
    expect(signal?.matches).toHaveLength(1);
  });

  it("never blocks: the signal is advisory data, not an error", () => {
    const signal = checkDuplicateFile([prior()], DIGEST_A, "statement.csv");
    // No throw, no code, no boolean gate — the wizard renders the message
    // and leaves Continue enabled (asserted in the wizard UI test).
    expect(signal).not.toBeNull();
    expect(typeof signal?.message).toBe("string");
  });
});

describe("digestBytes", () => {
  it("hashes like the upload pipeline", () => {
    expect(digestBytes(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
