import { expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedDb } from "./pglite-test-db.js";
import { seedSystemCategories, SYSTEM_CATEGORIES } from "./system-categories.js";
import { provisionUserOnLogin } from "./provisioning.js";
import * as schema from "./schema.js";
it("gives new and existing workspaces usable categories without duplicating or overwriting corrections", async () => {
  const pg = await createMigratedDb();
  const db = drizzle(pg, { schema });
  try {
    const old = await provisionUserOnLogin(db, { authSubject: "test|existing" });
    await seedSystemCategories(db);
    await pg.exec("SET ROLE moneo_app");
    const fresh = await provisionUserOnLogin(db, { authSubject: "test|new" });
    await pg.exec("RESET ROLE");
    for (const wid of [old.workspaceId, fresh.workspaceId]) {
      const result = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM categories WHERE workspace_id=$1",
        [wid],
      );
      expect(result.rows[0]?.count).toBe(SYSTEM_CATEGORIES.length);
    }
    await pg.query(
      "UPDATE categories SET name='My dining' WHERE workspace_id=$1 AND system_category_code='dining'",
      [old.workspaceId],
    );
    await seedSystemCategories(db);
    const result = await pg.query<{ name: string }>(
      "SELECT name FROM categories WHERE workspace_id=$1 AND system_category_code='dining'",
      [old.workspaceId],
    );
    expect(result.rows).toEqual([{ name: "My dining" }]);
  } finally {
    await pg.close();
  }
});
