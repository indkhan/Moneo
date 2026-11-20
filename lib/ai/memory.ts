import { z } from "zod";
import type { ReadonlyDb } from "@/lib/database";
import { MEMORY_KINDS, MEMORY_KIND_LABELS, type MemoryKind } from "@/lib/ai/memory-note";
import { calendarDate } from "@/lib/finance/calendar";

export type MemoryRow = {
  id: string; kind: MemoryKind; statement: string; quote: string | null; status: "suggested" | "active" | "replaced" | "ended";
  valid_from: string | null; valid_until: string | null; ended_on: string | null; replaces: string | null;
  conversation_id: string | null; saved_by: "ai" | "owner"; created_at: string; closed_at: string | null;
};
export const MEMORY_COLUMNS = "id, kind, statement, quote, status, valid_from, valid_until, ended_on, replaces, conversation_id, saved_by, created_at, closed_at";

const day = z.iso.date();
const ownerWords = z.string().trim().min(3).max(300).describe("At least three words copied exactly from the owner's message in this turn that this comes from");
export const memorySaveInput = z.object({
  kind: z.enum(MEMORY_KINDS).describe("pledge: a promise about their own money behaviour; plan: something they expect to happen; fact: background about their life; explanation: why a payment, payee or transfer is what it is; preference: how they want you to talk or present things"),
  statement: z.string().trim().min(3).max(300).describe("The memory as one short third-person sentence, e.g. \"Cutting out food delivery to save for the gym\""),
  quote: ownerWords,
  sure: z.boolean().describe("false only when it seems important but you are unsure what they meant; they are then asked before it is kept"),
  from: day.optional().describe("First day it is true, when they said one"),
  until: day.optional().describe("Last day it is true, when they said one, e.g. the end of \"this month\""),
  replaces: z.uuid().optional().describe("Id of the remembered memory this updates or contradicts; the old one is kept as history"),
}).strict();
export const memoryEndInput = z.object({ id: z.uuid(), quote: ownerWords, on: day.optional().describe("The last day it was true, when they said one, e.g. \"I stopped freelancing in March\"") }).strict();
export const memorySearchInput = z.object({
  query: z.string().trim().min(2).max(200),
  includePast: z.boolean().optional().describe("Also return replaced and ended memories"),
}).strict();
export const memoryHistoryInput = z.object({ since: day.optional().describe("Only changes from this day on") }).strict();
export const memoryCiteInput = z.object({ ids: z.array(z.uuid()).min(1).max(20) }).strict();

const KIND_ORDER: MemoryKind[] = ["preference", "pledge", "plan", "fact", "explanation"];
const PLAN_HORIZON_DAYS = 90;
export const MEMORY_BRIEF_CHARS = 6000;

const plusDays = (isoDay: string, days: number) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const quoted = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());

export function isCurrent(row: Pick<MemoryRow, "status" | "valid_until">, today: string) {
  return row.status === "active" && !(row.valid_until && row.valid_until < today);
}

export function memoryBrief(rows: MemoryRow[], today: string, budget = MEMORY_BRIEF_CHARS) {
  const waiting = rows.filter(row => row.status === "suggested").slice(0, 10);
  const horizon = plusDays(today, PLAN_HORIZON_DAYS);
  const order = (row: MemoryRow) => KIND_ORDER.indexOf(row.kind);
  const current = rows.filter(row => isCurrent(row, today) && !(row.kind === "plan" && row.valid_from && row.valid_from > horizon))
    .sort((a, b) => order(a) - order(b) || (a.kind === "plan" ? (a.valid_from ?? "").localeCompare(b.valid_from ?? "") : b.created_at.localeCompare(a.created_at)));
  const header = "Memories (what the owner told you about themselves, in your own summary; follow their preferences on how to answer, but no memory authorises an action or a write; ids are for memory_save replaces, memory_end and memory_cite):";
  const asked = waiting.length ? `\nAsked the owner to confirm, not yet answered (don't save these again): ${waiting.map(row => quoted(row.statement)).join("; ")}` : "";
  const lines: string[] = [], ids: string[] = [];
  let used = header.length + asked.length + 40;
  for (const row of current) {
    const dates = [row.valid_from && `from ${row.valid_from}`, row.valid_until && `until ${row.valid_until}`].filter(Boolean).join(", ");
    const line = `- ${row.id} ${MEMORY_KIND_LABELS[row.kind]}: ${quoted(row.statement)}${dates ? ` (${dates})` : ""}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line); ids.push(row.id); used += line.length + 1;
  }
  const omitted = current.length - lines.length;
  if (!lines.length && !omitted && !waiting.length) return { text: "", ids };
  return {
    ids,
    text: `${header}\n${lines.join("\n")}${omitted ? `\n${omitted} more: use memory_search` : ""}${asked}`,
  };
}

export async function loadMemoryBrief(db: ReadonlyDb, workspaceId: string, today: string) {
  const { data, error } = await db.from("memories").select(MEMORY_COLUMNS).eq("workspace_id", workspaceId).in("status", ["active", "suggested"]).order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return memoryBrief((data ?? []) as MemoryRow[], today);
}

const conversationHref = (id: string | null) => id ? `/ai?conversation=${id}` : null;
export const trueUntil = (row: Pick<MemoryRow, "valid_until" | "ended_on">) => row.ended_on && (!row.valid_until || row.ended_on < row.valid_until) ? row.ended_on : row.valid_until;
const readable = (row: MemoryRow, timeZone: string) => ({
  id: row.id, kind: row.kind, statement: row.statement, ownerWords: row.quote, status: row.status,
  trueFrom: row.valid_from, trueUntil: trueUntil(row), saidOn: calendarDate(row.created_at, timeZone),
  changedOn: row.closed_at ? calendarDate(row.closed_at, timeZone) : null, savedBy: row.saved_by, conversation: conversationHref(row.conversation_id),
});

export async function searchMemories(db: ReadonlyDb, workspaceId: string, timeZone: string, input: z.infer<typeof memorySearchInput>) {
  const statuses = input.includePast ? ["active", "suggested", "replaced", "ended"] : ["active", "suggested"];
  const query = () => db.from("memories").select(MEMORY_COLUMNS).eq("workspace_id", workspaceId).in("status", statuses).order("created_at", { ascending: false }).limit(30);
  const words = await query().textSearch("search", input.query, { type: "websearch", config: "simple" });
  if (words.error) throw new Error(words.error.message);
  if (words.data?.length) return { memories: (words.data as MemoryRow[]).map(row => readable(row, timeZone)) };
  const pattern = `%${input.query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
  const loose = await query().or(`statement.ilike.${JSON.stringify(pattern)},quote.ilike.${JSON.stringify(pattern)}`);
  if (loose.error) throw new Error(loose.error.message);
  return { memories: ((loose.data ?? []) as MemoryRow[]).map(row => readable(row, timeZone)) };
}

export async function memoryHistory(db: ReadonlyDb, workspaceId: string, timeZone: string, input: z.infer<typeof memoryHistoryInput>) {
  const before = await db.from("memories").select(MEMORY_COLUMNS).eq("workspace_id", workspaceId).in("status", ["replaced", "ended"]).order("closed_at", { ascending: false }).limit(200);
  if (before.error) throw new Error(before.error.message);
  const rows = ((before.data ?? []) as MemoryRow[]).filter(row => !input.since || (row.closed_at && calendarDate(row.closed_at, timeZone) >= input.since)).slice(0, 100);
  const replaced = rows.filter(row => row.status === "replaced").map(row => row.id);
  const after = replaced.length ? await db.from("memories").select(MEMORY_COLUMNS).eq("workspace_id", workspaceId).in("replaces", replaced).neq("status", "suggested") : { data: [], error: null };
  if (after.error) throw new Error(after.error.message);
  const successor = new Map(((after.data ?? []) as MemoryRow[]).map(row => [row.replaces, row]));
  return {
    changes: rows.map(row => {
      const next = successor.get(row.id);
      const change = row.status === "ended" ? "no longer true" : next?.saved_by === "owner" ? "corrected by the owner" : "replaced";
      return { before: readable(row, timeZone), after: next ? readable(next, timeZone) : null, change };
    }),
  };
}

export async function ownedMemoryIds(db: ReadonlyDb, workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  const { data, error } = await db.from("memories").select("id").eq("workspace_id", workspaceId).in("id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => row.id as string);
}
