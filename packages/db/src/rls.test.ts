import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { securityAuditEvents, users, workspaceMembers, workspaces } from "./schema.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { TENANT_SETTING, withWorkspaceTransaction, type TenantConnection } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 1.2 — RLS and runtime DB roles.
 *
 * Applies the REAL shipped chain (0000 + 0001 + 0002) to PGlite and proves the
 * five mandatory behaviours: A cannot read B, A cannot update B, wrong
 * workspace FK rejected, missing tenant context fails safely, and the app
 * role cannot bypass RLS. Plus: the users-table scoping rule, the owner-role
 * migration path, and `withWorkspaceTransaction` end to end.
 */
describe("workspace RLS and runtime roles (migrations 0000-0002)", () => {
  let pg!: PGlite;

  let userA!: string;
  let userB!: string;
  let wsA!: string;
  let wsB!: string;

  /** Run `fn` as the runtime role with an optional tenant context. */
  async function asApp<T>(workspaceId: string | null, fn: () => Promise<T>): Promise<T> {
    await pg.exec("SET ROLE moneo_app");
    try {
      if (workspaceId === null) {
        await pg.exec(`RESET ${TENANT_SETTING}`);
      } else {
        await pg.exec(`SET ${TENANT_SETTING} = '${workspaceId}'`);
      }
      return await fn();
    } finally {
      await pg.exec(`RESET ${TENANT_SETTING}`);
      await pg.exec("RESET ROLE");
    }
  }

  const count = async (table: string, where = "", params: unknown[] = []) =>
    one(await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} ${where}`, params)).n;

  /**
   * PGlite drops results when `query` receives an explicit empty params
   * array, so only forward params when there is at least one.
   */
  async function q<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
    const result =
      params.length > 0 ? await pg.query<T>(sqlText, params as never[]) : await pg.query<T>(sqlText);
    return result.rows;
  }

  /** Raw result (row counts) for mutating statements. */
  async function qRaw(sqlText: string, params: unknown[] = []) {
    return params.length > 0 ? pg.query(sqlText, params as never[]) : pg.query(sqlText);
  }

  beforeAll(async () => {
    pg = await createMigratedDb("0002_workspace_rls");
    const db = drizzlePglite(pg, { schema });

    userA = one(await db.insert(users).values({ authSubject: "auth0|tenant-a" }).returning()).id;
    userB = one(await db.insert(users).values({ authSubject: "auth0|tenant-b" }).returning()).id;
    wsA = one(await db.insert(workspaces).values({ name: "Workspace A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Workspace B" }).returning()).id;
    await db.insert(workspaceMembers).values({ workspaceId: wsA, userId: userA, role: "OWNER" });
    await db.insert(workspaceMembers).values({ workspaceId: wsB, userId: userB, role: "OWNER" });
    await db
      .insert(securityAuditEvents)
      .values({ workspaceId: wsA, userId: userA, eventType: "user.provisioned" });
    await db
      .insert(securityAuditEvents)
      .values({ workspaceId: wsB, userId: userB, eventType: "user.provisioned" });
    await db.insert(securityAuditEvents).values({ eventType: "login.failed" });
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates the NOBYPASSRLS application role and enables RLS on tenant tables", async () => {
    const role = one(
      await q<{ rolname: string; rolbypassrls: boolean; rolcanlogin: boolean }>(
        "SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'moneo_app'",
      ),
    );
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolcanlogin).toBe(true);

    const tables = await tableNames(pg);
    for (const t of ["users", "workspaces", "workspace_members", "security_audit_events"]) {
      expect(tables).toContain(t);
      const locked = one(
        await q<{ rowsecurity: boolean }>(
          "SELECT relforcerowsecurity AS rowsecurity FROM pg_class WHERE relname = $1",
          // relforcerowsecurity is the FORCE flag (false here: owner keeps access);
          // plain RLS state is asserted via policy behaviour below.
          [t],
        ),
      );
      expect(locked.rowsecurity).toBe(false);
    }

    const policies = await q<{ tablename: string; policyname: string }>(
      "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname",
    );
    expect(policies.map((r) => `${r.tablename}.${r.policyname}`)).toEqual([
      "security_audit_events.security_audit_events_isolation",
      "users.users_insert_provisioning",
      "users.users_select_scoped",
      "workspace_members.workspace_members_isolation",
      "workspaces.workspaces_isolation",
    ]);
  });

  it("A cannot read B: every tenant table is filtered to the caller's workspace", async () => {
    await asApp(wsA, async () => {
      expect(await count("workspaces")).toBe("1");
      expect(one(await q<{ id: string }>("SELECT id FROM workspaces")).id).toBe(wsA);

      const members = await q("SELECT workspace_id, user_id FROM workspace_members");
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ workspace_id: wsA, user_id: userA });

      const audits = await q<{ event_type: string }>(
        "SELECT event_type FROM security_audit_events",
      );
      expect(audits).toHaveLength(1);

      // B shares no workspace with A, so B's user row is invisible too.
      const visibleUsers = await q<{ id: string }>("SELECT id FROM users");
      expect(visibleUsers.map((r) => r.id)).toEqual([userA]);
    });

    await asApp(wsB, async () => {
      expect(await count("workspaces")).toBe("1");
      expect(one(await q<{ id: string }>("SELECT id FROM workspaces")).id).toBe(wsB);
      const visibleUsers = await q<{ id: string }>("SELECT id FROM users");
      expect(visibleUsers.map((r) => r.id)).toEqual([userB]);
    });
  });

  it("A cannot update B: cross-workspace UPDATE/DELETE match zero rows", async () => {
    await asApp(wsA, async () => {
      const renamed = await qRaw("UPDATE workspaces SET name = 'Hijacked B' WHERE id = $1", [wsB]);
      expect(renamed.affectedRows ?? renamed.rowCount).toBe(0);

      const promoted = await qRaw(
        "UPDATE workspace_members SET role = 'OWNER' WHERE workspace_id = $1",
        [wsB],
      );
      expect(promoted.affectedRows ?? promoted.rowCount).toBe(0);

      const deleted = await qRaw("DELETE FROM workspaces WHERE id = $1", [wsB]);
      expect(deleted.affectedRows ?? deleted.rowCount).toBe(0);
    });

    // Owner view: B is byte-for-byte untouched.
    const name = one(await q<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [wsB])).name;
    expect(name).toBe("Workspace B");
    const role = one(
      await q<{ role: string }>(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [wsB, userB],
      ),
    ).role;
    expect(role).toBe("OWNER");
  });

  it("wrong workspace FK rejected: writes bound to another workspace fail the WITH CHECK", async () => {
    await asApp(wsA, async () => {
      await expectDbError(
        q("INSERT INTO workspace_members VALUES ($1, $2, 'MEMBER', now())", [wsB, userA]),
        /new row violates row-level security policy for table "workspace_members"/,
      );
      await expectDbError(
        q("INSERT INTO security_audit_events (workspace_id, event_type) VALUES ($1, 'x')", [wsB]),
        /new row violates row-level security policy for table "security_audit_events"/,
      );
      // FKs still bite under RLS: unknown user in the *own* workspace fails on the FK, not RLS.
      await expectDbError(
        q("INSERT INTO workspace_members VALUES ($1, $2, 'MEMBER', now())", [
          wsA,
          "99999999-9999-7999-8999-999999999999",
        ]),
        /violates foreign key constraint "workspace_members_user_id_users_id_fk"/,
      );
    });
  });

  it("missing tenant context fails safely: reads see nothing, scoped writes are denied", async () => {
    await asApp(null, async () => {
      expect(await count("workspaces")).toBe("0");
      expect(await count("workspace_members")).toBe("0");
      expect(await count("security_audit_events")).toBe("0");
      expect(await count("users")).toBe("0");

      await expectDbError(
        q("INSERT INTO workspace_members VALUES ($1, $2, 'MEMBER', now())", [wsA, userA]),
        /new row violates row-level security policy/,
      );
      // A context-free UPDATE matches zero rows instead of erroring — also deny-by-default.
      const renamed = await qRaw("UPDATE workspaces SET name = 'x' WHERE id = $1", [wsA]);
      expect(renamed.affectedRows ?? renamed.rowCount).toBe(0);
    });
    const name = one(await q<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [wsA])).name;
    expect(name).toBe("Workspace A");
  });

  it("app role cannot bypass RLS: no BYPASSRLS, cannot disable RLS, cannot self-promote", async () => {
    await asApp(wsA, async () => {
      await expectDbError(
        pg.exec("ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY"),
        /permission denied|must be owner/i,
      );
      await expectDbError(pg.exec("ALTER ROLE moneo_app BYPASSRLS"), /permission denied/i);
      // Switching context is legitimate use, not a bypass: exactly one workspace is ever visible.
      await pg.exec(`SET ${TENANT_SETTING} = '${wsB}'`);
      expect(await count("workspaces")).toBe("1");
      expect(one(await q<{ id: string }>("SELECT id FROM workspaces")).id).toBe(wsB);
    });
  });

  it("users stay scoped: B becomes visible to A only after sharing a workspace", async () => {
    await asApp(wsA, async () => {
      const ids = (await q<{ id: string }>("SELECT id FROM users")).map((r) => r.id);
      expect(ids).not.toContain(userB);
    });
    // Owner adds B to workspace A (cross-workspace admin act, migration/owner role).
    await qRaw("INSERT INTO workspace_members VALUES ($1, $2, 'MEMBER', now())", [wsA, userB]);
    await asApp(wsA, async () => {
      const ids = (await q<{ id: string }>("SELECT id FROM users ORDER BY id")).map((r) => r.id);
      expect(ids).toContain(userA);
      expect(ids).toContain(userB);
      // …but B's *workspace* is still invisible.
      expect(await count("workspaces")).toBe("1");
    });
    // Tidy up so other tests keep a pristine A/B split.
    await qRaw("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [wsA, userB]);
  });

  it("migration/owner role still sees everything (releases and ops path intact)", async () => {
    expect(await count("workspaces")).toBe("2");
    expect(await count("users")).toBe("2");
    expect(await count("security_audit_events")).toBe("3");
  });

  it("withWorkspaceTransaction pins the tenant end to end and clears it afterwards", async () => {
    const checkout = async (): Promise<TenantConnection> => {
      await pg.exec("SET ROLE moneo_app");
      return {
        query: (text: string, params?: unknown[]) => q(text, params as never[]),
        release: () => {
          void pg.exec(`RESET ${TENANT_SETTING}`);
          void pg.exec("RESET ROLE");
        },
      };
    };
    const dbFor = (_conn: TenantConnection) => drizzlePglite(pg, { schema });

    const eventId = uuidv7();
    await withWorkspaceTransaction(
      wsA,
      (tx: ReturnType<typeof dbFor>) =>
        tx
          .insert(securityAuditEvents)
          .values({ id: eventId, workspaceId: wsA, userId: userA, eventType: "session.revoked" })
          .then(() => "stored"),
      { checkout, wrap: dbFor },
    ).then((v) => {
      expect(v).toBe("stored");
    });

    // Cross-workspace write through the helper fails the policy and rolls back.
    await expectDbError(
      withWorkspaceTransaction(
        wsB,
        (tx: ReturnType<typeof dbFor>) =>
          tx
            .insert(securityAuditEvents)
            .values({ workspaceId: wsA, eventType: "forged" })
            .then(() => "stored"),
        { checkout, wrap: dbFor },
      ),
      /new row violates row-level security policy/,
    );

    // Transaction-local context is gone after commit/rollback: fail-safe default.
    const lingering = one(
      await q<{ v: string | null }>(`SELECT current_setting('${TENANT_SETTING}', true) AS v`),
    ).v;
    expect(lingering === null || lingering === "").toBe(true);

    const stored = one(
      await q<{ event_type: string }>("SELECT event_type FROM security_audit_events WHERE id = $1", [
        eventId,
      ]),
    );
    expect(stored.event_type).toBe("session.revoked");
  });
});
