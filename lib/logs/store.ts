import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/database";
import { readSettings } from "@/lib/workspace-settings";
import { LOG_AREAS, LOG_AUDIO_BUCKET, LOG_LEVELS } from "./options";
import type { LogEntryView } from "./redact";
import { logCutoff } from "./retention";

export const LOG_PAGE = 100;
export const LOG_REPORT_LIMIT = 2000;
export const LOG_WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null } as const;
export type LogWindow = keyof typeof LOG_WINDOWS;

export const logFilterSchema = z.object({
  level: z.enum(LOG_LEVELS).optional().catch(undefined),
  area: z.enum(LOG_AREAS).optional().catch(undefined),
  window: z.enum(Object.keys(LOG_WINDOWS) as [LogWindow, ...LogWindow[]]).catch("7d").default("7d"),
  q: z.string().trim().max(200).optional().catch(undefined),
  before: z.iso.datetime({ offset: true }).optional().catch(undefined),
});
export type LogFilter = z.infer<typeof logFilterSchema>;

const COLUMNS = "id, created_at, level, area, event, message, details, conversation_id, usage_id, agent_run_id, job_id, audio_path";
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;

export async function listLogs(db: Db, workspaceId: string, filter: LogFilter, now: Date, limit = LOG_PAGE): Promise<LogEntryView[]> {
  let query = db.from("app_logs").select(COLUMNS).eq("workspace_id", workspaceId);
  if (filter.level) query = query.eq("level", filter.level);
  if (filter.area) query = query.eq("area", filter.area);
  const span = LOG_WINDOWS[filter.window];
  if (span !== null) query = query.gte("created_at", new Date(now.getTime() - span).toISOString());
  if (filter.before) query = query.lt("created_at", filter.before);
  if (filter.q) query = query.or(`message.ilike.${JSON.stringify(likePattern(filter.q))},event.ilike.${JSON.stringify(likePattern(filter.q))}`);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
  if (error) throw new Error(`Logs could not be read: ${error.message}`);
  return data as LogEntryView[];
}

export async function knownNames(db: Db, workspaceId: string): Promise<string[]> {
  const [accounts, merchants, wealth, counterparties] = await Promise.all([
    db.from("accounts").select("name").eq("workspace_id", workspaceId).limit(1000),
    db.from("merchants").select("name").eq("workspace_id", workspaceId).limit(5000),
    db.from("wealth_items").select("name").eq("workspace_id", workspaceId).limit(1000),
    db.from("bank_transaction_raw").select("counterparty_name").eq("workspace_id", workspaceId).not("counterparty_name", "is", null).limit(5000),
  ]);
  for (const result of [accounts, merchants, wealth, counterparties]) if (result.error) throw new Error(`Names for redaction could not be read: ${result.error.message}`);
  return [...(accounts.data ?? []), ...(merchants.data ?? []), ...(wealth.data ?? [])].map(row => row.name)
    .concat((counterparties.data ?? []).flatMap(row => row.counterparty_name ? [row.counterparty_name] : []));
}

async function removeAudio(db: Db, paths: string[]) {
  for (let start = 0; start < paths.length; start += 1000) {
    const removed = await db.storage.from(LOG_AUDIO_BUCKET).remove(paths.slice(start, start + 1000));
    if (removed.error) throw new Error(`Log audio could not be removed: ${removed.error.message}`);
  }
}

async function deleteLogsBefore(db: Db, workspaceId: string, cutoff: string | null) {
  let removed = 0;
  for (;;) {
    let expired = db.from("app_logs").select("id, audio_path").eq("workspace_id", workspaceId);
    if (cutoff) expired = expired.lt("created_at", cutoff);
    const { data, error } = await expired.order("created_at").limit(1000);
    if (error) throw new Error(`Expired logs could not be read: ${error.message}`);
    if (!data.length) return removed;
    await removeAudio(db, data.flatMap(row => row.audio_path ? [row.audio_path] : []));
    const deleted = await db.from("app_logs").delete().eq("workspace_id", workspaceId).in("id", data.map(row => row.id));
    if (deleted.error) throw new Error(`Expired logs could not be deleted: ${deleted.error.message}`);
    removed += data.length;
  }
}

export async function deleteAllLogs(db: Db, workspaceId: string) {
  const removed = await deleteLogsBefore(db, workspaceId, null);
  for (;;) {
    const listed = await db.storage.from(LOG_AUDIO_BUCKET).list(workspaceId, { limit: 1000 });
    if (listed.error) throw new Error(`Log audio could not be listed: ${listed.error.message}`);
    if (!listed.data.length) return removed;
    await removeAudio(db, listed.data.map(file => `${workspaceId}/${file.name}`));
  }
}

export async function deleteExpiredLogs(db: Db, now: Date) {
  const { data, error } = await db.from("workspaces").select("id, workspace_settings(*)");
  if (error) throw new Error(`Workspaces could not be read: ${error.message}`);
  let removed = 0;
  for (const row of data) {
    const stored = Array.isArray(row.workspace_settings) ? row.workspace_settings[0] : row.workspace_settings;
    const settings = readSettings(stored);
    const cutoff = logCutoff(settings.log_retention, now, settings.timezone);
    if (cutoff) removed += await deleteLogsBefore(db, row.id, cutoff);
  }
  return removed;
}
