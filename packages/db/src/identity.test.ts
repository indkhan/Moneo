import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { securityAuditEvents, users, workspaceMembers, workspaces } from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { isUuidV7, uuidv7 } from "./uuid.js";

/**
 * Issue 1.1 â€” Identity/Workspace schema.
 *
 * Runs the real shipped migrations (0000 + 0001) against PGlite and proves:
 * table shape, UUIDv7 defaults, uniqueness, role allowlist, FK guards and
 * delete propagation. Tenant *isolation* (RLS) is Issue 1.2's test file.
 */
describe("identity/workspace schema (migrations 0000-0001)", () => {
  let pg!: PGlite;
  // drizzle client bound per test run for typed inserts.
  const db = () => drizzle(pg, { schema: { users, workspaces, workspaceMembers, securityAuditEvents } });

  beforeAll(async () => {
    pg = await createMigratedDb();
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates the identity tables", async () => {
    const tables = await tableNames(pg);
    // Containment, not equality: later epochs add tables to the same chain.
    for (const t of [
      "currencies",
      "security_audit_events",
      "users",
      "workspace_members",
      "workspaces",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("stores a user row with an application-generated UUIDv7 id and timestamps", async () => {
    const id = uuidv7();
    const row = one(await db()
      .insert(users)
      .values({ id, authSubject: "auth0|user-a", email: "a@example.com", displayName: "User A" })
      .returning());
    expect(row.id).toBe(id);
    expect(isUuidV7(row.id)).toBe(true);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("auto-generates a UUIDv7 id when the caller omits it", async () => {
    const row = one(await db()
      .insert(users)
      .values({ authSubject: "auth0|auto-id" })
      .returning({ id: users.id }));
    expect(isUuidV7(row.id)).toBe(true);
  });

  it("rejects a second user with the same Auth0 subject (one row per subject)", async () => {
    await db().insert(users).values({ authSubject: "auth0|dupe-subject" });
    await expectDbError(
      db().insert(users).values({ authSubject: "auth0|dupe-subject" }),
      /duplicate key value violates unique constraint "users_auth_subject_unique"/,
    );
  });

  it("creates a workspace with an OWNER membership for the provisioning user", async () => {
    const t = db();
    const user = one(await t.insert(users).values({ authSubject: "auth0|owner" }).returning());
    const workspace = one(await t
      .insert(workspaces)
      .values({ name: "Owner's workspace", createdByUserId: user.id })
      .returning());
    expect(isUuidV7(workspace.id)).toBe(true);
    const member = one(await t
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: user.id, role: "OWNER" })
      .returning());
    expect(member).toMatchObject({ workspaceId: workspace.id, userId: user.id, role: "OWNER" });
  });

  it("defaults new memberships to MEMBER and rejects roles outside OWNER/MEMBER", async () => {
    const t = db();
    const user = one(await t.insert(users).values({ authSubject: "auth0|role-check" }).returning());
    const workspace = one(await t.insert(workspaces).values({ name: "Roles ws" }).returning());

    const member = one(await t
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: user.id })
      .returning());
    expect(member.role).toBe("MEMBER");

    await expectDbError(
      t.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "ADMIN" }),
      /violates check constraint "workspace_members_role_check"/,
    );
    const secondUser = one(await t
      .insert(users)
      .values({ authSubject: "auth0|role-check-2" })
      .returning());
    await expectDbError(
      t.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: secondUser.id, role: "owner" }),
      /violates check constraint "workspace_members_role_check"/,
    );
  });

  it("rejects a duplicate (workspace_id, user_id) membership", async () => {
    const t = db();
    const user = one(await t.insert(users).values({ authSubject: "auth0|dupe-member" }).returning());
    const workspace = one(await t.insert(workspaces).values({ name: "Dupe ws" }).returning());
    await t.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id });
    await expectDbError(
      t.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id }),
      /duplicate key value violates unique constraint "workspace_members_workspace_id_user_id_pk"/,
    );
  });

  it("rejects memberships pointing at a workspace from another context (unknown FK)", async () => {
    const t = db();
    const user = one(await t.insert(users).values({ authSubject: "auth0|wrong-ws" }).returning());
    await expectDbError(
      t.insert(workspaceMembers).values({
        workspaceId: "99999999-9999-7999-8999-999999999999",
        userId: user.id,
      }),
      /violates foreign key constraint "workspace_members_workspace_id_workspaces_id_fk"/,
    );
    const realWs = one(await t.insert(workspaces).values({ name: "Real ws" }).returning());
    await expectDbError(
      t.insert(workspaceMembers).values({
        workspaceId: realWs.id,
        userId: "99999999-9999-7999-8999-999999999999",
      }),
      /violates foreign key constraint "workspace_members_user_id_users_id_fk"/,
    );
  });

  it("stores security audit events with {} metadata by default and UUIDv7 ids", async () => {
    const t = db();
    const user = one(await t.insert(users).values({ authSubject: "auth0|audit" }).returning());
    const workspace = one(await t.insert(workspaces).values({ name: "Audit ws" }).returning());
    const event = one(await t
      .insert(securityAuditEvents)
      .values({ workspaceId: workspace.id, userId: user.id, eventType: "user.provisioned" })
      .returning());
    expect(isUuidV7(event.id)).toBe(true);
    expect(event.metadata).toEqual({});
    expect(event.createdAt).toBeInstanceOf(Date);

    const rich = one(await t
      .insert(securityAuditEvents)
      .values({
        workspaceId: workspace.id,
        eventType: "session.revoked",
        metadata: { sessionId: uuidv7(), reason: "user-initiated" },
      })
      .returning());
    const richMeta = rich.metadata as { sessionId?: unknown; reason?: unknown };
    expect(richMeta.reason).toBe("user-initiated");
    expect(typeof richMeta.sessionId).toBe("string");
    expect(isUuidV7(richMeta.sessionId as string)).toBe(true);
  });

  it("rejects audit events pointing at a nonexistent workspace", async () => {
    await expectDbError(
      db().insert(securityAuditEvents).values({
        workspaceId: "99999999-9999-7999-8999-999999999999",
        eventType: "user.provisioned",
      }),
      /violates foreign key constraint "security_audit_events_workspace_id_workspaces_id_fk"/,
    );
  });

  it("allows global (workspace-less) security events for pre-workspace activity", async () => {
    const event = one(await db()
      .insert(securityAuditEvents)
      .values({ eventType: "login.failed", metadata: { subject: "auth0|unknown" } })
      .returning());
    expect(event.workspaceId).toBeNull();
    expect(event.userId).toBeNull();
  });

  it("cascades workspace deletion to members and audits but keeps users", async () => {
    const t = db();
    const user = one(await t.insert(users).values({ authSubject: "auth0|cascade" }).returning());
    const workspace = one(await t.insert(workspaces).values({ name: "Doomed ws" }).returning());
    await t.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "OWNER" });
    await t
      .insert(securityAuditEvents)
      .values({ workspaceId: workspace.id, userId: user.id, eventType: "user.provisioned" });

    await t.delete(workspaces).where(sql`${workspaces.id} = ${workspace.id}`);

    expect(await t.select().from(workspaceMembers)).not.toContainEqual(
      expect.objectContaining({ workspaceId: workspace.id }),
    );
    const audits = await pg.query("SELECT * FROM security_audit_events WHERE workspace_id = $1", [workspace.id]);
    expect(audits.rows).toHaveLength(0);
    const survivors = await pg.query("SELECT id FROM users WHERE id = $1", [user.id]);
    expect(survivors.rows).toHaveLength(1);
  });

  it("cascades user deletion to memberships and nulls audit authorship", async () => {
    const t = db();
    const user = one(await t.insert(users).values({ authSubject: "auth0|leaving" }).returning());
    const workspace = one(await t.insert(workspaces).values({ name: "Staying ws" }).returning());
    await t.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id });
    const event = one(await t
      .insert(securityAuditEvents)
      .values({ workspaceId: workspace.id, userId: user.id, eventType: "session.revoked" })
      .returning());

    await t.delete(users).where(sql`${users.id} = ${user.id}`);

    const members = await pg.query("SELECT * FROM workspace_members WHERE user_id = $1", [user.id]);
    expect(members.rows).toHaveLength(0);
    const kept = await pg.query<{ user_id: string | null }>("SELECT user_id FROM security_audit_events WHERE id = $1", [
      event.id,
    ]);
    expect(one(kept.rows).user_id).toBeNull();
  });
});
