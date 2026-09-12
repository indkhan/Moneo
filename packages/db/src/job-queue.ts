import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { backgroundJobs, type BackgroundJob } from "./schema.js";
import type * as schema from "./schema.js";

/**
 * Any drizzle client over the app schema: pooled node-postgres at runtime
 * (via `withWorkspaceTransaction`), PGlite in tests. The query-builder API
 * is identical across both, so one implementation serves each.
 */
export type JobQueueDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

/**
 * Issue 3.7 — durable job submission reads/writes for the HTTP API.
 *
 * The `background_jobs` table (Issue 2.4) is the execution truth; these two
 * functions are the only SQL the `/api/v1/jobs` routes run, so every query
 * stays inside `withWorkspaceTransaction` at the call site and RLS keeps
 * tenants apart. Submission is idempotent per (workspace, type, dedupeKey):
 * a retried POST with the same key returns the original row instead of
 * queueing twice (the UNIQUE from migration 0006 is the backstop; the
 * pre-select makes the common path a single read).
 */

export interface SubmitJobRow {
  workspaceId: string;
  type: string;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export async function insertBackgroundJob(
  db: JobQueueDb,
  input: SubmitJobRow,
): Promise<{ job: BackgroundJob; created: boolean }> {
  if (input.dedupeKey !== undefined) {
    const existing = await db
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.workspaceId, input.workspaceId),
          eq(backgroundJobs.type, input.type),
          eq(backgroundJobs.dedupeKey, input.dedupeKey),
        ),
      )
      .limit(1);
    const found = existing[0];
    if (found) {
      return { job: found, created: false };
    }
  }
  try {
    const inserted = await db
      .insert(backgroundJobs)
      .values({
        workspaceId: input.workspaceId,
        type: input.type,
        ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      })
      .returning();
    const job = inserted[0];
    if (!job) {
      throw new Error("Job insert returned no row.");
    }
    return { job, created: true };
  } catch (error) {
    // Lost a concurrent double-submit race: the loser's UNIQUE conflict
    // resolves to the winner's row instead of a 500.
    if (input.dedupeKey !== undefined && /unique|duplicate/i.test((error as Error).message)) {
      const winner = await db
        .select()
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.workspaceId, input.workspaceId),
            eq(backgroundJobs.type, input.type),
            eq(backgroundJobs.dedupeKey, input.dedupeKey),
          ),
        )
        .limit(1);
      const job = winner[0];
      if (job) {
        return { job, created: false };
      }
    }
    throw error;
  }
}

export async function findBackgroundJob(
  db: JobQueueDb,
  workspaceId: string,
  id: string,
): Promise<BackgroundJob | null> {
  const rows = await db
    .select()
    .from(backgroundJobs)
    .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ?? null;
}
