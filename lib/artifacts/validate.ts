import { checkOutputShape } from "./output";
import { evaluateIsolated } from "./isolate";
import {
  ALLOWED_SDK_BY_KIND,
  CALCULATOR_RUNTIME,
  MAX_SOURCE_CHARS,
  checkManifest,
  checkSourceAllowlist,
  checkStateCompatibility,
  type ArtifactKind,
  type CalculatorManifest,
} from "./spec";

export type CalculatorInput = {
  snapshot: unknown;
  params: Record<string, number | string>;
};

export type ValidationResult =
  | { ok: true; manifest: CalculatorManifest; warnings: string[] }
  | { ok: false; errors: string[]; manifest?: CalculatorManifest };

export function fixturesForKind(kind: ArtifactKind): CalculatorInput[] {
  const base = { runtime: CALCULATOR_RUNTIME };
  if (kind.startsWith("custom_")) return [
    { snapshot: { ...base, currency: "EUR", spending: { spendingMinor: "80000", incomeMinor: "120000", netMinor: "40000" }, balances: [{ id: "a", currency_code: "EUR", balance: { amount_minor: "150000", status: "current" } }], goals: [{ id: "g", currency: "EUR", targetMinor: "10000", savedMinor: "2500", remainingMinor: "7500" }], forecast: { currency: "EUR", baselineAvailableMinor: "150000" } }, params: {} },
    { snapshot: { ...base, currency: "EUR", spending: { spendingMinor: "0", incomeMinor: "0", netMinor: "0" }, balances: [], goals: [], forecast: { unavailable: "No dated balance" } }, params: {} },
    { snapshot: { ...base, unavailable: "Requested financial evidence is unavailable" }, params: {} },
  ];
  if (kind === "spending_explorer") {
    return [
      { snapshot: { ...base, currency: "EUR", incomeMinor: "120000", spendingMinor: "80000", netMinor: "40000", daily: [{ date: "2026-09-01", spendingMinor: "1200" }] }, params: {} },
      { snapshot: { ...base, currency: "EUR", incomeMinor: "0", spendingMinor: "0", netMinor: "0", daily: [] }, params: {} },
      { snapshot: { ...base, currency: "EUR", unavailable: "Some transactions require currency conversion" }, params: {} },
    ];
  }
  if (kind === "trip_planner") {
    return [
      { snapshot: { ...base, currency: "EUR", baselineAvailableMinor: "150000", tripDate: "2026-10-03" }, params: { costMinor: 90000 } },
      { snapshot: { ...base, currency: "EUR", baselineAvailableMinor: "0", tripDate: "2026-10-03" }, params: { costMinor: 0 } },
      { snapshot: { ...base, currency: "EUR", baselineAvailableMinor: null, unavailable: "A dated balance in the display currency is required", tripDate: "2026-10-03" }, params: { costMinor: 90000 } },
    ];
  }
  return [
    { snapshot: { ...base, currency: "EUR", goals: [{ id: "g1", name: "Japan", targetMinor: "350000", savedMinor: "50000", remainingMinor: "300000" }] }, params: { extraMonthlyMinor: 10000 } },
    { snapshot: { ...base, currency: "EUR", goals: [] }, params: { extraMonthlyMinor: 0 } },
    { snapshot: { ...base, currency: "EUR", goals: [], unavailable: "No goals yet" }, params: { extraMonthlyMinor: 10000 } },
  ];
}

export async function validateGeneratedCandidate(args: {
  kind: ArtifactKind;
  source: string;
  manifest: unknown;
  permissions?: string[];
  state?: Record<string, unknown>;
}): Promise<ValidationResult> {
  const errors: string[] = [];
  errors.push(...checkSourceAllowlist(args.source));
  const manifestCheck = checkManifest(args.kind, args.manifest, args.permissions ?? ALLOWED_SDK_BY_KIND[args.kind] ?? []);
  errors.push(...manifestCheck.errors);
  if (errors.length) return { ok: false, errors, manifest: manifestCheck.manifest };

  const manifest = manifestCheck.manifest!;
  const warnings = checkStateCompatibility(args.state ?? {}, manifest);

  // Smoke-run inside QuickJS with normal, empty, and missing-data fixtures.
  // Missing-data fixtures must not throw: return { unavailable } instead.
  for (let i = 0; i < 3; i++) {
    const fixture = fixturesForKind(args.kind)[i];
    const params: Record<string, number | string> = {};
    for (const [name, def] of Object.entries(manifest.params)) {
      params[name] = def.default;
    }
    Object.assign(params, fixture.params);
    let output: unknown;
    try {
      output = await evaluateIsolated(args.source, {
        snapshot: fixture.snapshot,
        params,
      });
    } catch (error) {
      return {
        ok: false,
        manifest,
        errors: [
          i === 2
            ? `Missing-data handling failed: ${error instanceof Error ? error.message : String(error)} (return { unavailable } instead of throwing)`
            : `Smoke test ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    const shapeErrors = checkOutputShape(output);
    if (shapeErrors.length) {
      return { ok: false, manifest, errors: shapeErrors.map((e) => `Smoke test ${i + 1}: ${e}`) };
    }
    if (i === 0 && manifest.sdk.length === 0 && Object.values(params).every(value => typeof value !== "string" || value.trim().length > 0)) {
      const normal = output as Record<string, unknown>;
      if (normal.unavailable && !normal.summary && !normal.numbers && !normal.chart && !normal.rows) {
        return { ok: false, manifest, errors: ["Normal-input test returned unavailable despite complete local inputs; check the calculation before saving"] };
      }
    }
  }

  if (args.source.length > MAX_SOURCE_CHARS) {
    return { ok: false, manifest, errors: [`Source exceeds ${MAX_SOURCE_CHARS} chars`] };
  }
  return { ok: true, manifest, warnings };
}

export function defaultParams(manifest: CalculatorManifest): Record<string, number | string> {
  return Object.fromEntries(Object.entries(manifest.params).map(([k, v]) => [k, v.default]));
}
