import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { imports } from "./schema.js";
import type * as schema from "./schema.js";

/**
 * Issue 3.8 — prior-import reads for duplicate-file warnings.
 *
 * Read-only by design: the duplicate signal (file hash comparison) needs
 * the workspace's recent file history, and this is the only SQL for it.
 * Runs inside `withWorkspaceTransaction` at the call site; newest first so
 * callers can cap the comparison window with `limit`.
 */

export type StatementImportDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export interface PriorImportRow {
  id: string;
  fileName: string | null;
  fileSha256: string | null;
  status: string;
  createdAt: Date;
}

export async function listPriorImports(
  db: StatementImportDb,
  workspaceId: string,
  limit = 50,
): Promise<PriorImportRow[]> {
  const rows = await db
    .select({
      id: imports.id,
      fileName: imports.fileName,
      fileSha256: imports.fileSha256,
      status: imports.status,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .where(eq(imports.workspaceId, workspaceId))
    // id is UUIDv7 (time-ordered): the tiebreak keeps same-millisecond
    // inserts in a stable newest-first order on every backend.
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .limit(Math.max(1, Math.min(limit, 200)));
  return rows;
}
