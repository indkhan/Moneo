import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { createMigratedDb, expectDbError } from "./pglite-test-db.js";
import { provisionUserOnLogin } from "./provisioning.js";
import {
  listUserSessions,
  registerSession,
  revokeSingleSession,
  revokeUserSessions,
} from "./sessions.js";
import { isUuidV7, uuidv7 } from "./uuid.js";

/**
 * Issue 1.7 — server-side session registry.
 *
 * Runs the REAL migration-0004 functions as `moneo_app` and proves: login
 * registration (members only), per-user listing isolation, single + others
 * revocation, RLS deny-by-default on direct reads, and client-side input
 * validation that never reaches the database.
 */
describe("session registry (migration 0004)", () => {
  let pg!: PGlite;
  type AppDb = ReturnType<typeof drizzlePglite>;
  let userA!: string;
  let userB!: string;
  let wsA!: string;

  /** Run `fn` as the runtime role, like the web session routes do. */
  async function asApp<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
    await pg.exec("SET ROLE moneo_app");
    try {
      return await fn(drizzlePglite(pg, { schema }));
    } finally {
      await pg.exec("RESET ROLE");
    }
  }

  beforeAll(async () => {
    pg = await createMigratedDb("0012_command_input_hash");
    const owner = drizzlePglite(pg, { schema });
    const a = await provisionUserOnLogin(owner, { authSubject: "auth0|session-a" });
    const b = await provisionUserOnLogin(owner, { authSubject: "auth0|session-b" });
    userA = a.userId;
    userB = b.userId;
    wsA = a.workspaceId;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("registers a login and lists it back with a UUIDv7 sid", async () => {
    const sid = uuidv7();
    await asApp((db) =>
      registerSession(db, {
        sessionId: sid,
        userId: userA,
        workspaceId: wsA,
        userAgent: "TestBrowser/1.0",
      }),
    );
    const sessions = await asApp((db) => listUserSessions(db, userA));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: sid, workspaceId: wsA, userAgent: "TestBrowser/1.0" });
    expect(isUuidV7(sessions[0]?.id ?? "")).toBe(true);
    expect(sessions[0]?.createdAt).toBeInstanceOf(Date);
    expect(sessions[0]?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("re-registration refreshes activity instead of duplicating", async () => {
    const sid = uuidv7();
    await asApp((db) => registerSession(db, { sessionId: sid, userId: userA, workspaceId: wsA }));
    await asApp((db) => registerSession(db, { sessionId: sid, userId: userA, workspaceId: wsA }));
    const sessions = await asApp((db) => listUserSessions(db, userA));
    expect(sessions.filter((s) => s.id === sid)).toHaveLength(1);
  });

  it("refuses sessions for non-members", async () => {
    await asApp((db) =>
      expectDbError(
        // userB is no member of wsA: the DEFINER function rejects, not RLS.
        registerSession(db, { sessionId: uuidv7(), userId: userB, workspaceId: wsA }),
        /Not a workspace member/,
      ),
    );
    expect(await asApp((db) => listUserSessions(db, userB))).toHaveLength(0);
  });

  it("isolates listings: A never sees B's sessions", async () => {
    const b = await provisionUserOnLogin(drizzlePglite(pg, { schema }), {
      authSubject: "auth0|session-b",
    });
    const sidB = uuidv7();
    await asApp((db) =>
      registerSession(db, { sessionId: sidB, userId: userB, workspaceId: b.workspaceId }),
    );
    const aSessions = await asApp((db) => listUserSessions(db, userA));
    expect(aSessions.map((s) => s.id)).not.toContain(sidB);
    const bSessions = await asApp((db) => listUserSessions(db, userB));
    expect(bSessions.map((s) => s.id)).toContain(sidB);
  });

  it("revokes a single session and keeps the rest", async () => {
    const keep = uuidv7();
    const drop = uuidv7();
    const other = uuidv7();
    await asApp((db) => registerSession(db, { sessionId: keep, userId: userA, workspaceId: wsA }));
    await asApp((db) => registerSession(db, { sessionId: drop, userId: userA, workspaceId: wsA }));
    await asApp((db) => registerSession(db, { sessionId: other, userId: userA, workspaceId: wsA }));

    expect(await asApp((db) => revokeSingleSession(db, userA, drop))).toBe(1);
    expect(await asApp((db) => revokeSingleSession(db, userA, drop))).toBe(0);

    const remaining = await asApp((db) => listUserSessions(db, userA));
    expect(remaining.map((s) => s.id)).toContain(keep);
    expect(remaining.map((s) => s.id)).toContain(other);
    expect(remaining.map((s) => s.id)).not.toContain(drop);
  });

  it("revokes everything when no session is kept (full sign-out)", async () => {
    const sid = uuidv7();
    await asApp((db) => registerSession(db, { sessionId: sid, userId: userA, workspaceId: wsA }));
    const revoked = await asApp((db) => revokeUserSessions(db, userA, null));
    expect(revoked).toBeGreaterThanOrEqual(1);
    expect(await asApp((db) => listUserSessions(db, userA))).toHaveLength(0);

    // Revoked rows persist for audit — invisible to the app, present for ops.
    const kept = await pg.query("SELECT count(*)::text AS n FROM sessions WHERE user_id = $1", [
      userA,
    ]);
    expect(Number((kept.rows[0] as { n: string }).n)).toBeGreaterThan(0);
  });

  it("denies direct session reads to the app role (DEFINER functions only)", async () => {
    const sid = uuidv7();
    await asApp((db) => registerSession(db, { sessionId: sid, userId: userA, workspaceId: wsA }));
    await pg.exec("SET ROLE moneo_app");
    try {
      const direct = await pg.query("SELECT * FROM sessions WHERE id = $1", [sid]);
      expect(direct.rows).toHaveLength(0);
    } finally {
      await pg.exec("RESET ROLE");
    }
    // …while the function path still sees it.
    expect((await asApp((db) => listUserSessions(db, userA))).map((s) => s.id)).toContain(sid);
  });

  it("rejects bad ids before touching the database", async () => {
    const execute = vi.fn(() => Promise.resolve({ rows: [] }));
    const db = { execute };
    await expect(
      registerSession(db, { sessionId: "nope", userId: userA, workspaceId: wsA }),
    ).rejects.toThrow(/Invalid sessionId/);
    await expect(listUserSessions(db, "nope")).rejects.toThrow(/Invalid userId/);
    await expect(revokeUserSessions(db, userA, "nope")).rejects.toThrow(/Invalid keepSessionId/);
    await expect(revokeUserSessions(db, "", null)).rejects.toThrow(/Invalid userId/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("truncates overlong user agents instead of failing the login", async () => {
    const sid = uuidv7();
    await asApp((db) =>
      registerSession(db, {
        sessionId: sid,
        userId: userA,
        workspaceId: wsA,
        userAgent: "x".repeat(600),
      }),
    );
    const found = (await asApp((db) => listUserSessions(db, userA))).find((s) => s.id === sid);
    expect(found?.userAgent?.length).toBeLessThanOrEqual(200);
  });

  it("orders listings newest-first", async () => {
    // Fresh user + explicit timestamps: deterministic two-session order.
    const fresh = await provisionUserOnLogin(drizzlePglite(pg, { schema }), {
      authSubject: "auth0|order-check",
    });
    const first = uuidv7();
    const second = uuidv7();
    await asApp((db) =>
      registerSession(db, {
        sessionId: first,
        userId: fresh.userId,
        workspaceId: fresh.workspaceId,
      }),
    );
    await asApp((db) =>
      registerSession(db, {
        sessionId: second,
        userId: fresh.userId,
        workspaceId: fresh.workspaceId,
      }),
    );
    await pg.query(
      "UPDATE sessions SET created_at = created_at - interval '1 minute' WHERE id = $1",
      [first],
    );
    const listed = await asApp((db) => listUserSessions(db, fresh.userId));
    expect(listed.map((s) => s.id)).toEqual([second, first]);
  });
});
