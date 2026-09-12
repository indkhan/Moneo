import { asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { savedTransactionViews } from "./schema.js";
import type * as schema from "./schema.js";

type ViewDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export function listTransactionViews(db: ViewDb, workspaceId: string) {
  return db.select().from(savedTransactionViews).where(eq(savedTransactionViews.workspaceId, workspaceId)).orderBy(asc(savedTransactionViews.name));
}

export function createTransactionView(db: ViewDb, workspaceId: string, name: string, definition: Record<string, unknown>) {
  return db.insert(savedTransactionViews).values({ workspaceId, name, definition }).returning();
}
