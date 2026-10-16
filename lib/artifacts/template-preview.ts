import { evaluateIsolated } from "./isolate";
import { calculatorManifestSchema, normalizeCalculatorParams } from "./spec";
import { fixturesForKind } from "./validate";
import type { LibraryTemplate } from "./library-templates";

const cache = new Map<string, Promise<unknown>>();

// Runs a template in the same QuickJS isolate against synthetic validation
// fixtures, so gallery previews show real output without reading user data.
export function previewTemplate(template: LibraryTemplate): Promise<unknown> {
  if (template.sample || !template.build) return Promise.resolve(template.sample ?? null);
  let preview = cache.get(template.id);
  if (!preview) {
    const { source, manifest: raw } = template.build("2026-10-01");
    const manifest = calculatorManifestSchema.parse(raw);
    const [fixture] = fixturesForKind(template.kind, manifest.sdk, manifest.investigation);
    preview = evaluateIsolated(source, { snapshot: fixture.snapshot, params: normalizeCalculatorParams(manifest, fixture.params, "restore") });
    preview.catch(() => cache.delete(template.id));
    cache.set(template.id, preview);
  }
  return preview;
}
