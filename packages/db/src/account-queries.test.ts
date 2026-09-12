import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { accountBalanceSnapshots, accounts, workspaces } from "./schema.js";
import { getAccount, getAccountBalances, listAccounts } from "./account-queries.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 4.5 — account query services.
 *
 * Proves against the REAL migrated schema: listing is workspace-scoped and
 * stable-ordered with archived hidden by default; get returns the row or
 * null (never a cross-workspace row); balances resolve newest-wins with a
 * deterministic tiebreak; accounts without a snapshot are absent (unknown,
 * never zero); and the same functions stay tenant-safe under the app role.
 */
describe("account query services (issue 4.5)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;

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

  beforeAll(async () => {
    pg = await createMigratedDb("0012_command_input_hash");
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Queries A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Queries B" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  it("lists one workspace's accounts in stable order, hiding archived by default", async () => {
    const db = drizzlePglite(pg, { schema });
    const tag = uuidv7();
    const first = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `First ${tag}`, currencyCode: "EUR" })
        .returning(),
    );
    const second = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Second ${tag}`, currencyCode: "EUR" })
        .returning(),
    );
    const archived = one(
      await db
        .insert(accounts)
        .values({
          workspaceId: wsA,
          name: `Archived ${tag}`,
          currencyCode: "EUR",
          archivedAt: new Date(),
        })
        .returning(),
    );
    await db.insert(accounts).values({ workspaceId: wsB, name: `Other ${tag}`, currencyCode: "EUR" });

    const visible = await listAccounts(db, wsA);
    const names = visible.map((a) => a.name);
    expect(names).toContain(`First ${tag}`);
    expect(names).toContain(`Second ${tag}`);
    expect(names).not.toContain(`Archived ${tag}`);
    expect(names).not.toContain(`Other ${tag}`);
    expect(names.indexOf(`First ${tag}`)).toBeLessThan(names.indexOf(`Second ${tag}`));
    expect(visible.map((a) => a.id)).toContain(first.id);
    expect(visible.map((a) => a.id)).toContain(second.id);

    const withArchived = await listAccounts(db, wsA, { includeArchived: true });
    expect(withArchived.map((a) => a.id)).toContain(archived.id);
  });

  it("gets one account or null, never a cross-workspace row", async () => {
    const db = drizzlePglite(pg, { schema });
    const own = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Own ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    const foreign = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsB, name: `Foreign ${uuidv7()}`, currencyCode: "EUR" })
        .returning(),
    );
    expect((await getAccount(db, wsA, own.id))?.id).toBe(own.id);
    expect(await getAccount(db, wsA, foreign.id)).toBeNull();
    expect(await getAccount(db, wsA, uuidv7())).toBeNull();
  });

  it("resolves newest-wins balances and omits unknown accounts", async () => {
    const db = drizzlePglite(pg, { schema });
    const tag = uuidv7();
    const withBalance = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Balanced ${tag}`, currencyCode: "EUR" })
        .returning(),
    );
    const unknown = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: `Unknown ${tag}`, currencyCode: "EUR" })
        .returning(),
    );
    const older = new Date("2026-08-01T00:00:00Z");
    const newer = new Date("2026-08-15T00:00:00Z");
    await db.insert(accountBalanceSnapshots).values({
      workspaceId: wsA,
      accountId: withBalance.id,
      currencyCode: "EUR",
      currentAmountMinor: 100,
      observedAt: older,
      source: "statement",
    });
    await db.insert(accountBalanceSnapshots).values({
      workspaceId: wsA,
      accountId: withBalance.id,
      currencyCode: "EUR",
      currentAmountMinor: 250,
      observedAt: newer,
      source: "manual",
    });

    const balances = await getAccountBalances(db, wsA, [withBalance.id, unknown.id]);
    expect(balances.get(withBalance.id)).toMatchObject({
      accountId: withBalance.id,
      currentAmountMinor: "250",
      currencyCode: "EUR",
      source: "manual",
    });
    // Unknown is absent — the caller renders "unknown", never zero.
    expect(balances.has(unknown.id)).toBe(false);
    expect(await getAccountBalances(db, wsA, [])).toEqual(new Map());
  });

  it("stays tenant-safe under the app role", async () => {
    const db = drizzlePglite(pg, { schema });
    const marker = `scoped-${uuidv7()}`;
    const foreign = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsB, name: marker, currencyCode: "EUR" })
        .returning(),
    );
    await db.insert(accountBalanceSnapshots).values({
      workspaceId: wsB,
      accountId: foreign.id,
      currencyCode: "EUR",
      currentAmountMinor: 777,
    });
    await asApp(wsA, async () => {
      expect((await listAccounts(db, wsA)).map((a) => a.name)).not.toContain(marker);
      expect(await getAccount(db, wsA, foreign.id)).toBeNull();
      // A forged workspace id fails closed under RLS (sees nothing).
      expect(await listAccounts(db, wsB)).toEqual([]);
      expect((await getAccountBalances(db, wsB, [foreign.id])).has(foreign.id)).toBe(false);
    });
  });
});
