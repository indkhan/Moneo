import { z } from "zod";

export const artifactKindSchema = z.enum([
  "spending_explorer",
  "trip_planner",
  "goal_tracker",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const CALCULATOR_RUNTIME = "quickjs-calculator-v1" as const;

// Host-approved SDK operations per artifact kind. These mirror the
// permissions assigned by create_trusted_artifact and constrain which
// live snapshot the host will inject. Generated code never calls the SDK
// directly; the host fetches via lib/artifacts/finance-sdk.ts and passes
// a small JSON snapshot as `input.snapshot`.
export const ALLOWED_SDK_BY_KIND: Record<ArtifactKind, string[]> = {
  spending_explorer: ["spending", "cashflow"],
  trip_planner: ["balances", "goals", "forecast"],
  goal_tracker: ["goals", "balances", "forecast"],
};

export const calculatorManifestSchema = z
  .object({
    kind: artifactKindSchema,
    runtime: z.literal(CALCULATOR_RUNTIME),
    // Declares which host snapshot operations this calculator expects.
    // Must be a subset of the artifact's permissions.
    sdk: z.array(z.string().min(1).max(40)).max(6),
    // Declarative params bound to artifact-local state (sliders/inputs).
    // Host persists them; calculator receives them as input.params.
    params: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
        z.object({
          type: z.enum(["number", "string"]),
          default: z.union([z.number(), z.string()]),
          min: z.number().optional(),
          max: z.number().optional(),
          maxLength: z.number().int().min(1).max(200).optional(),
          label: z.string().max(80).optional(),
        }),
      )
      .default({}),
    renderer: z.literal("trusted").default("trusted"),
  })
  .strict();

export type CalculatorManifest = z.infer<typeof calculatorManifestSchema>;

export const MAX_SOURCE_CHARS = 8000;

// Anything that could reach DOM, network, auth, or module loading is
// forbidden. The sandbox itself (QuickJS) already lacks these globals,
// but static rejection gives clear errors before any execution.
const FORBIDDEN_SOURCE_PATTERNS: { test: RegExp; message: string }[] = [
  { test: /\bwindow\b/, message: "window is not allowed" },
  { test: /\bdocument\b/, message: "document is not allowed" },
  { test: /\bcookie\b/i, message: "cookies are not allowed" },
  { test: /\blocalStorage\b/, message: "localStorage is not allowed" },
  { test: /\bsessionStorage\b/, message: "sessionStorage is not allowed" },
  { test: /\bindexedDB\b/, message: "indexedDB is not allowed" },
  { test: /\bfetch\b/, message: "fetch/network is not allowed" },
  { test: /\bXMLHttpRequest\b/, message: "network is not allowed" },
  { test: /\bWebSocket\b/, message: "network is not allowed" },
  { test: /\bEventSource\b/, message: "network is not allowed" },
  { test: /\bimport\b/, message: "import is not allowed" },
  { test: /\brequire\b/, message: "require is not allowed" },
  { test: /\bexports\b/, message: "modules are not allowed" },
  { test: /\bmodule\b/, message: "modules are not allowed" },
  { test: /\bprocess\b/, message: "process is not allowed" },
  { test: /\bglobalThis\b/, message: "globalThis is not allowed" },
  { test: /(?<![a-zA-Z0-9_$])self(?![a-zA-Z0-9_$])/, message: "self is not allowed" },
  { test: /\bnavigator\b/, message: "navigator is not allowed" },
  { test: /\blocation\b/, message: "location is not allowed" },
  { test: /\bhistory\b/, message: "history is not allowed" },
  { test: /\beval\b/, message: "eval is not allowed" },
  { test: /\bFunction\b/, message: "Function constructor is not allowed" },
  { test: /\bAsyncFunction\b/, message: "AsyncFunction is not allowed" },
  { test: /\bGenerator\b/, message: "generators are not allowed" },
  { test: /\bProxy\b/, message: "Proxy is not allowed" },
  { test: /\bReflect\b/, message: "Reflect is not allowed" },
  { test: /\bAtomics\b/, message: "Atomics is not allowed" },
  { test: /\bSharedArrayBuffer\b/, message: "SharedArrayBuffer is not allowed" },
  { test: /\bWebAssembly\b/, message: "WebAssembly is not allowed" },
  { test: /\bsetTimeout\b/, message: "timers are not allowed" },
  { test: /\bsetInterval\b/, message: "timers are not allowed" },
  { test: /\bqueueMicrotask\b/, message: "timers are not allowed" },
  { test: /\brequestAnimationFrame\b/, message: "timers are not allowed" },
  { test: /\bpostMessage\b/, message: "postMessage is not allowed" },
  { test: /\baddEventListener\b/, message: "DOM events are not allowed" },
  { test: /\binnerHTML\b/, message: "innerHTML is not allowed" },
  { test: /\bouterHTML\b/, message: "outerHTML is not allowed" },
  { test: /\bReact\b/, message: "React is not allowed in the sandbox" },
  { test: /\bcreateElement\b/, message: "DOM creation is not allowed" },
  { test: /\bsupabase\b/i, message: "database access is not allowed" },
  { test: /\bopenrouter\b/i, message: "AI credentials are not allowed" },
  { test: /\bapiKey\b/i, message: "credentials are not allowed" },
  { test: /\bsecret\b/i, message: "secrets are not allowed" },
  { test: /\bpassword\b/i, message: "secrets are not allowed" },
  { test: /\btoken\b/i, message: "tokens are not allowed" },
  { test: /\bauth\b/i, message: "auth handles are not allowed" },
  { test: /\bsdk\b/i, message: "direct SDK handles are not allowed; use input.snapshot" },
  { test: /\bfinance-sdk\b/i, message: "direct SDK imports are not allowed" },
  { test: /__proto__/, message: "__proto__ is not allowed" },
  { test: /\.prototype\b/, message: ".prototype is not allowed" },
  { test: /\.constructor\b/, message: ".constructor is not allowed" },
  { test: /\bexport\b/, message: "export is not allowed" },
  { test: /<script/i, message: "<script> is not allowed" },
  { test: /<iframe/i, message: "<iframe> is not allowed" },
];

export function checkSourceAllowlist(source: string): string[] {
  const errors: string[] = [];
  if (!source || source.trim().length === 0) {
    return ["Source is empty"];
  }
  if (source.length > MAX_SOURCE_CHARS) {
    errors.push(
      `Source is too large (${source.length} chars, max ${MAX_SOURCE_CHARS})`,
    );
  }
  const trimmed = source.trim();
  const looksLikeFunction =
    /=>/.test(trimmed) || /function\s*\(/.test(trimmed);
  if (!looksLikeFunction) {
    errors.push(
      "Source must be a single function expression such as (input) => ({...})",
    );
  }
  for (const { test, message } of FORBIDDEN_SOURCE_PATTERNS) {
    test.lastIndex = 0;
    if (test.test(source)) errors.push(message);
  }
  return errors;
}

export function checkManifest(
  kind: ArtifactKind,
  manifest: unknown,
  permissions: string[],
): { manifest?: CalculatorManifest; errors: string[] } {
  const parsed = calculatorManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${String(i.path.join(".")) || "manifest"}: ${i.message}`) };
  }
  const errors: string[] = [];
  if (parsed.data.kind !== kind) {
    errors.push(`Manifest kind ${parsed.data.kind} does not match artifact kind ${kind}`);
  }
  const allowed = new Set([...(ALLOWED_SDK_BY_KIND[kind] ?? []), ...(permissions ?? [])]);
  for (const op of parsed.data.sdk) {
    if (!allowed.has(op)) {
      errors.push(`Unauthorized Finance SDK operation: ${op}`);
    }
  }
  for (const [name, def] of Object.entries(parsed.data.params)) {
    if (def.type === "number" && typeof def.default !== "number") {
      errors.push(`Param ${name} default must be a number`);
    }
    if (def.type === "string" && typeof def.default !== "string") {
      errors.push(`Param ${name} default must be a string`);
    }
    if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
      errors.push(`Param ${name} min is greater than max`);
    }
  }
  if (errors.length) return { errors };
  return { manifest: parsed.data, errors: [] };
}

// Old artifact-local state stays intact on every edit (the versions RPC
// never touches artifact_state). New code is compatible when every stored
// value still satisfies the new manifest, otherwise defaults apply.
export function checkStateCompatibility(
  state: Record<string, unknown>,
  manifest: CalculatorManifest,
): string[] {
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(state ?? {})) {
    const def = manifest.params[name];
    if (!def) continue; // extra stored keys are preserved, ignored by new code
    if (def.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        warnings.push(`Stored param ${name} is not a number; default applies`);
      } else {
        if (def.min !== undefined && value < def.min) warnings.push(`Stored param ${name} is below min; default applies`);
        if (def.max !== undefined && value > def.max) warnings.push(`Stored param ${name} is above max; default applies`);
      }
    }
    if (def.type === "string") {
      if (typeof value !== "string") {
        warnings.push(`Stored param ${name} is not a string; default applies`);
      } else if (def.maxLength !== undefined && value.length > def.maxLength) {
        warnings.push(`Stored param ${name} is too long; default applies`);
      }
    }
  }
  return warnings;
}
