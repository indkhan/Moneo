import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRequiredResults, assertProductionBuild } from "./acceptance-results.mjs";

const IGNORED_DIRS = new Set([".git", ".next", ".qa", "coverage", "node_modules", "playwright-report", "test-results"]);

describe("required production build provenance", () => {
  const current = { revision: "current", worktreeDirty: false, buildId: "built-current" };
  const fast = { tier: "fast", passed: true, ...current };
  it("accepts the successful clean fast build for the current revision", () => {
    expect(() => assertProductionBuild(fast, current)).not.toThrow();
  });
  it("rejects missing, failed, stale, dirty or replaced build evidence", () => {
    for (const report of [undefined, { ...fast, passed: false }, { ...fast, revision: "older" },
      { ...fast, worktreeDirty: true }, { ...fast, buildId: undefined }, { ...fast, buildId: "replaced" }]) {
      expect(() => assertProductionBuild(report, current)).toThrow(/Run acceptance:fast/);
    }
    for (const state of [{ ...current, worktreeDirty: true }, { ...current, buildId: undefined }]) {
      expect(() => assertProductionBuild(fast, state)).toThrow(/Run acceptance:fast/);
    }
  });
});

function liveDbGates(directory: string): Set<string> {
  const gates = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) for (const gate of liveDbGates(join(directory, entry.name))) gates.add(gate);
    } else if (entry.name.endsWith(".live.test.ts")) {
      const source = readFileSync(join(directory, entry.name), "utf8");
      for (const match of source.matchAll(/process\.env\.(RUN_[A-Z0-9_]*DB_TESTS)/g)) gates.add(match[1]);
    }
  }
  return gates;
}

describe("required acceptance reports", () => {
  it("rejects a successful unit command whose live DB test was skipped", () => {
    expect(() => assertRequiredResults("vitest", { success: true, numTotalTests: 1, numPendingTests: 1, numFailedTests: 0 })).toThrow(/skipped/);
  });
  it("rejects skipped, failed, flaky or empty browser acceptance", () => {
    for (const stats of [{ expected: 1, skipped: 1 }, { expected: 1, unexpected: 1 }, { expected: 1, flaky: 1 }, { expected: 0 }]) {
      expect(() => assertRequiredResults("playwright", { stats })).toThrow();
    }
  });
  it("accepts fully executed successful reports", () => {
    expect(() => assertRequiredResults("vitest", { success: true, numTotalTests: 1, numPendingTests: 0, numFailedTests: 0 })).not.toThrow();
    expect(() => assertRequiredResults("playwright", { stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 } })).not.toThrow();
  });
  it("enables every live DB gate in the required unit run", () => {
    const gates = liveDbGates(".");
    expect(gates.size).toBeGreaterThan(0);
    const runner = readFileSync("scripts/acceptance.mjs", "utf8");
    for (const gate of [...gates].sort()) expect(runner, gate).toContain(`${gate}: "1"`);
  });
  it("serializes required unit files so shared database DDL cannot overlap other live fixtures", () => {
    const runner = readFileSync("scripts/acceptance.mjs", "utf8");
    expect(runner).toMatch(/run\("units",[^\n]*"--no-file-parallelism"/);
  });
});
