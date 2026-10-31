import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope, type AiDataScope } from "@/lib/settings";
import { cashflow, financeToolSchemas, getBalances, listAccounts, listGoals, searchTransactions } from "@/lib/finance/tools";
import { investigationSchema } from "@/lib/finance/investigation";
import { loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import type { InvestigationEntities } from "@/lib/finance/investigation";
import { listRecurring } from "@/lib/ai/recurring-proposals";
import { calendarDate } from "@/lib/finance/calendar";
import { readableToolOutput, type EntityNames } from "@/lib/ai/tool-output";

type Context = Awaited<ReturnType<typeof requireWorkspace>>;
const empty = z.object({}).strict();
/** Reads shared by the saved queries of one artifact run. */
type Shared = { entities?: Promise<InvestigationEntities> };
const imports = (context: Context) => context.settings.ai_data_scopes.includes("imports");

// The only data an artifact can see: read-only finance queries the app runs itself. The same
// sources are the builder's tools and the viewer's refresh, so a saved query always reruns.
export const ARTIFACT_SOURCES = {
  investigate: { description: "Spending/income totals, groupings and rankings over exact dates, accounts, categories and merchants.", input: investigationSchema, scopes: ["accounts", "transactions"],
    run: (input: unknown, context: Context, shared?: Shared) => runInvestigation(input, context, { canReadImports: imports(context), entities: shared && (shared.entities ??= loadInvestigationEntities(context)) }) },
  cashflow: { description: "Posted income and spending for a period in one currency.", input: financeToolSchemas.periodInput, scopes: ["transactions"],
    run: (input: unknown, context: Context) => cashflow(input, context, imports(context)) },
  transactions: { description: "Transactions, newest first, filtered by text, dates and amounts (max 50).", input: financeToolSchemas.searchInput, scopes: ["transactions"],
    run: (input: unknown, context: Context) => searchTransactions(input, context) },
  balances: { description: "Current dated account balances.", input: empty, scopes: ["accounts"], run: (_: unknown, context: Context) => getBalances(context, imports(context)) },
  accounts: { description: "The user's accounts.", input: empty, scopes: ["accounts"], run: (_: unknown, context: Context) => listAccounts(context) },
  recurring: { description: "Confirmed recurring payments and income (name, amount, direction, cadence, next date, category) plus detected patterns still awaiting confirmation.", input: empty, scopes: ["planning", "transactions"],
    run: (_: unknown, context: Context) => listRecurring(context) },
  goals: { description: "The user's savings goals.", input: empty, scopes: ["planning"], run: (_: unknown, context: Context) => listGoals(context) },
} satisfies Record<string, { description: string; input: z.ZodType; scopes: AiDataScope[]; run: (input: unknown, context: Context, shared?: Shared) => Promise<unknown> }>;
export type ArtifactSource = keyof typeof ARTIFACT_SOURCES;
const SOURCE_KEYS = Object.keys(ARTIFACT_SOURCES) as [ArtifactSource, ...ArtifactSource[]];

export const artifactQuerySchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/),
  source: z.enum(SOURCE_KEYS),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((query, issue) => {
  const parsed = ARTIFACT_SOURCES[query.source].input.safeParse(query.input);
  if (!parsed.success) issue.addIssue({ code: "custom", message: `${query.name}: ${parsed.error.issues[0]?.message ?? "invalid input"}` });
});
export const artifactQueriesSchema = z.array(artifactQuerySchema).max(12)
  .refine(queries => new Set(queries.map(query => query.name)).size === queries.length, "Query names must be unique");
export type ArtifactQuery = z.infer<typeof artifactQuerySchema>;

/** One source's result as the artifact (and builder) reads it: formatted money, no internal evidence. */
export async function runArtifactSource(source: ArtifactSource, input: unknown, context: Context, shared: Shared = {}) {
  const definition = ARTIFACT_SOURCES[source];
  requireAiScope(context.settings, ...definition.scopes);
  const [output, names] = await Promise.all([definition.run(definition.input.parse(input), context, shared), entityNames(context, shared)]);
  return readableToolOutput(output, names);
}

/** Owned names for the ids in a result (as chat gets them), limited to the scopes AI may read. */
async function entityNames(context: Context, shared: Shared): Promise<EntityNames> {
  const scopes = context.settings.ai_data_scopes;
  if (!scopes.includes("accounts") && !scopes.includes("transactions")) return {};
  const entities = await (shared.entities ??= loadInvestigationEntities(context));
  const byId = (rows: { id: string; name: string }[]) => new Map(rows.map(row => [row.id, row.name]));
  return { ...(scopes.includes("accounts") ? { account: byId(entities.accounts) } : {}), ...(scopes.includes("transactions") ? { category: byId(entities.categories), merchant: byId(entities.merchants) } : {}) };
}

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A query input with each saved from/to date moved forward by days. Page cursors are dropped: they pin the old window. */
export function rollQueryDates(input: unknown, days: number): unknown {
  if (!days) return structuredClone(input);
  if (Array.isArray(input)) return input.map(item => rollQueryDates(item, days));
  if (!input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if ((key === "from" || key === "to") && typeof value === "string" && DATE_VALUE.test(value)) return [key, new Date(Date.parse(value) + days * DAY_MS).toISOString().slice(0, 10)];
    if (key === "page" && value && typeof value === "object" && !Array.isArray(value)) {
      const page = { ...value } as Record<string, unknown>;
      delete page.cursor;
      return [key, rollQueryDates(page, days)];
    }
    return [key, rollQueryDates(value, days)];
  }));
}

/** Runs saved queries fresh; one failing query reports its error instead of hiding the rest. savedOn is the ISO date the version was saved. */
export async function runArtifactQueries(queries: ArtifactQuery[], context: Context, savedOn?: string): Promise<Record<string, unknown>> {
  // Saved periods keep their length and move with time, so an artifact always shows the latest window.
  const days = savedOn ? Math.round((Date.parse(calendarDate(new Date(), context.settings.timezone)) - Date.parse(savedOn)) / DAY_MS) : 0;
  const shared: Shared = {};
  return Object.fromEntries(await Promise.all(queries.map(async query => {
    try { return [query.name, await runArtifactSource(query.source, days > 0 ? rollQueryDates(query.input, days) : query.input, context, shared)]; }
    catch (cause) { return [query.name, { error: cause instanceof Error ? cause.message : "Data unavailable" }]; }
  })));
}

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
/** Sent as a header too: sandbox keeps the page in an opaque origin even if the frame URL is opened directly. */
export const ARTIFACT_FRAME_CSP = `${CSP}; sandbox allow-scripts; frame-ancestors 'self'`;

export type ArtifactView = "page" | "widget";
export type ArtifactTheme = "light" | "dark";

// The app's palette, so a page can match Moneo; light-dark() follows the color-scheme set below.
const TOKENS = ":root{--moneo-bg:light-dark(#f4f3ee,#0f1011);--moneo-card:light-dark(#fff,#16171a);--moneo-fg:light-dark(#141413,#eeece6);--moneo-muted:light-dark(#5c5d58,#a3a39e);"
  + "--moneo-border:light-dark(#e2e0d8,#24262a);--moneo-accent:light-dark(#4a6400,#cbf26b);--moneo-positive:light-dark(#3f6b00,#cbf26b);--moneo-negative:light-dark(#b42318,#ff7a6b);"
  + "--moneo-font:ui-sans-serif,system-ui,sans-serif;--moneo-mono:ui-monospace,Consolas,monospace}";
// Reports the content height so an embedding card can size the frame to fit.
const FIT = "addEventListener('load',function(){if(parent===window)return;var post=function(){parent.postMessage({moneoHeight:document.body.scrollHeight},'*')};new ResizeObserver(post).observe(document.body);post()})";

/** The sandboxed document: a strict CSP, the fresh data and the app theme come before any generated markup. */
export function artifactDocument(html: string, data: Record<string, unknown>, { view = "page", theme }: { view?: ArtifactView; theme?: ArtifactTheme } = {}) {
  // Escaping "<" keeps data like "</script>" inside the JSON literal.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>window.MONEO_DATA=${json};window.MONEO_VIEW="${view}";${FIT}</script>`
    + `<style>${TOKENS}:root{color-scheme:${theme ?? "light dark"}}</style>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + head) : head + html;
}
