import type { LogArea, LogLevel } from "./options";

export type LogEntryView = {
  id: string; created_at: string; level: LogLevel; area: LogArea; event: string; message: string; details: unknown;
  conversation_id: string | null; usage_id: string | null; agent_run_id: string | null; job_id: string | null; audio_path: string | null;
};
export type ReportEntry = { time: string; level: LogLevel; area: LogArea; event: string; message: string; details?: unknown; links?: Record<string, string>; audio?: "not included" };

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authori[sz]ation|cookie|credential|session|^key$|private/i;
const AMOUNT_KEY = /amount|balance|_minor$|^minor|price|value$|total$|cost|salary|income|limit/i;
const NAME_KEY = /name$|^name|merchant|counterpart|payee|payer|creditor|debtor|description|title|account$|holder|owner|email|iban|bic/i;
const FREE_TEXT_KEY = /^(text|reasoning|thinking|prompt|content|transcript|messages|reply|input|output|instructions|system|query|body|words)$/i;
const SAFE_KEY = /^(model|modelId|model_id|engine|task|status|stage|kind|finishReason|finish_reason|toolName|tool_name|level|area|event|code|errorName|error_kind|durationMs|duration_ms|chars)$/i;

const CURRENCY = String.raw`(?:[€$£¥₹₣]|\b(?:EUR|USD|GBP|CHF|JPY|SEK|NOK|DKK|PLN|CZK|HUF|INR|CAD|AUD)\b)`;
const PROTECTED = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
];
const REPLACEMENTS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[secret]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]"],
  [/\b(?:bearer|basic)\s+[\w.~+/=-]{8,}/gi, "[secret]"],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]+)?/g, "[secret]"],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|sess|AKIA)[-_][\w-]{8,}/g, "[secret]"],
  [/\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|client[-_]?secret|key)\s*[=:]\s*)["']?[^\s"'&,;]+/gi, "$1[secret]"],
  [/(?<![\w+/-])[A-Za-z0-9+/_-]{32,}={0,2}(?![\w+/-])/g, "[secret]"],
  [/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g, "[iban]"],
  [new RegExp(String.raw`${CURRENCY}\s?[-−+]?\d(?:[\d.,'’\s]*\d)?`, "g"), "[amount]"],
  [new RegExp(String.raw`[-−+]?\d(?:[\d.,'’ ]*\d)?\s?${CURRENCY}`, "g"), "[amount]"],
  [/(?<![\w.])[-−]?\d{1,3}(?:[.,'’ ]\d{3})*[.,]\d{2}(?!\d)/g, "[amount]"],
  [/(?<![\w-])\d(?:[ -]?\d){7,}(?![\w-])/g, "[number]"],
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactText(text: string, names: readonly string[] = []): string {
  const kept: string[] = [];
  let out = text;
  for (const pattern of PROTECTED) out = out.replace(pattern, match => `\u0000${kept.push(match) - 1}\u0000`);
  const known = [...new Set(names.map(name => name.trim()).filter(name => name.length >= 3))].sort((a, b) => b.length - a.length);
  for (const name of known) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu"), "[name]");
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => kept[Number(index)] ?? "");
}

export function redactValue(value: unknown, names: readonly string[] = [], key = ""): unknown {
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (key && !SAFE_KEY.test(key)) {
    if (SECRET_KEY.test(key)) return "[secret]";
    if (FREE_TEXT_KEY.test(key)) return typeof value === "string" ? `[text, ${value.length} chars]` : "[text]";
    if (AMOUNT_KEY.test(key) && (typeof value === "number" || typeof value === "string")) return "[amount]";
    if (NAME_KEY.test(key) && (typeof value === "string" || typeof value === "number")) return "[name]";
  }
  if (typeof value === "number") return value;
  if (typeof value === "string") return redactText(value, names);
  if (Array.isArray(value)) return value.map(item => redactValue(item, names, key));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, redactValue(item, names, field)]));
  return "[value]";
}

export function redactEntries(entries: readonly LogEntryView[], names: readonly string[] = []): ReportEntry[] {
  return entries.map(entry => {
    const links = Object.fromEntries(([["conversation", entry.conversation_id], ["usage", entry.usage_id], ["agent_run", entry.agent_run_id], ["job", entry.job_id]] as const)
      .flatMap(([label, id]) => id ? [[label, id]] : []));
    return {
      time: entry.created_at, level: entry.level, area: entry.area, event: entry.event, message: redactText(entry.message, names),
      ...(entry.details === null || entry.details === undefined ? {} : { details: redactValue(entry.details, names) }),
      ...(Object.keys(links).length ? { links } : {}),
      ...(entry.audio_path ? { audio: "not included" as const } : {}),
    };
  });
}

export function reportText(entries: readonly ReportEntry[], header: string): string {
  const lines = entries.map(entry => {
    const extra = [
      entry.details === undefined ? null : `  details: ${JSON.stringify(entry.details)}`,
      entry.links ? `  links: ${JSON.stringify(entry.links)}` : null,
      entry.audio ? "  audio: not included" : null,
    ].filter((line): line is string => line !== null);
    return [`${entry.time} ${entry.level.toUpperCase()} [${entry.area}] ${entry.event}: ${entry.message}`, ...extra].join("\n");
  });
  return [header, "", ...lines].join("\n");
}
