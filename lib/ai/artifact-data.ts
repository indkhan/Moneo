import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope, type AiDataScope } from "@/lib/settings";
import { cashflow, evaluateForecast, financeToolSchemas, forecastInput, getBalances, listAccounts, listGoals, listWealth, searchTransactions } from "@/lib/finance/tools";
import { investigationSchema } from "@/lib/finance/investigation";
import { evaluateInvestigationScenario, investigationDetail, investigationDetailSchema, investigationScenarioSchema, loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import type { InvestigationEntities } from "@/lib/finance/investigation";
import { listRecurring } from "@/lib/ai/recurring-proposals";
import { agentFindings } from "@/lib/ai/agent-findings";
import { readableToolOutput, type EntityNames } from "@/lib/ai/tool-output";

type Context = Awaited<ReturnType<typeof requireWorkspace>>;
const empty = z.object({}).strict();
/** Reads shared by every saved query in one render (a page, or all cards on Home). */
export type QueryShared = { entities?: Promise<InvestigationEntities>; results?: Map<string, Promise<unknown>> };
const imports = (context: Context) => context.settings.ai_data_scopes.includes("imports");

// The only data a page or card can see: the read-only finance queries chat uses, run by the app itself. Each
// one is persistable: validated input, the scopes it needs (checked again on every view), and output made
// readable (formatted money, names for ids, no internal evidence).
export const ARTIFACT_SOURCES = {
  investigate: { description: "Spending/income totals, groupings and rankings over exact dates, accounts, categories and merchants.", input: investigationSchema, scopes: ["accounts", "transactions"],
    run: (input: unknown, context: Context, shared: QueryShared) => runInvestigation(input, context, { canReadImports: imports(context), sourceVersions: false, entities: shared.entities ??= loadInvestigationEntities(context) }) },
  cashflow: { description: "Posted income and spending for a period in one currency.", input: financeToolSchemas.periodInput, scopes: ["transactions"],
    run: (input: unknown, context: Context) => cashflow(input, context, imports(context)) },
  transactions: { description: "Transactions, newest first, filtered by text, dates and amounts (max 50).", input: financeToolSchemas.searchInput, scopes: ["transactions"],
    run: (input: unknown, context: Context) => searchTransactions(input, context) },
  detail: { description: "One transaction with its split/fee parts, or a recurring series with its source transactions.", input: investigationDetailSchema, scopes: ["accounts", "transactions"],
    run: (input: unknown, context: Context) => {
      if ((input as { kind?: string }).kind === "recurring") requireAiScope(context.settings, "planning");
      return investigationDetail(input, context, { canReadImports: imports(context) });
    } },
  scenario: { description: "The same investigation compared against hypothetical amount/date/category overrides (read-only what-if).", input: investigationScenarioSchema, scopes: ["accounts", "transactions"],
    run: (input: unknown, context: Context) => evaluateInvestigationScenario(input, context, { canReadImports: imports(context) }) },
  entities: { description: "Account, category and merchant names with ids, plus tags and events.", input: empty, scopes: ["accounts", "transactions"],
    run: (_: unknown, context: Context, shared: QueryShared) => shared.entities ??= loadInvestigationEntities(context) },
  balances: { description: "Current dated account balances.", input: empty, scopes: ["accounts"], run: (_: unknown, context: Context) => getBalances(context, imports(context)) },
  accounts: { description: "The user's accounts.", input: empty, scopes: ["accounts"], run: (_: unknown, context: Context) => listAccounts(context) },
  recurring: { description: "Confirmed recurring payments and income in schedules (name, formatted amount, exact signed amount_minor, currency_code, direction, cadence, next date, category), plus suggestions still awaiting confirmation. Generated code can calculate requested totals and cadence equivalents from schedules; keep currencies separate.", input: empty, scopes: ["planning", "transactions"],
    run: (_: unknown, context: Context) => listRecurring(context) },
  goals: { description: "The user's savings goals.", input: empty, scopes: ["planning"], run: (_: unknown, context: Context) => listGoals(context) },
  wealth: { description: "Money lent to and owed to people, other assets, holdings and debts, with totals per currency.", input: empty, scopes: ["planning"], run: (_: unknown, context: Context) => listWealth(context) },
  forecast: { description: "Day-by-day account headroom and dated funding shortfalls over a horizon.", input: forecastInput, scopes: ["accounts", "transactions", "planning"],
    run: (input: unknown, context: Context) => evaluateForecast(input, context) },
  agent_findings: { description: "What the agent team found in its recent runs: open proposals and each run's briefing.", input: z.object({ includeDecided: z.boolean().optional() }).strict(), scopes: ["transactions"],
    run: (input: unknown, context: Context) => agentFindings(context.supabase, context.workspace.id, input as { includeDecided?: boolean }) },
} satisfies Record<string, { description: string; input: z.ZodType; scopes: AiDataScope[]; run: (input: unknown, context: Context, shared: QueryShared) => Promise<unknown> }>;
export type ArtifactSource = keyof typeof ARTIFACT_SOURCES;
const SOURCE_KEYS = Object.keys(ARTIFACT_SOURCES) as [ArtifactSource, ...ArtifactSource[]];

/** The sources and their inputs, for the designer's instructions. */
export const SOURCE_GUIDE = SOURCE_KEYS.map(key => `- ${key}: ${ARTIFACT_SOURCES[key].description}`).join("\n");

export const artifactQuerySchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/),
  source: z.enum(SOURCE_KEYS),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict();
export const artifactQueriesSchema = z.array(artifactQuerySchema).max(12)
  .refine(queries => new Set(queries.map(query => query.name)).size === queries.length, "Query names must be unique");
export type ArtifactQuery = z.infer<typeof artifactQuerySchema>;

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function monthStart(date: string, offset = 0) {
  const at = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + offset);
  return at.toISOString().slice(0, 10);
}
const monthEnd = (date: string, offset = 0) => shift(monthStart(date, offset + 1), -1);
const yearStart = (date: string, offset = 0) => `${Number(date.slice(0, 4)) + offset}-01-01`;
const weekStart = (date: string) => shift(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** Ranges and values of a card's params, resolved for this view. */
export type ResolvedParams = { values: Record<string, string>; ranges: Record<string, { from: string; to: string }> };

/**
 * Saved inputs keep their meaning over time: a date written as a token resolves against today in the
 * workspace's timezone, so "this month" stays the calendar month. Literal dates stay fixed.
 *   @today  @days_ago:N  @week_start  @month_start[:±N]  @month_end[:±N]  @year_start[:±N]  @year_end[:±N]
 *   @param:name (a choice param's value)  @param:name.from  @param:name.to (a month or period param's range)
 */
export function resolveToken(value: string, today: string, params: ResolvedParams = { values: {}, ranges: {} }): string {
  const param = /^@param:([a-zA-Z_][a-zA-Z0-9_]{0,39})(?:\.(from|to))?$/.exec(value);
  if (param) {
    const [, name, end] = param;
    const resolved = end ? params.ranges[name]?.[end as "from" | "to"] : params.values[name];
    if (resolved === undefined) throw new Error(`Unknown param ${value}`);
    return resolved;
  }
  const token = /^@(today|days_ago|week_start|month_start|month_end|year_start|year_end)(?::(-?\d{1,4}))?$/.exec(value);
  if (!token) return value;
  const n = Number(token[2] ?? 0);
  switch (token[1]) {
    case "today": return shift(today, n);
    case "days_ago": return shift(today, -n);
    case "week_start": return shift(weekStart(today), n * 7);
    case "month_start": return monthStart(today, n);
    case "month_end": return monthEnd(today, n);
    case "year_start": return yearStart(today, n);
    default: return `${Number(today.slice(0, 4)) + n}-12-31`;
  }
}

/** A saved input with every token resolved; page cursors are dropped, since they pin an old evidence set. */
export function resolveQueryInput(input: unknown, today: string, params?: ResolvedParams): unknown {
  if (typeof input === "string") return input.startsWith("@") ? resolveToken(input, today, params) : input;
  if (Array.isArray(input)) return input.map(item => resolveQueryInput(item, today, params));
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "cursor").map(([key, value]) => [key, resolveQueryInput(value, today, params)]));
}

/** Checks saved queries before they are kept: each input, once resolved, must be valid for its source. */
export function checkQueries(queries: ArtifactQuery[], today: string, params?: ResolvedParams) {
  return queries.flatMap(query => {
    try {
      const parsed = ARTIFACT_SOURCES[query.source].input.safeParse(resolveQueryInput(query.input, today, params));
      return parsed.success ? [] : [`${query.name}: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? "invalid input"}`.trim()];
    } catch (cause) { return [`${query.name}: ${cause instanceof Error ? cause.message : "invalid input"}`]; }
  });
}

/** One source's result as a page, card or the builder reads it. Scopes are checked on every run. */
export async function runArtifactSource(source: ArtifactSource, input: unknown, context: Context, shared: QueryShared = {}) {
  const definition = ARTIFACT_SOURCES[source];
  requireAiScope(context.settings, ...definition.scopes);
  const parsed = definition.input.parse(input);
  // Cards on one Home often ask the same thing; one render runs each distinct query once.
  const key = `${source}:${JSON.stringify(parsed)}`;
  const results = shared.results ??= new Map();
  let result = results.get(key);
  if (!result) {
    result = Promise.all([definition.run(parsed, context, shared), entityNames(context, shared)]).then(([output, names]) => readableToolOutput(output, names));
    results.set(key, result);
  }
  return result;
}

/** Owned names for the ids in a result (as chat gets them), limited to the scopes AI may read. */
async function entityNames(context: Context, shared: QueryShared): Promise<EntityNames> {
  const scopes = context.settings.ai_data_scopes;
  if (!scopes.includes("accounts") && !scopes.includes("transactions")) return {};
  const entities = await (shared.entities ??= loadInvestigationEntities(context));
  const byId = (rows: { id: string; name: string }[]) => new Map(rows.map(row => [row.id, row.name]));
  return { ...(scopes.includes("accounts") ? { account: byId(entities.accounts) } : {}), ...(scopes.includes("transactions") ? { category: byId(entities.categories), merchant: byId(entities.merchants) } : {}) };
}

/** Runs saved queries fresh for today; one failing query reports its error instead of hiding the rest. */
export async function runArtifactQueries(queries: ArtifactQuery[], context: Context, today: string, { params, shared = {} }: { params?: ResolvedParams; shared?: QueryShared } = {}): Promise<Record<string, unknown>> {
  return Object.fromEntries(await Promise.all(queries.map(async query => {
    try { return [query.name, await runArtifactSource(query.source, resolveQueryInput(query.input, today, params), context, shared)]; }
    catch (cause) { return [query.name, { error: cause instanceof Error ? cause.message : "Data unavailable" }]; }
  })));
}

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
/** Sent as a header too: sandbox keeps the page in an opaque origin even if the frame URL is opened directly. */
export const ARTIFACT_FRAME_CSP = `${CSP}; sandbox allow-scripts; frame-ancestors 'self'`;

export type ArtifactTheme = "light" | "dark";

// The app's palette, so a page matches Moneo; light-dark() follows the color-scheme set below.
const TOKENS = ":root{--moneo-bg:light-dark(#f4f3ee,#0f1011);--moneo-card:light-dark(#fff,#16171a);--moneo-fg:light-dark(#141413,#eeece6);--moneo-muted:light-dark(#5c5d58,#a3a39e);"
  + "--moneo-border:light-dark(#e2e0d8,#24262a);--moneo-accent:light-dark(#4a6400,#cbf26b);--moneo-positive:light-dark(#3f6b00,#cbf26b);--moneo-negative:light-dark(#b42318,#ff7a6b);"
  + "--moneo-chart-1:light-dark(#4a6400,#cbf26b);--moneo-chart-2:light-dark(#6d5bd0,#a99bff);--moneo-chart-3:light-dark(#0e7490,#67d4e8);--moneo-chart-4:light-dark(#b45309,#fbbf6b);--moneo-chart-5:light-dark(#9d174d,#f9a8c9);"
  + "--moneo-font:ui-sans-serif,system-ui,sans-serif;--moneo-mono:ui-monospace,Consolas,monospace}";
// The Moneo kit: a page built from these classes looks like the app without any design work.
const KIT = "*{box-sizing:border-box}body{margin:0;background:var(--moneo-bg);color:var(--moneo-fg);font:15px/1.5 var(--moneo-font)}"
  + ".m-page{max-width:1100px;margin:0 auto;padding:32px 24px;display:grid;gap:20px}.m-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}"
  + ".m-card{background:var(--moneo-card);border:1px solid var(--moneo-border);border-radius:16px;padding:20px}.m-eyebrow{font:500 11px/1.4 var(--moneo-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--moneo-muted)}"
  + ".m-title{font-size:28px;font-weight:600;letter-spacing:-.02em;margin:0}.m-stat{font-size:40px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.1}"
  + ".m-muted{color:var(--moneo-muted)}.m-pos{color:var(--moneo-positive)}.m-neg{color:var(--moneo-negative)}.m-mono{font-family:var(--moneo-mono)}"
  + ".m-row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--moneo-border)}.m-row:last-child{border-bottom:0}"
  + ".m-pill{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--moneo-border);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}.m-pill[aria-pressed=true]{background:var(--moneo-fg);color:var(--moneo-bg)}"
  + "input[type=range]{accent-color:var(--moneo-accent);width:100%}";

/** The sandboxed document: a strict CSP, the fresh data, the app theme and the kit come before any generated markup. */
export function artifactDocument(html: string, data: Record<string, unknown>, { theme }: { theme?: ArtifactTheme } = {}) {
  // Escaping "<" keeps data like "</script>" inside the JSON literal.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>window.MONEO_DATA=${json};</script>`
    + `<style>${TOKENS}${KIT}:root{color-scheme:${theme ?? "light dark"}}</style>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + head) : head + html;
}
