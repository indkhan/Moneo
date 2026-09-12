import { and, asc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { categories, type Category } from "./schema.js";
import type * as schema from "./schema.js";

/**
 * Issue 5.5 — workspace category query service.
 *
 * Read-only list behind `GET /api/v1/categories` (the drawer's category
 * select). Runs inside `withWorkspaceTransaction` at the call site; the
 * predicate repeats `workspaceId`, so a caller bug fails closed under RLS.
 * Name order keeps the select stable; archived rows hide by default.
 */

export type CategoryQueryDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

/** Workspace categories in name order; archived hidden by default. */
export async function listCategories(
  db: CategoryQueryDb,
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Category[]> {
  const filters = [eq(categories.workspaceId, workspaceId)];
  if (!options.includeArchived) {
    filters.push(isNull(categories.archivedAt));
  }
  return db
    .select()
    .from(categories)
    .where(and(...filters))
    .orderBy(asc(categories.name), asc(categories.id));
}
