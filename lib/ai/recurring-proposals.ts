import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recurringCadences } from "@/lib/finance/cadences";
import { calendarDate } from "@/lib/finance/calendar";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { expandSchedule } from "@/lib/finance/model";
import { wealthAmount } from "@/lib/finance/wealth";
import { liveAccounts } from "@/lib/ai/transaction-proposals";
import { createSchedule, decideSeries, editSchedule, removeSchedule, scheduleFields, seriesSchema, type ScheduleFields, type SeriesDecision } from "@/app/money/recurring/schedules";
import { loadSuggestions, olderRuns, priceChanges, seriesDecision } from "@/app/money/recurring/suggestions";

type Context = { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string }; chatRequestId?: string };

/** The model's view of a recurring change; the application resolves names and turns amounts into exact minor units. */
export const recurringInputSchema = z.object({
  action: z.enum(["add", "change", "remove", "confirm"]).describe("add a new schedule, change or remove an existing one, or confirm a detected suggestion"),
  target: z.string().trim().min(1).max(200).optional().describe("For change/remove: the schedule's name or id. For confirm: the suggestion's label or id from recurring_list"),
  name: z.string().trim().min(1).max(120).optional(),
  amount: z.string().trim().regex(/^\d{1,15}(\.\d{1,4})?$/).optional().describe("Positive decimal amount per payment, e.g. 12.99"),
  direction: z.enum(["out", "in"]).optional().describe("out for bills and subscriptions, in for salary or other income"),
  currency: z.string().regex(/^[A-Z]{3}$/).optional().describe("Needed for add"),
  cadence: z.enum(recurringCadences).optional(),
  nextDate: z.iso.date().optional().describe("The next date it is paid or received"),
  category: z.string().trim().max(100).optional().describe("e.g. Job, Rent, Subscriptions; empty string clears it"),
  account: z.string().trim().min(1).max(120).optional().describe("Account name for add; omit when the currency has one account"),
}).strict();

export const recurringEditSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), accountId: z.uuid(), fields: scheduleFields }).strict(),
  z.object({ action: z.literal("change"), assumptionId: z.uuid(), changes: scheduleFields.partial() }).strict(),
  z.object({ action: z.literal("remove"), assumptionId: z.uuid() }).strict(),
  z.object({ action: z.literal("confirm"), series: seriesSchema, changes: scheduleFields.partial() }).strict(),
]);

type Schedule = { id: string; name: string; amount_minor: string; currency_code: string; cadence: string; starts_on: string; schedule_anchor_on: string | null; account_id: string | null; category: { name: string } | null };

async function activeSchedules({ supabase, workspace }: Context) {
  const { data, error } = await supabase.from("financial_assumptions").select("id, name, amount_minor::text, currency_code, cadence, starts_on, schedule_anchor_on, account_id, category:categories(name)")
    .eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).is("removed_at", null).in("cadence", recurringCadences).order("name").limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as Schedule[];
}

/** One item whose id or name matches; several or none is an error the model relays. */
function pick<T extends { id: string; name: string }>(items: T[], target: string | undefined, what: string) {
  if (!target) throw new Error(`Say which ${what}`);
  const word = target.toLocaleLowerCase("en");
  const exact = items.filter(item => item.id === target || item.name.toLocaleLowerCase("en") === word);
  const found = exact.length ? exact : items.filter(item => item.name.toLocaleLowerCase("en").includes(word));
  if (found.length !== 1) throw new Error(found.length ? `Several ${what}s match "${target}": ${found.map(item => item.name).join(", ")}` : `No ${what} matches "${target}"`);
  return found[0];
}

/** Confirmed schedules and pending suggestions, for the model to name the right one. */
export async function listRecurring(context: Context) {
  const today = calendarDate(new Date(), context.workspace.timezone);
  const money = (minor: string | bigint, currency: string) => formatMoney(minor, currency, context.workspace.locale);
  const [schedules, suggestions] = await Promise.all([activeSchedules(context), loadSuggestions(context.supabase, context.workspace)]);
  return {
    schedules: schedules.map(item => ({ id: item.id, name: item.name, amount: money(item.amount_minor, item.currency_code), direction: item.amount_minor.startsWith("-") ? "out" : "in",
      cadence: item.cadence, next: expandSchedule({ ...item, account_id: item.account_id ?? "unassigned", ends_on: null }, today, 400)[0]?.date ?? null, category: item.category?.name ?? null })),
    suggestions: suggestions.pending.filter(item => item.related.length <= 1).map(({ series }) => ({ id: series.runAnchorId, label: series.label, cadence: series.cadence,
      amount: series.amountMinMinor === series.amountMaxMinor ? money(series.amountMinMinor, series.currencyCode) : `${money(series.amountMinMinor, series.currencyCode)} to ${money(series.amountMaxMinor, series.currencyCode)}`,
      occurrences: series.occurrences })),
  };
}

function signed(amount: string, currency: string, direction: "out" | "in") {
  const minor = wealthAmount(amount, currency);
  if (minor <= 0n) throw new Error("The amount must be above zero");
  return (direction === "out" ? -minor : minor).toString();
}

/** Stores a pending recurring change as a card. Nothing changes until the owner accepts. */
export async function proposeRecurring(context: Context, input: z.infer<typeof recurringInputSchema>) {
  const { supabase, workspace } = context;
  const money = (minor: string, currency: string) => formatMoney(minor, currency, workspace.locale);
  const describe = (fields: Partial<ScheduleFields>, currency: string) => [
    fields.amountMinor && `${money(fields.amountMinor.replace("-", ""), currency)} ${fields.amountMinor.startsWith("-") ? "going out" : "coming in"}`,
    fields.cadence, fields.startsOn && `next on ${fields.startsOn}`, fields.category !== undefined && (fields.category ? `category ${fields.category}` : "no category"),
  ].filter(Boolean).join(", ");
  // Only what the user asked to change; a direction alone flips the current amount's sign.
  const changes = (currency: string, currentMinor?: string): Partial<ScheduleFields> => {
    const direction = input.direction ?? (currentMinor && !currentMinor.startsWith("-") ? "in" : "out");
    const current = currentMinor?.replace("-", "");
    const amountMinor = input.amount ? signed(input.amount, currency, direction) : input.direction && current ? (direction === "out" ? `-${current}` : current) : undefined;
    const fields = { name: input.name, cadence: input.cadence, startsOn: input.nextDate, amountMinor, category: input.category === undefined ? undefined : input.category || null };
    return scheduleFields.partial().parse(Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
  };
  let payload: z.infer<typeof recurringEditSchema>, title: string;
  if (input.action === "add") {
    if (!input.name || !input.amount || !input.currency) throw new Error("Adding needs a name, an amount and a currency");
    const accounts = await liveAccounts(supabase, workspace.id, input.currency);
    const word = input.account?.toLocaleLowerCase("en");
    const pool = word ? accounts.filter(account => account.name.toLocaleLowerCase("en").includes(word)) : accounts;
    if (pool.length !== 1) throw new Error(pool.length ? `Name the ${input.currency} account: ${pool.map(account => account.name).join(", ")}` : `No ${input.currency} account${word ? ` matches "${input.account}"` : ""}`);
    const fields = scheduleFields.parse({ name: input.name, amountMinor: signed(input.amount, input.currency, input.direction ?? "out"), cadence: input.cadence ?? "monthly",
      startsOn: input.nextDate ?? calendarDate(new Date(), workspace.timezone), category: input.category || null });
    payload = { action: "add", accountId: pool[0].id, fields };
    title = `Add recurring ${fields.name}: ${describe(fields, input.currency)}`;
  } else if (input.action === "confirm") {
    const { pending } = await loadSuggestions(supabase, workspace);
    const candidates = pending.filter(item => item.related.length <= 1).map(item => ({ ...item, id: item.series.runAnchorId, name: item.series.label }));
    const chosen = pick(candidates, input.target, "suggestion");
    const series = seriesDecision(chosen);
    const edits = changes(series.currencyCode, chosen.evidence.at(-1)?.amount_minor);
    payload = { action: "confirm", series, changes: edits };
    title = `Confirm ${chosen.name} as recurring (${series.cadence})${Object.keys(edits).length ? `: ${describe(edits, series.currencyCode)}` : ""}`;
  } else {
    const schedule = pick(await activeSchedules(context), input.target, "recurring payment");
    if (input.action === "remove") {
      payload = { action: "remove", assumptionId: schedule.id };
      title = `Remove ${schedule.name} from recurring`;
    } else {
      const edits = changes(schedule.currency_code, schedule.amount_minor);
      if (!Object.keys(edits).length) throw new Error("Say what to change: name, amount, direction, cadence, next date or category");
      payload = { action: "change", assumptionId: schedule.id, changes: edits };
      title = `Change ${schedule.name}: ${[edits.name && `rename to ${edits.name}`, describe(edits, schedule.currency_code)].filter(Boolean).join(", ")}`;
    }
  }
  const { data, error } = await supabase.from("agent_proposals").insert({ workspace_id: workspace.id, agent: "chat", kind: "recurring_edit", ...(context.chatRequestId ? { chat_request_id: context.chatRequestId } : {}),
    conflict_key: `recurring_edit:${crypto.randomUUID()}`, title: title.slice(0, 200), detail: "Recurring payments", payload: recurringEditSchema.parse(payload), confidence: 100 }).select("id").single();
  if (error) throw new Error(error.message);
  return { proposalId: data.id as string, title };
}

/**
 * Decides a detected pattern against its transactions as they are now: a card stores the versions it saw, and a later edit
 * (a category, a new charge) would otherwise fail with "Source changed". Earlier runs at an older price are closed with it.
 */
export async function decideCurrentSeries(context: Context, stored: SeriesDecision, decision: "confirmed" | "dismissed", changes: Partial<ScheduleFields> = {}, requestId?: string) {
  const { candidates, superseded } = await loadSuggestions(context.supabase, context.workspace);
  const found = candidates.find(item => item.series.accountId === stored.accountId && item.series.runAnchorId === stored.runAnchorId);
  await decideSeries(context, found ? seriesDecision(found) : stored, decision, changes, requestId);
  // Best effort: an old run that cannot be closed stays hidden behind the current one anyway.
  for (const older of found ? olderRuns(superseded, found) : []) await decideSeries(context, seriesDecision(older), "dismissed").catch(() => undefined);
}

/** Applies an accepted card through the same functions as the Recurring page; the proposal id is the request id. `edits` are what the person set in the confirm dialog. */
export async function applyRecurringProposal(context: Context, proposalId: string, payload: unknown, edits: Partial<ScheduleFields> = {}) {
  const parsed = recurringEditSchema.parse(payload);
  if (parsed.action === "add") await createSchedule(context, parsed.accountId, parsed.fields);
  else if (parsed.action === "change") await editSchedule(context, parsed.assumptionId, parsed.changes, proposalId);
  else if (parsed.action === "remove") await removeSchedule(context, parsed.assumptionId, proposalId);
  else await decideCurrentSeries(context, parsed.series, "confirmed", { ...parsed.changes, ...edits }, proposalId);
  return { href: "/money/recurring", undo: parsed.action === "add" ? "Remove it on the Recurring page" : "Undo the change in Plan history" };
}

/** "Not recurring" on a detected pattern: the series is dismissed, so neither Home nor the Recurring page suggests it again. */
export async function dismissRecurringProposal(context: Context, proposalId: string, payload: unknown) {
  const parsed = recurringEditSchema.parse(payload);
  if (parsed.action === "confirm") await decideCurrentSeries(context, parsed.series, "dismissed", {}, proposalId);
}

export type RecurringCardDetails = {
  name: string; amount: string; direction: "out" | "in"; cadence: string; startsOn: string; category: string; currencyCode: string;
  transactions: { id: string; date: string; description: string; amountMinor: string }[];
};

/** What a confirm card's dialog and details show, read fresh from detection; null when the pattern is gone (decided elsewhere or its transactions changed). */
export async function recurringCardDetails(context: Context, proposals: { id: string; payload: unknown }[]): Promise<Record<string, RecurringCardDetails | null>> {
  const { candidates } = await loadSuggestions(context.supabase, context.workspace);
  const today = calendarDate(new Date(), context.workspace.timezone);
  return Object.fromEntries(proposals.map(({ id, payload }) => {
    const parsed = recurringEditSchema.safeParse(payload);
    if (!parsed.success || parsed.data.action !== "confirm") return [id, null];
    const { series: stored, changes } = parsed.data;
    const found = candidates.find(item => item.series.accountId === stored.accountId && item.series.runAnchorId === stored.runAnchorId);
    if (!found) return [id, null];
    const { series, evidence, assumption } = found;
    const latest = evidence.at(-1);
    const amount = BigInt(changes.amountMinor ?? latest?.amount_minor ?? series.amountMaxMinor);
    // The next date this pattern is expected, as the Recurring page prefills it.
    const next = latest ? expandSchedule({ account_id: series.accountId, amount_minor: amount.toString(), currency_code: series.currencyCode, cadence: series.cadence,
      starts_on: latest.posted_on, ends_on: null, schedule_anchor_on: series.anchorDate }, today, 400)[0]?.date : undefined;
    const details: RecurringCardDetails = { name: assumption?.name ?? series.label, amount: formatInputAmount(amount < 0n ? -amount : amount, series.currencyCode),
      direction: amount < 0n ? "out" : "in", cadence: series.cadence, startsOn: next ?? today, category: assumption?.category?.name ?? "", currencyCode: series.currencyCode,
      transactions: evidence.slice(-12).reverse().map(row => ({ id: row.id, date: row.posted_on, description: row.description, amountMinor: row.amount_minor })) };
    return [id, details];
  }));
}

const AUTO = ["recurring_new:", "recurring_price:"];
const MAX_NEW = 10;

/**
 * Turns what detection catches into the same recurring_edit cards chat creates: a price change on a confirmed payment
 * (one card per new charge) and new patterns to confirm. Idempotent: the conflict key is unique per workspace, so a
 * dismissed card is never re-raised, and open cards whose cause disappeared (confirmed elsewhere) are closed.
 * Resolves to whether any card was raised or closed.
 */
export async function syncRecurringProposals(context: Context): Promise<boolean> {
  const { supabase, workspace } = context;
  const suggestions = await loadSuggestions(supabase, workspace);
  if (suggestions.queryError || suggestions.storedError || suggestions.detectError) return false;
  const money = (minor: string | bigint, currency: string) => formatMoney(minor, currency, workspace.locale);
  const wanted = [
    ...priceChanges(suggestions.candidates).map(({ series, evidence, schedule, latest }) => {
      const up = BigInt(latest.amount_minor.replace("-", "")) > BigInt(schedule.amount_minor.replace("-", ""));
      return { conflict_key: `recurring_price:${latest.id}`, title: `${schedule.name} went ${up ? "up" : "down"}: update to ${money(latest.amount_minor, series.currencyCode)}`.slice(0, 200),
        detail: `Scheduled ${money(schedule.amount_minor, series.currencyCode)}; charged ${money(latest.amount_minor, series.currencyCode)} on ${latest.posted_on}. Dismiss to keep the current amount.`,
        payload: { action: "confirm" as const, series: seriesDecision({ series, evidence }), changes: { amountMinor: latest.amount_minor } } };
    }),
    ...suggestions.pending.filter(item => item.related.length <= 1).slice(0, MAX_NEW).map(({ series, evidence }) => {
      const latest = evidence.at(-1)?.amount_minor ?? series.amountMaxMinor.toString();
      return { conflict_key: `recurring_new:${series.runAnchorId}`, title: `${series.label}: ${money(latest, series.currencyCode)} ${series.cadence}, confirm as recurring?`.slice(0, 200),
        detail: `${series.occurrences} matching ${latest.startsWith("-") ? "payments" : "incoming payments"} found. You set the amount, date and category when you confirm.`,
        payload: { action: "confirm" as const, series: seriesDecision({ series, evidence }), changes: {} } };
    }),
  ];
  const open = await supabase.from("agent_proposals").select("id, conflict_key").eq("workspace_id", workspace.id).is("run_id", null).eq("kind", "recurring_edit").in("status", ["proposed", "failed"]).limit(200);
  if (open.error) return false;
  const keys = new Set(wanted.map(item => item.conflict_key));
  const stale = (open.data ?? []).filter(row => AUTO.some(prefix => String(row.conflict_key).startsWith(prefix)) && !keys.has(row.conflict_key)).map(row => row.id);
  // A failed write reports no change, so Home does not reload into the same failure again and again.
  const closed = stale.length ? !(await supabase.from("agent_proposals").update({ status: "rejected", decided_at: new Date().toISOString(), result: { stale: true } }).eq("workspace_id", workspace.id).in("id", stale).in("status", ["proposed", "failed"])).error : false;
  // Each cause is raised once: already open, accepted or dismissed keys are skipped (the unique key also guards races).
  const seen = wanted.length ? await supabase.from("agent_proposals").select("conflict_key").eq("workspace_id", workspace.id).is("run_id", null).in("conflict_key", [...keys]) : { data: [], error: null };
  if (seen.error) return false;
  const raised = new Set((seen.data ?? []).map(row => row.conflict_key));
  const fresh = wanted.filter(item => !raised.has(item.conflict_key));
  const raisedNew = fresh.length ? !(await supabase.from("agent_proposals").insert(fresh.map(item => ({ workspace_id: workspace.id, agent: "chat", kind: "recurring_edit", confidence: 100, ...item, payload: recurringEditSchema.parse(item.payload) })))).error : false;
  return closed || raisedNew;
}

/** Open recurring cards raised by detection, newest first; prefix narrows to price changes or new patterns. */
export async function openRecurringProposals(supabase: SupabaseClient, workspaceId: string, prefixes = AUTO) {
  const { data } = await supabase.from("agent_proposals").select("id, title, detail, conflict_key").eq("workspace_id", workspaceId).is("run_id", null).eq("kind", "recurring_edit")
    .in("status", ["proposed", "failed"]).order("created_at", { ascending: false }).limit(50);
  return (data ?? []).filter(row => prefixes.some(prefix => String(row.conflict_key).startsWith(prefix))) as { id: string; title: string; detail: string; conflict_key: string }[];
}
