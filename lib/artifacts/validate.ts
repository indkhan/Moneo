import { snapshotFixtures } from "./fixtures";
import { checkOutputShape } from "./output";
import { evaluateIsolated } from "./isolate";
import {
  ALLOWED_SDK_BY_KIND,
  MAX_SOURCE_CHARS,
  checkManifest,
  checkSourceAllowlist,
  checkStateCompatibility,
  normalizeCalculatorParams,
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

export function fixturesForKind(kind: ArtifactKind, sdk: string[] = []): CalculatorInput[] {
  return snapshotFixtures(kind, sdk);
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

  // Exercise exactly the manifest's host contract, including absent operations,
  // nullable evidence, partial inputs, currencies and bounded cardinalities.
  const fixtures = fixturesForKind(args.kind, manifest.sdk);
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    const params = normalizeCalculatorParams(manifest, fixture.params, "restore");
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
          fixture.snapshot !== null && typeof fixture.snapshot === "object" && "unavailable" in fixture.snapshot
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
  return { ok: true, manifest, warnings: [...warnings, "Validation checks execution and output shape, not the accuracy of generated financial claims."] };
}

export function defaultParams(manifest: CalculatorManifest): Record<string, number | string> {
  return normalizeCalculatorParams(manifest);
}
