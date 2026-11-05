import { investigationSchema } from "@/lib/finance/investigation";

/** The first thing wrong with typed period fields, in words, so the page never shows raw validation output. */
export function periodProblem(params: Record<string, string | string[] | undefined>) {
  const value = (key: string) => { const raw = params[key]; return (Array.isArray(raw) ? raw[0] : raw) || ""; };
  const real = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
  const names: Record<string, string> = { from: "From", to: "To", comparisonFrom: "Compare from", comparisonTo: "Compare to" };
  for (const key of Object.keys(names)) if (value(key) && !real(value(key))) return `${names[key]} isn’t a real date. Use year, month and day.`;
  if (value("from") && value("to") && value("from") > value("to")) return "From must be on or before To.";
  if (Boolean(value("comparisonFrom")) !== Boolean(value("comparisonTo"))) return "A comparison needs both Compare from and Compare to.";
  if (value("comparisonFrom") > value("comparisonTo")) return "Compare from must be on or before Compare to.";
  return "Check the period: use real dates, with From on or before To.";
}

/** Whether a submitted form left every box of a group unticked, so the default was used instead. */
export function defaultedChoices(params: Record<string, string | string[] | undefined>) {
  if (!params.metric) return [];
  return [...(params.statuses ? [] : ["Posted is used because no status was ticked"]), ...(params.kinds ? [] : ["Regular and Refund are used because no type was ticked"])];
}

export function parseInvestigationParams(params: Record<string, string | string[] | undefined>, fallback: { from: string; to: string }) {
  const first = (key: string) => Array.isArray(params[key]) ? params[key][0] : params[key];
  if (first("query")) {
    const text = first("query")!;
    if (text.length > 65_536) throw new Error("Investigation request too large");
    return investigationSchema.parse(JSON.parse(text));
  }
  const list = (key: string) => (Array.isArray(params[key]) ? params[key] : params[key] ? [params[key]] : []) as string[];
  const labelList = (key: string) => first(key)?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
  const entityFilter = (key: string) => ({ include: list(key).filter(Boolean).map(id => ({ id })), exclude: list(`exclude${key}`).filter(Boolean).map(id => ({ id })) });
  return investigationSchema.parse({ version: 1,
    period: { from: first("from") || fallback.from, to: first("to") || fallback.to },
    ...(first("comparisonFrom") || first("comparisonTo") ? { comparison: { from: first("comparisonFrom"), to: first("comparisonTo") } } : {}),
    accounts: entityFilter("accounts"), categories: entityFilter("categories"), merchants: entityFilter("merchants"),
    tags: { include: labelList("tags"), exclude: labelList("excludeTags") }, events: { include: labelList("events"), exclude: labelList("excludeEvents") },
    groupBy: list("groupBy"), metric: first("metric") || "spending", classifications: first("classifications") || "resolved",
    statuses: list("statuses").length ? list("statuses") : ["posted"], kinds: list("kinds").length ? list("kinds") : ["ordinary", "refund"],
    sort: first("sort") || "absolute-delta-desc", currencyPolicy: first("currencyMode") === "base" ? { mode: "base", currency: first("currency")?.toUpperCase() } : { mode: "original", ...(first("currency") ? { currencies: [first("currency")!.toUpperCase()] } : {}) },
  });
}
