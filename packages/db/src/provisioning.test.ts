import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { createMigratedDb } from "./pglite-test-db.js";
import { provisionUserOnLogin, type ProvisioningResult } from "./provisioning.js";
import { isUuidV7, uuidv7 } from "./uuid.js";

/**
 * Issue 1.4 â€” first-login provisioning.
 *
 * Runs the REAL `provision_user_on_login` function (migration 0003) as the
 * `moneo_app` runtime role and proves: subjectâ†’userâ†’workspaceâ†’OWNER,
 * idempotency, oldest-membership defaulting, profile refresh, audit trail,
 * least-privilege execution, and input validation that never reaches the DB.
 */
describe("first-login provisioning (migration 0003)", () => {
  let pg!: PGlite;
  type OwnerDb = ReturnType<typeof drizzlePglite<typeof schema>>;
  let owner!: OwnerDb;

  /** Run `fn` with the runtime role, like the web callback route does. */
  async function asApp<T>(fn: (db: OwnerDb) => Promise<T>): Promise<T> {
    await pg.exec("SET ROLE moneo_app");
    try {
      return await fn(drizzlePglite(pg, { schema }));
    } finally {
      await pg.exec("RESET ROLE");
    }
  }

  const rows = (table: string) => pg.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
  const count = async (table: string, where = "", params: unknown[] = []) => {
    const r =
      params.length > 0
        ? await pg.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} ${where}`, params as never[])
        : await pg.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} ${where}`);
    const n = r.rows[0]?.n;
    if (n === undefined) throw new Error("count returned no rows");
    return n;
  };

  beforeAll(async () => {
    pg = await createMigratedDb();
    owner = drizzlePglite(pg, { schema });
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates user + default workspace + OWNER membership on first login", async () => {
    const userId = uuidv7();
    const workspaceId = uuidv7();
    const result = await asApp((db) =>
      provisionUserOnLogin(db, {
        authSubject: "auth0|first-timer",
        email: "first@example.com",
        displayName: "First Timer",
        userId,
        workspaceId,
      }),
    );

    expect(result).toEqual({ userId, workspaceId, createdUser: true, createdWorkspace: true });
    expect(await count("users", "WHERE auth_subject = $1", ["auth0|first-timer"])).toBe("1");
    expect(await count("workspaces", "WHERE id = $1", [workspaceId])).toBe("1");

    const members = await rows("workspace_members");
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0]).toMatchObject({ workspace_id: workspaceId, user_id: userId, role: "OWNER" });

    const ws = (await owner.execute(sql`SELECT name, created_by_user_id FROM workspaces WHERE id = ${workspaceId}`)) as unknown as {
      rows: Array<{ name: string; created_by_user_id: string }>;
    };
    expect(ws.rows[0]).toMatchObject({ name: "My workspace", created_by_user_id: userId });

    const user = (await owner.execute(
      sql`SELECT email, display_name FROM users WHERE id = ${userId}`,
    )) as unknown as { rows: Array<{ email: string; display_name: string }> };
    expect(user.rows[0]).toEqual({ email: "first@example.com", display_name: "First Timer" });
  });

  it("is idempotent: repeats return the same ids and never duplicate rows", async () => {
    const first = await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|repeat" }));
    const second = await asApp((db) =>
      provisionUserOnLogin(db, {
        authSubject: "auth0|repeat",
        email: "repeat@example.com",
        userId: uuidv7(),
        workspaceId: uuidv7(),
      }),
    );

    expect(second).toEqual({
      userId: first.userId,
      workspaceId: first.workspaceId,
      createdUser: false,
      createdWorkspace: false,
    });
    expect(await count("users", "WHERE auth_subject = $1", ["auth0|repeat"])).toBe("1");
    expect(await count("workspace_members", "WHERE user_id = $1", [first.userId])).toBe("1");

    // Third login with yet more fresh candidate ids: still one workspace.
    const third = await asApp((db) =>
      provisionUserOnLogin(db, { authSubject: "auth0|repeat", userId: uuidv7(), workspaceId: uuidv7() }),
    );
    expect(third.workspaceId).toBe(first.workspaceId);
    expect(await count("workspaces", "WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)", [
      first.userId,
    ])).toBe("1");
  });

  it("refreshes the profile on return visits without blanking kept fields", async () => {
    const first = await asApp((db) =>
      provisionUserOnLogin(db, {
        authSubject: "auth0|profile",
        email: "old@example.com",
        displayName: "Old Name",
      }),
    );
    await asApp((db) =>
      provisionUserOnLogin(db, { authSubject: "auth0|profile", email: "new@example.com" }),
    );
    const user = (await owner.execute(sql`SELECT email, display_name FROM users WHERE id = ${first.userId}`)) as unknown as {
      rows: Array<{ email: string; display_name: string }>;
    };
    expect(user.rows[0]).toEqual({ email: "new@example.com", display_name: "Old Name" });
  });

  it("gives every subject an independent workspace", async () => {
    const a = await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|solo-a" }));
    const b = await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|solo-b" }));
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.userId).not.toBe(b.userId);
  });

  it("honours a custom workspace name", async () => {
    const result = await asApp((db) =>
      provisionUserOnLogin(db, { authSubject: "auth0|named", workspaceName: "Family budget" }),
    );
    const ws = (await owner.execute(sql`SELECT name FROM workspaces WHERE id = ${result.workspaceId}`)) as unknown as {
      rows: Array<{ name: string }>;
    };
    expect(ws.rows[0]?.name).toBe("Family budget");
  });

  it("defaults to the oldest membership when the user already has workspaces", async () => {
    const first = await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|multi-ws" }));
    // Owner adds a newer second workspace for the same user.
    const secondWs = uuidv7();
    await owner.execute(
      sql`INSERT INTO workspaces (id, name) VALUES (${secondWs}, 'Second')`,
    );
    await owner.execute(
      sql`INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
          VALUES (${secondWs}, ${first.userId}, 'MEMBER', now() + interval '1 day')`,
    );
    await owner.execute(
      sql`UPDATE workspace_members SET created_at = now() - interval '1 day'
          WHERE workspace_id = ${first.workspaceId} AND user_id = ${first.userId}`,
    );

    const again = await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|multi-ws" }));
    expect(again).toEqual({ ...first, createdUser: false, createdWorkspace: false });
  });

  it("writes user.provisioned once, then user.login with creation flags", async () => {
    const result = await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|audited" }));
    await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|audited" }));
    const events = (await owner.execute(
      sql`SELECT event_type, user_id, workspace_id, metadata FROM security_audit_events
          WHERE user_id = ${result.userId} ORDER BY created_at ASC`,
    )) as unknown as {
      rows: Array<{
        event_type: string;
        user_id: string;
        workspace_id: string;
        metadata: { created_user: boolean; created_workspace: boolean };
      }>;
    };
    expect(events.rows.map((e) => e.event_type)).toEqual(["user.provisioned", "user.login"]);
    expect(events.rows[0]?.metadata).toEqual({ created_user: true, created_workspace: true });
    expect(events.rows[1]?.metadata).toEqual({ created_user: false, created_workspace: false });
    for (const e of events.rows) {
      expect(e.workspace_id).toBe(result.workspaceId);
    }
  });

  it("runs least-privilege: DEFINER-owned, fixed search_path, EXECUTE for app only", async () => {    const fn = (await owner.execute(sql`SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'provision_user_on_login'`)) as unknown as {
      rows: Array<{ prosecdef: boolean; proconfig: string[] | null }>;
    };
    expect(fn.rows[0]?.prosecdef).toBe(true);
    expect(fn.rows[0]?.proconfig ?? []).toContain("search_path=public");

    const canExec = (await owner.execute(
      sql`SELECT has_function_privilege('moneo_app', 'provision_user_on_login(text,text,text,text,uuid,uuid)', 'EXECUTE') AS ok`,
    )) as unknown as { rows: Array<{ ok: boolean }> };
    expect(canExec.rows[0]?.ok).toBe(true);

    // PUBLIC execute is revoked: the ACL names owner + moneo_app, with no
    // empty-grantee (`{=X/â€¦}`) public entry.
    const acl = (await owner.execute(
      sql`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'provision_user_on_login'`,
    )) as unknown as { rows: Array<{ acl: string | null }> };
    const aclText = acl.rows[0]?.acl ?? "";
    expect(aclText).toContain("moneo_app=X/");
    expect(aclText).not.toMatch(/(^|,)=X\//);
  });

  it("defaults server-side ids to UUIDv7 (time-ordered safety net)", async () => {
    const generated = (await owner.execute(sql`SELECT uuid_generate_v7() AS a, uuid_generate_v7() AS b`)) as unknown as {
      rows: Array<{ a: string; b: string }>;
    };
    const pair = generated.rows[0];
    expect(pair).toBeDefined();
    expect(isUuidV7(pair?.a ?? "")).toBe(true);
    expect(isUuidV7(pair?.b ?? "")).toBe(true);
    expect(pair?.a).not.toBe(pair?.b);

    // The audit row the provision function writes omits id and still lands time-ordered.
    const result = await asApp((db) => provisionUserOnLogin(db, { authSubject: "auth0|db-default-id" }));
    const audits = (await owner.execute(
      sql`SELECT id FROM security_audit_events WHERE user_id = ${result.userId}`,
    )) as unknown as { rows: Array<{ id: string }> };
    expect(audits.rows.length).toBeGreaterThan(0);
    for (const row of audits.rows) {
      expect(isUuidV7(row.id)).toBe(true);
    }
  });

  it("rejects bad input before touching the database", async () => {
    const execute = vi.fn(() => Promise.resolve({ rows: [] }));
    const db = { execute };
    const bad: Array<Parameters<typeof provisionUserOnLogin>[1]> = [
      { authSubject: "" },
      { authSubject: `auth0|${"x".repeat(300)}` },
      { authSubject: "auth0|x", email: `${"x".repeat(321)}@y.z` },
      { authSubject: "auth0|x", displayName: "n".repeat(201) },
      { authSubject: "auth0|x", workspaceName: "w".repeat(101) },
      { authSubject: "auth0|x", userId: "nope" },
      { authSubject: "auth0|x", workspaceId: "nope" },
    ];
    for (const input of bad) {
      await expect(provisionUserOnLogin(db, input)).rejects.toThrow(/Invalid/);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats hostile subjects as literal data: parameterised, never interpolated", async () => {
    const hostile = `auth0|x'); DROP TABLE users; --`;
    const before = await count("users");
    const result = await asApp((db) =>
      provisionUserOnLogin(db, { authSubject: hostile, userId: uuidv7(), workspaceId: uuidv7() }),
    );
    expect(result.createdUser).toBe(true);
    // The subject round-trips literally and the users table still stands.
    expect(await count("users", "WHERE auth_subject = $1", [hostile])).toBe("1");
    expect(await count("users")).toBe(String(Number(before) + 1));
  });

  it("rejects hostile ids and empty subjects at the SQL layer too", async () => {
    await asApp(async () => {
      const res = await pg.query("SELECT * FROM provision_user_on_login('', NULL, NULL, NULL, $1, $2)", [
        uuidv7(),
        uuidv7(),
      ] as never[]);
      expect(res.rows).toHaveLength(0);
    }).then(
      () => {
        throw new Error("empty subject should have raised");
      },
      (error: unknown) => {
        expect(String(error)).toMatch(/Invalid auth subject/);
      },
    );
  });

  it("surfaces malformed function results instead of half-provisioned sessions", async () => {
    const empty = { execute: vi.fn(() => Promise.resolve({ rows: [] })) };
    await expect(provisionUserOnLogin(empty, { authSubject: "auth0|x" })).rejects.toThrow(/unexpected shape/);
    const wrong = {
      execute: vi.fn(() => Promise.resolve({ rows: [{ user_id: 42 }] })),
    };
    await expect(provisionUserOnLogin(wrong, { authSubject: "auth0|x" })).rejects.toThrow(/unexpected shape/);
  });

  it("returns typed ids for the session layer", async () => {
    const result: ProvisioningResult = await asApp((db) =>
      provisionUserOnLogin(db, { authSubject: "auth0|typed" }),
    );
    expect(typeof result.userId).toBe("string");
    expect(typeof result.workspaceId).toBe("string");
  });
});
