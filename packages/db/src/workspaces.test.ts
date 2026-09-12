import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { users, workspaces } from "./schema.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { findWorkspaceShell } from "./workspaces.js";

/**
 * Issue 1.5 — shell workspace lookup.
 *
 * `findWorkspaceShell` is the single query the shell topbar and settings
 * identity card run (inside `withWorkspaceTransaction`). These tests prove
 * it returns the caller's workspace, null for anything else, and validates
 * ids before touching the database.
 */
describe("findWorkspaceShell", () => {
  let pg!: PGlite;
  let wsId!: string;

  /** Run `fn` as the runtime role with an optional tenant context. */
  async function asApp<T>(workspaceId: string | null, fn: (db: ReturnType<typeof drizzlePglite>) => Promise<T>): Promise<T> {
    await pg.exec("SET ROLE moneo_app");
    try {
      if (workspaceId === null) {
        await pg.exec("RESET app.current_workspace");
      } else {
        await pg.exec(`SET app.current_workspace = '${workspaceId}'`);
      }
      return await fn(drizzlePglite(pg, { schema }));
    } finally {
      await pg.exec("RESET app.current_workspace");
      await pg.exec("RESET ROLE");
    }
  }

  beforeAll(async () => {
    pg = await createMigratedDb("0003_user_provisioning");
    const db = drizzlePglite(pg, { schema });
    const user = one(await db.insert(users).values({ authSubject: "auth0|shell-user" }).returning());
    wsId = one(await db.insert(workspaces).values({ name: "Shell workspace", createdByUserId: user.id }).returning()).id;
    await db.execute(sql`INSERT INTO workspace_members VALUES (${wsId}, ${user.id}, 'OWNER', now())`);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("returns id + name for the caller's own workspace", async () => {
    await asApp(wsId, async (db) => {
      expect(await findWorkspaceShell(db, wsId)).toEqual({ id: wsId, name: "Shell workspace" });
    });
  });

  it("returns null for another workspace, even with a valid id", async () => {
    const other = "99999999-9999-7999-8999-999999999999";
    await asApp(wsId, async (db) => {
      expect(await findWorkspaceShell(db, other)).toBeNull();
    });
  });

  it("returns null without tenant context instead of leaking the row", async () => {
    await asApp(null, async (db) => {
      expect(await findWorkspaceShell(db, wsId)).toBeNull();
    });
  });

  it("rejects malformed ids before issuing any query", async () => {
    const db = drizzlePglite(pg, { schema });
    await expect(findWorkspaceShell(db, "not-a-uuid")).rejects.toThrow("Invalid workspaceId");
    await expect(findWorkspaceShell(db, `${wsId}'; DROP TABLE workspaces; --`)).rejects.toThrow(
      "Invalid workspaceId",
    );
  });

  it("selects only the columns the shell renders", async () => {
    const db = drizzlePglite(pg, { schema });
    const row = await findWorkspaceShell(db, wsId);
    expect(Object.keys(row ?? {}).sort()).toEqual(["id", "name"]);
  });
});
