// E05-S05 deterministic source validation reusing S01/S02 proof rules.
// Pure functions (no DB/IO) so UI publish and tests share one implementation.
// Runtime sandbox (QuickJS/worker/iframe/CSP) remains the primary boundary;
// static checks are defense-in-depth that produce actionable editor errors.

import { ARTIFACT_LIMITS, RUNTIME_PERMISSIONS, type ArtifactManifest } from "./artifact-contract.ts";

export type ValidateResult =
  | { ok: true }
  | { ok: false; errorClass: string; errorMessage: string };

const FORBIDDEN_HTML = /<(script|iframe|frame|object|embed|applet|form|link|meta|base)\b/i;
const INLINE_EVENT = /\son\w+\s*=/i;
const FORBIDDEN_CSS = /(@import|url\s*\(|expression\s*\(|javascript\s*:|-moz-binding)/i;
const FORBIDDEN_JS =
  /\b(fetch|XMLHttpRequest|WebSocket|window|document|location|localStorage|sessionStorage|indexedDB|navigator|eval|Function|require|process|Deno|Bun)\b|\bimport\s*\(|\bimport\s+.*\s+from\b/;

export function validateSourceSize(html: string, css: string, js: string): ValidateResult {
  const total =
    new TextEncoder().encode(html).byteLength +
    new TextEncoder().encode(css).byteLength +
    new TextEncoder().encode(js).byteLength;
  if (total > ARTIFACT_LIMITS.sourceBytes) {
    return { ok: false, errorClass: "source_too_large", errorMessage: `Source exceeds ${ARTIFACT_LIMITS.sourceBytes} bytes.` };
  }
  return { ok: true };
}

export function validateHtml(source: string): ValidateResult {
  if (FORBIDDEN_HTML.test(source)) {
    return { ok: false, errorClass: "html_rejected", errorMessage: "HTML uses a forbidden element (script/iframe/object/form/link/meta/base)." };
  }
  if (INLINE_EVENT.test(source)) {
    return { ok: false, errorClass: "html_rejected", errorMessage: "Inline event attributes (on*) are not allowed; use data-action controls." };
  }
  return { ok: true };
}

export function validateCss(source: string): ValidateResult {
  if (FORBIDDEN_CSS.test(source)) {
    return { ok: false, errorClass: "css_rejected", errorMessage: "CSS uses a forbidden construct (@import/url/expression/javascript:). Use host fonts/icons/charts." };
  }
  return { ok: true };
}

export function validateJs(source: string): ValidateResult {
  if (FORBIDDEN_JS.test(source)) {
    return { ok: false, errorClass: "js_rejected", errorMessage: "JavaScript uses a forbidden global (network/DOM/storage/eval/Function/import). Use the artifact SDK only." };
  }
  return { ok: true };
}

export function validateManifest(manifest: unknown): ValidateResult {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errorClass: "manifest_invalid", errorMessage: "Manifest must be an object." };
  }
  const m = manifest as Record<string, unknown>;
  for (const key of ["artifactSdkVersion", "runtimeVersion", "sourceSchemaVersion", "stateSchemaVersion", "requestedPermissions", "approvedPermissions", "entrypoints", "resourceBudget"]) {
    if (!(key in m)) {
      return { ok: false, errorClass: "manifest_invalid", errorMessage: `Manifest is missing ${key}.` };
    }
  }
  const approved = m["approvedPermissions"];
  if (!Array.isArray(approved) || approved.some((p) => typeof p !== "string" || !(RUNTIME_PERMISSIONS as readonly string[]).includes(p))) {
    return { ok: false, errorClass: "permission_denied", errorMessage: "Manifest requests an unsupported permission. R1 allows balances.read, analytics.cashflow, analytics.spending_by_category, transactions.summary.read, forecast.read only." };
  }
  return { ok: true };
}

export function validateArtifactSource(
  source: { html: string; css: string; js: string },
  manifest: unknown,
): ValidateResult {
  if (typeof source.html !== "string" || typeof source.css !== "string" || typeof source.js !== "string") {
    return { ok: false, errorClass: "source_invalid", errorMessage: "Source must provide html, css and js strings." };
  }
  const size = validateSourceSize(source.html, source.css, source.js);
  if (!size.ok) return size;
  const html = validateHtml(source.html);
  if (!html.ok) return html;
  const css = validateCss(source.css);
  if (!css.ok) return css;
  const js = validateJs(source.js);
  if (!js.ok) return js;
  return validateManifest(manifest);
}

export type ValidatedManifest = ArtifactManifest;
