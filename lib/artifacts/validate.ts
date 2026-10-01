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

const MAX_OUTPUT_CHARS = 20_000;

function isPlainJson(value: unknown, depth = 0): string | null {
  if (depth > 4) return "output is nested too deeply (max 4)";
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return null;
  if (t === "function" || t === "symbol" || t === "undefined")
    return `output contains ${t}, only JSON values are allowed`;
  if (Array.isArray(value)) {
    if (value.length > 50) return "output array has more than 50 items";
    for (const item of value) {
      const err = isPlainJson(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 30) return "output object has more than 30 keys";
    for (const [key, item] of entries) {
      if (key.length > 60) return `output key ${key} is too long`;
      const err = isPlainJson(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  return `output contains ${t}, only JSON values are allowed`;
}

function checkOutputShape(output: unknown): string[] {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return ["Smoke test must return a JSON object such as { summary, rows }"];
  }
  const errors: string[] = [];
  const json = JSON.stringify(output);
  if (json.length > MAX_OUTPUT_CHARS) {
    errors.push(`Output is too large (${json.length} chars, max ${MAX_OUTPUT_CHARS})`);
  }
  const plain = isPlainJson(output);
  if (plain) errors.push(plain);
  const text = json.toLowerCase();
  if (text.includes("<script") || text.includes("<iframe") || text.includes("javascript:")) {
    errors.push("Output contains forbidden markup");
  }
  const record = output as Record<string, unknown>;
  const hasKnownKey =
    "summary" in record || "rows" in record || "numbers" in record ||
    "chart" in record || "unavailable" in record || "warning" in record;
  if (!hasKnownKey) {
    errors.push("Output must include one of: summary, rows, numbers, chart, unavailable, warning");
  }
  if ("summary" in record && record.summary !== undefined && typeof record.summary !== "string") {
    errors.push("Output summary must be a string");
  }
  if (typeof record.summary === "string" && record.summary.length > 500) {
    errors.push("Output summary is too long (max 500 chars)");
  }
  return errors;
}

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
  }

  if (args.source.length > MAX_SOURCE_CHARS) {
    return { ok: false, manifest, errors: [`Source exceeds ${MAX_SOURCE_CHARS} chars`] };
  }
  return { ok: true, manifest, warnings };
}

export function defaultParams(manifest: CalculatorManifest): Record<string, number | string> {
  return Object.fromEntries(Object.entries(manifest.params).map(([k, v]) => [k, v.default]));
}
