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
import { securityInput } from "@/lib/scalable/live";
import { scalableActivity, scalablePortfolio, scalableSecurity, scalableWatchlist } from "@/lib/scalable/artifact";

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
  scalable_portfolio: { description: "Scalable Capital portfolio: total, securities, crypto and cash, Scalable's gain per period (returns), and each position (name, shares, price, value, cost, gain). dataFrom says last_sync (with syncedAt) or live.", input: empty, scopes: ["accounts"],
    run: (_: unknown, context: Context) => scalablePortfolio(context) },
  scalable_activity: { description: "Recent Scalable buys, sells, deposits, withdrawals and dividends, newest first (the latest 8 at the last sync, or 20 live).", input: empty, scopes: ["accounts"],
    run: (_: unknown, context: Context) => scalableActivity(context) },
  scalable_watchlist: { description: "The Scalable watchlist with prices and the day's move in %.", input: empty, scopes: ["accounts"],
    run: (_: unknown, context: Context) => scalableWatchlist(context) },
  scalable_security: { description: "Any security on Scalable, live: search by name/ticker/ISIN, its quote, its price chart over a timeframe, or a news summary.", input: securityInput, scopes: ["accounts"],
    run: (input: unknown, context: Context) => scalableSecurity(input as Parameters<typeof scalableSecurity>[0], context) },
} satisfies Record<string, { description: string; input: z.ZodType; scopes: AiDataScope[]; run: (input: unknown, context: Context, shared: QueryShared) => Promise<unknown> }>;
export type ArtifactSource = keyof typeof ARTIFACT_SOURCES;
const SOURCE_KEYS = Object.keys(ARTIFACT_SOURCES) as [ArtifactSource, ...ArtifactSource[]];

/** How artifacts read Scalable now: null when it is not connected, else the Settings choice. */
export type ScalableArtifactAccess = "snapshot" | "live" | null;

/**
 * The sources the builder is offered. Scalable ones only with a connection, and its live-only security source only
 * when Settings allows live data, so the model never sees a source it cannot use.
 */
export function offeredSources(scalable: ScalableArtifactAccess) {
  return SOURCE_KEYS.filter(key => !key.startsWith("scalable_") || (scalable && (key !== "scalable_security" || scalable === "live"))) as [ArtifactSource, ...ArtifactSource[]];
}

/** The sources and their inputs, for the designer's instructions. */
export const sourceGuide = (sources: ArtifactSource[]) => sources.map(key => `- ${key}: ${ARTIFACT_SOURCES[key].description}`).join("\n");

const queriesSchema = (sources: [ArtifactSource, ...ArtifactSource[]]) => z.array(z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/),
  source: z.enum(sources),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict()).max(12).refine(queries => new Set(queries.map(query => query.name)).size === queries.length, "Query names must be unique");
/** Saved queries, any source; a view still fails a Scalable one when Scalable is gone. */
export const artifactQueriesSchema = queriesSchema(SOURCE_KEYS);
/** What the builder may save now. */
export const offeredQueriesSchema = (scalable: ScalableArtifactAccess) => queriesSchema(offeredSources(scalable));
export type ArtifactQuery = z.infer<typeof artifactQueriesSchema>[number];

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

/** Script libraries a page may load, served by Moneo itself (app/artifact-lib), so pages need no internet. */
export const ARTIFACT_LIBRARIES = { "echarts.min.js": "ECharts 6" } as const;
// Pages written before the libraries were local loaded ECharts from jsdelivr; they get the local copy instead.
const CDN_ECHARTS = /https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@[\w.-]+\/dist\/echarts(?:\.min)?\.js/g;

/**
 * The page's own policy: inline code and Moneo's libraries only, no requests of any kind, so nothing in it can send
 * the data it holds anywhere. `origin` is Moneo's (the page itself runs in an opaque, sandboxed origin).
 */
const pageCsp = (origin: string) => `default-src 'none'; script-src 'unsafe-inline' ${origin}/artifact-lib/; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'`;

/**
 * The frame route's header. The page runs inside a second, sandboxed frame of this document, and frame-src 'none'
 * here blocks every navigation of that inner frame: a script, link, form or meta refresh can't load another URL
 * with data in it. Popups and navigating the app itself are blocked by the sandbox (no allow-popups or top navigation).
 */
export const artifactFrameCsp = (origin: string) => `${pageCsp(origin)}; frame-src 'none'; sandbox allow-scripts; frame-ancestors 'self'`;

export type ArtifactTheme = "light" | "dark";

// The app's palette, so a page matches Moneo. Each variable holds a plain colour for the page's theme (not light-dark()),
// so a chart library that reads it with getComputedStyle gets a colour it understands.
const PALETTE: Record<string, [light: string, dark: string]> = { bg: ["#f4f3ee", "#0f1011"], card: ["#fff", "#16171a"], fg: ["#141413", "#eeece6"], muted: ["#5c5d58", "#a3a39e"],
  border: ["#e2e0d8", "#24262a"], accent: ["#4a6400", "#cbf26b"], positive: ["#3f6b00", "#cbf26b"], negative: ["#b42318", "#ff7a6b"],
  "chart-1": ["#4a6400", "#cbf26b"], "chart-2": ["#6d5bd0", "#a99bff"], "chart-3": ["#0e7490", "#67d4e8"], "chart-4": ["#b45309", "#fbbf6b"], "chart-5": ["#9d174d", "#f9a8c9"] };
const palette = (side: 0 | 1) => Object.entries(PALETTE).map(([name, colours]) => `--moneo-${name}:${colours[side]}`).join(";");
const tokens = (theme?: ArtifactTheme) => `:root{--moneo-font:ui-sans-serif,system-ui,sans-serif;--moneo-mono:ui-monospace,Consolas,monospace;${palette(theme === "dark" ? 1 : 0)}}`
  + (theme ? "" : `@media (prefers-color-scheme:dark){:root{${palette(1)}}}`);
// The Moneo kit: a page built from these classes looks like the app without any design work.
const KIT = "*{box-sizing:border-box}body{margin:0;background:var(--moneo-bg);color:var(--moneo-fg);font:15px/1.5 var(--moneo-font)}"
  + ".m-page{max-width:1100px;margin:0 auto;padding:32px 24px;display:grid;gap:20px}.m-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}"
  + ".m-card{background:var(--moneo-card);border:1px solid var(--moneo-border);border-radius:16px;padding:20px}.m-eyebrow{font:500 11px/1.4 var(--moneo-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--moneo-muted)}"
  + ".m-title{font-size:28px;font-weight:600;letter-spacing:-.02em;margin:0}.m-stat{font-size:40px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.1}"
  + ".m-muted{color:var(--moneo-muted)}.m-pos{color:var(--moneo-positive)}.m-neg{color:var(--moneo-negative)}.m-mono{font-family:var(--moneo-mono)}"
  + ".m-row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--moneo-border)}.m-row:last-child{border-bottom:0}"
  + ".m-pill{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--moneo-border);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}.m-pill[aria-pressed=true]{background:var(--moneo-fg);color:var(--moneo-bg)}"
  + "input[type=range]{accent-color:var(--moneo-accent);width:100%}";

/**
 * The frame document: an empty outer page whose only content is the generated page in a sandboxed inner frame. The
 * inner page gets a strict CSP, the fresh data, the app theme and the kit before any generated markup.
 */
export function artifactDocument(html: string, data: Record<string, unknown>, { theme, origin }: { theme?: ArtifactTheme; origin: string }) {
  // Escaping "<" keeps data like "</script>" inside the JSON literal.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const scheme = theme ?? "light dark";
  // A link the designer left in can't go anywhere (navigation is blocked, which would leave an error page), so clicks on links do nothing.
  const head = `<meta http-equiv="Content-Security-Policy" content="${pageCsp(origin)}"><script>window.MONEO_DATA=${json};`
    + `addEventListener("click",e=>{if(e.target instanceof Element&&e.target.closest("a[href]"))e.preventDefault()},true);</script>`
    + `<style>${tokens(theme)}${KIT}:root{color-scheme:${scheme}}</style>`;
  const page = (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + head) : head + html).replace(CDN_ECHARTS, `${origin}/artifact-lib/echarts.min.js`);
  const srcdoc = page.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:${scheme}}html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block;background:transparent}</style></head>`
    + `<body><iframe title="Artifact page" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe></body></html>`;
}
