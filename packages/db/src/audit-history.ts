import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { auditEvents, users } from "./schema.js";
import type * as schema from "./schema.js";

export type AuditHistoryDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

/** Immutable, tenant-scoped history for one canonical entity. */
export async function listEntityAudit(
  db: AuditHistoryDb,
  workspaceId: string,
  entityType: string,
  entityId: string,
) {
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      reason: auditEvents.reason,
      relatedAiRunId: auditEvents.relatedAiRunId,
      oldValue: auditEvents.oldValue,
      newValue: auditEvents.newValue,
      createdAt: auditEvents.createdAt,
      actorName: users.displayName,
      actorEmail: users.email,
    })
    .from(auditEvents)
    .leftJoin(users, eq(auditEvents.actorUserId, users.id))
    .where(
      and(
        eq(auditEvents.workspaceId, workspaceId),
        eq(auditEvents.entityType, entityType),
        eq(auditEvents.entityId, entityId),
      ),
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
}
