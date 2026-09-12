import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { dataSources, imports, workspaces } from "./schema.js";
import { listPriorImports } from "./statement-imports.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";

/**
 * Issue 3.8 â€” prior-import reads for duplicate-file warnings.
 *
 * Against the REAL migration chain: lists newest-first with file hashes
 * intact, honors the limit cap, excludes other workspaces, and stays
 * invisible across tenants (and without context) for the app role.
 */

describe("prior import file history", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;
  let srcA!: string;

  beforeAll(async () => {
    pg = await createMigratedDb();
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Hist A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Hist B" }).returning()).id;
    srcA = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsA, type: "csv_file", name: "CSV" })
        .returning(),
    ).id;
    const srcB = one(
      await db
        .insert(dataSources)
        .values({ workspaceId: wsB, type: "csv_file", name: "CSV" })
        .returning(),
    ).id;
    await db.insert(imports).values([
      {
        workspaceId: wsA,
        dataSourceId: srcA,
        idempotencyKey: "h-1",
        fileName: "august.csv",
        fileSha256: "a".repeat(64),
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
      },
      {
        workspaceId: wsA,
        dataSourceId: srcA,
        idempotencyKey: "h-2",
        fileName: "september.csv",
        fileSha256: "b".repeat(64),
        createdAt: new Date("2026-09-01T10:00:00.000Z"),
      },
      {
        workspaceId: wsA,
        dataSourceId: srcA,
        idempotencyKey: "h-3",
        fileName: null,
        fileSha256: null,
        createdAt: new Date("2026-09-02T10:00:00.000Z"),
      },
      {
        workspaceId: wsB,
        dataSourceId: srcB,
        idempotencyKey: "h-1",
        fileName: "other.csv",
        fileSha256: "a".repeat(64),
      },
    ]);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("lists newest first with hashes and honors the limit", async () => {
    const db = drizzlePglite(pg, { schema });
    const all = await listPriorImports(db, wsA);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.fileName)).toEqual([null, "september.csv", "august.csv"]);
    expect(all[2]).toMatchObject({ fileSha256: "a".repeat(64) });
    const oneRow = await listPriorImports(db, wsA, 1);
    expect(oneRow).toHaveLength(1);
    expect(oneRow[0]?.fileName).toBeNull();
  });

  it("never leaks another workspace's file history", async () => {
    const db = drizzlePglite(pg, { schema });
    expect(await listPriorImports(db, wsB)).toHaveLength(1);
    expect(await listPriorImports(db, "00000000-0000-4000-8000-000000000000")).toHaveLength(0);
  });

  it("stays tenant-scoped for the app role", async () => {
    await pg.exec("SET ROLE moneo_app");
    try {
      await pg.exec(`SET ${TENANT_SETTING} = '${wsA}'`);
      // PGlite returns count as a number, real PostgreSQL as text: compare
      // numerically so this holds on both backends.
      const seen = await pg.query<{ count: string | number }>(`SELECT count(*) FROM imports`);
      expect(Number((seen.rows[0] as { count: string | number }).count)).toBe(3);
      await pg.exec(`RESET ${TENANT_SETTING}`);
      const blind = await pg.query<{ count: string | number }>(`SELECT count(*) FROM imports`);
      expect(Number((blind.rows[0] as { count: string | number }).count)).toBe(0);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });
});
