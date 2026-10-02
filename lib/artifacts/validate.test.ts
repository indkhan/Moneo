import { describe, expect, it } from "vitest";
import { checkManifest, checkSourceAllowlist, checkStateCompatibility } from "./spec";
import { FALLBACK_CALCULATORS } from "./templates";
import { validateGeneratedCandidate } from "./validate";
import { evaluateIsolated } from "./isolate";

describe("generated calculator allowlist", () => {
  it("accepts a tiny pure calculator", () => {
    expect(checkSourceAllowlist("(input) => ({ summary: 'hi' })")).toEqual([]);
  });
  it("rejects DOM, network, DB, and credential access", () => {
    for (const bad of [
      "(input) => window.x",
      "(input) => document.title",
      "(input) => fetch('https://x')",
      "(input) => eval('1')",
      "(input) => new Function('1')",
      "import x from 'y'; (input) => x",
      "(input) => require('fs')",
      "(input) => supabase.from('x')",
      "(input) => input.token",
      "(input) => localStorage.getItem('a')",
      "(input) => { return <script>alert(1)</script>; }",
      "(input) => React.createElement('div')",
      "(input) => globalThis.x",
      "(input) => self.x",
    ]) {
      expect(checkSourceAllowlist(bad), bad).not.toEqual([]);
    }
  });
  it("rejects oversized and non-function sources", () => {
    expect(checkSourceAllowlist("42")).toContain(
      "Source must be a single function expression such as (input) => ({...})",
    );
    expect(checkSourceAllowlist("(input) => 1".padEnd(8001, " "))[0]).toMatch(/too large/);
  });
});

describe("generated calculator manifest", () => {
  it("supports custom purposes with only reviewed host operations and unchanged sandbox rejection", () => {
    for (const kind of ["custom_planner", "custom_tracker", "custom_report", "custom_comparison"] as const) {
      const manifest = { kind, runtime: "quickjs-calculator-v1", sdk: ["spending"], params: {} };
      expect(checkManifest(kind, manifest, ["spending"]).errors).toEqual([]);
      expect(checkManifest(kind, manifest, []).errors.join(";")).toMatch(/Unauthorized/);
      expect(checkManifest(kind, { ...manifest, sdk: ["transactions_raw"] }, ["transactions_raw"]).errors.join(";")).toMatch(/Unauthorized/);
      expect(checkSourceAllowlist("(input) => fetch('https://example.invalid')")).not.toEqual([]);
    }
  });
  it("rejects kind mismatch and unauthorized SDK calls", () => {
    const kindMismatch = checkManifest(
      "trip_planner",
      { kind: "spending_explorer", runtime: "quickjs-calculator-v1", sdk: [], params: {} },
      ["balances", "goals", "forecast"],
    );
    expect(kindMismatch.errors.join(";")).toMatch(/does not match/);
    const unauthorized = checkManifest(
      "spending_explorer",
      { kind: "spending_explorer", runtime: "quickjs-calculator-v1", sdk: ["balances"], params: {} },
      ["spending", "cashflow"],
    );
    expect(unauthorized.errors.join(";")).toMatch(/Unauthorized/);
  });
  it("accepts a matching manifest", () => {
    const ok = checkManifest(
      "spending_explorer",
      FALLBACK_CALCULATORS.spending_explorer.manifest,
      ["spending", "cashflow"],
    );
    expect(ok.errors).toEqual([]);
  });
  it("flags incompatible stored state without wiping it", () => {
    const ok = checkManifest(
      "trip_planner",
      FALLBACK_CALCULATORS.trip_planner.manifest,
      ["balances", "goals", "forecast"],
    );
    expect(ok.manifest).toBeDefined();
    expect(
      checkStateCompatibility({ costMinor: "not-a-number" }, ok.manifest!),
    ).toMatchObject([expect.stringContaining("costMinor")]);
    expect(checkStateCompatibility({ costMinor: 100 }, ok.manifest!)).toEqual([]);
  });
});

describe("generated calculator smoke validation", () => {
  it("rejects invalid output in an allowed cashflow branch before activation", async () => {
    const result = await validateGeneratedCandidate({
      kind: "custom_tracker",
      source: `(input) => input.snapshot.cashflow ? { summary: { period: "2026-09" } } : { unavailable: "No cashflow" }`,
      manifest: { kind: "custom_tracker", runtime: "quickjs-calculator-v1", sdk: ["cashflow"], params: {}, renderer: "trusted" },
      permissions: ["cashflow"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(";")).toContain("Output summary must be a string");
  });

  it("keeps fallback financial arithmetic exact beyond JavaScript's numeric ceiling", async () => {
    expect(await evaluateIsolated(FALLBACK_CALCULATORS.trip_planner.source, { snapshot: { baselineAvailableMinor: "9007199254740993" }, params: { costMinor: 1 } }))
      .toMatchObject({ numbers: { remainingMinor: "9007199254740992" } });
    expect(await evaluateIsolated(FALLBACK_CALCULATORS.spending_explorer.source, { snapshot: { spendingMinor: "9007199254740993", daily: [{ date: "2026-10-01", spendingMinor: "9007199254740993" }] }, params: {} }))
      .toMatchObject({ numbers: { averageMinorPerDay: "9007199254740993" } });
  });
  it("validates the three fallback calculators (normal, empty, missing-data)", async () => {
    for (const kind of ["spending_explorer", "trip_planner", "goal_tracker", "custom_planner", "custom_tracker", "custom_report", "custom_comparison"] as const) {
      const fb = FALLBACK_CALCULATORS[kind];
      const result = await validateGeneratedCandidate({
        kind,
        source: fb.source,
        manifest: fb.manifest,
      });
      expect(result, kind).toMatchObject({ ok: true });
    }
  }, 20000);

  it("fails when missing data throws instead of returning unavailable", async () => {
    const result = await validateGeneratedCandidate({
      kind: "trip_planner",
      source: `(input) => { if (input.snapshot.baselineAvailableMinor === null) throw new Error('boom'); return { summary: 'x' }; }`,
      manifest: FALLBACK_CALCULATORS.trip_planner.manifest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(";")).toMatch(/Missing-data/);
  });

  it("fails on non-object output and preserves the failed signal for the caller", async () => {
    const result = await validateGeneratedCandidate({
      kind: "goal_tracker",
      source: `(input) => 42`,
      manifest: FALLBACK_CALCULATORS.goal_tracker.manifest,
    });
    expect(result.ok).toBe(false);
    // The versions API maps ok:false to status='failed' and keeps the
    // prior active version via save_generated_artifact_version.
  });

  it("rejects caught calculation failures for complete local inputs before activation", async () => {
    const result = await validateGeneratedCandidate({ kind: "custom_comparison", source: `(input) => { try { const safe = (value) => { const n = n >= 0 ? value : 0; return BigInt(n); }; return {numbers:{amount:safe(input.params.costMinor).toString()}}; } catch (_) { return {unavailable:"Unable to compare"}; } }`,
      manifest: { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: { costMinor: { type: "number", default: 10000, min: 0, max: 10000000 } }, renderer: "trusted" }, permissions: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(";")).toContain("Normal-input test returned unavailable");
  });

  it("fails an infinite loop via the QuickJS interrupt", async () => {
    const result = await validateGeneratedCandidate({
      kind: "spending_explorer",
      source: `(input) => { while (true) {} }`,
      manifest: FALLBACK_CALCULATORS.spending_explorer.manifest,
    });
    expect(result.ok).toBe(false);
  }, 20000);
});
