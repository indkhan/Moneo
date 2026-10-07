import { investigationSchema } from "@/lib/finance/investigation";

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
    sort: first("sort") || "absolute-delta-desc", currencyPolicy: first("currencyMode") === "base" ? { mode: "base", currency: first("currency") } : { mode: "original", ...(first("currency") ? { currencies: [first("currency")] } : {}) },
  });
}
