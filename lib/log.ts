import "server-only";
import { randomUUID } from "node:crypto";
import { serviceDb } from "@/lib/service-db";
import { serviceRoleConfig } from "@/lib/env";
import type { TablesInsert } from "@/lib/database.types";
import { LOG_AUDIO_BUCKET, type LogArea, type LogLevel } from "@/lib/logs/options";

export type LogAudio = { bytes: Uint8Array | ArrayBuffer; contentType: string };
export type LogEvent = {
  level: LogLevel; area: LogArea; event: string; message: string; details?: unknown; workspaceId?: string;
  conversationId?: string; usageId?: string; agentRunId?: string; jobId?: string; audio?: LogAudio;
};
export type LogStore = (row: TablesInsert<"app_logs">, audio: LogAudio | undefined) => Promise<void>;

const MAX_STRING = 20_000, MAX_DETAILS = 200_000, MAX_DEPTH = 8;
const EXTENSIONS: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/pcm": "pcm" };

export function logDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length - MAX_STRING} more characters)` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    const { code, status, statusCode } = value as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
    return logDetails({ name: value.name, message: value.message, code, status: status ?? statusCode, stack: value.stack, cause: value.cause }, depth);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
  if (depth >= MAX_DEPTH) return "[nested too deep]";
  if (Array.isArray(value)) return value.slice(0, 500).map(item => logDetails(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, logDetails(item, depth + 1)]));
  return typeof value === "function" ? "[function]" : "[value]";
}

function boundedDetails(details: unknown) {
  const cleaned = logDetails(details);
  if (cleaned === null) return null;
  const size = JSON.stringify(cleaned).length;
  return size > MAX_DETAILS ? { truncated: true, size, start: JSON.stringify(cleaned).slice(0, MAX_DETAILS) } : cleaned;
}

let ownerWorkspace: Promise<string | null> | undefined;
function ownerWorkspaceId(): Promise<string | null> {
  ownerWorkspace ??= Promise.resolve(serviceDb().from("workspaces").select("id").order("created_at").limit(1).maybeSingle())
    .then(({ data }) => data?.id ?? null, () => null).then(id => { if (!id) ownerWorkspace = undefined; return id; });
  return ownerWorkspace;
}

const storeInDatabase: LogStore = async (row, audio) => {
  const db = serviceDb();
  let audioPath: string | null = null;
  if (audio) {
    const path = `${row.workspace_id}/${row.id ?? randomUUID()}.${EXTENSIONS[audio.contentType.split(";")[0]?.trim() ?? ""] ?? "bin"}`;
    const uploaded = await db.storage.from(LOG_AUDIO_BUCKET).upload(path, audio.bytes, { contentType: audio.contentType, upsert: true });
    if (uploaded.error) reportLogWriteFailure(uploaded.error);
    else audioPath = path;
  }
  const inserted = await db.from("app_logs").insert({ ...row, audio_path: audioPath });
  if (inserted.error) {
    ownerWorkspace = undefined;
    reportLogWriteFailure(inserted.error);
  }
};

function reportLogWriteFailure(error: unknown) {
  console.error("[logs] a log entry could not be stored", error instanceof Error ? error.message : error);
}

const PRINT: Record<LogLevel, ((...args: unknown[]) => void) | null> = { error: (...args) => console.error(...args), warn: (...args) => console.warn(...args), info: null };

export function log(entry: LogEvent, store: LogStore = storeInDatabase): void {
  PRINT[entry.level]?.(`[${entry.area}] ${entry.event}: ${entry.message}`, ...(entry.details === undefined ? [] : [logDetails(entry.details)]));
  if (!serviceRoleConfig()) return;
  void Promise.resolve(entry.workspaceId ?? ownerWorkspaceId()).then(workspaceId => {
    if (!workspaceId) return;
    return store({
      id: randomUUID(), workspace_id: workspaceId, level: entry.level, area: entry.area, event: entry.event.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 80) || "event",
      message: entry.message.slice(0, 2000) || entry.event, details: boundedDetails(entry.details) as TablesInsert<"app_logs">["details"],
      conversation_id: entry.conversationId ?? null, usage_id: entry.usageId ?? null, agent_run_id: entry.agentRunId ?? null, job_id: entry.jobId ?? null,
    }, entry.audio);
  }).catch(reportLogWriteFailure);
}

export const logError = (area: LogArea, event: string, message: string, details?: unknown, links: Omit<LogEvent, "level" | "area" | "event" | "message" | "details"> = {}) =>
  log({ level: "error", area, event, message, details, ...links });
export const logWarn = (area: LogArea, event: string, message: string, details?: unknown, links: Omit<LogEvent, "level" | "area" | "event" | "message" | "details"> = {}) =>
  log({ level: "warn", area, event, message, details, ...links });
export const logInfo = (area: LogArea, event: string, message: string, details?: unknown, links: Omit<LogEvent, "level" | "area" | "event" | "message" | "details"> = {}) =>
  log({ level: "info", area, event, message, details, ...links });
