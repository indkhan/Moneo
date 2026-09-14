import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDb } from "./pglite-test-db.js";
import { uuidv7 } from "./uuid.js";

describe("global outbox dispatch functions (migration 0023)", () => {
  let pg!: PGlite;
  const workspaceId = uuidv7();
  const eventId = uuidv7();

  beforeAll(async () => {
    pg = await createMigratedDb();
    await pg.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Outbox test')", [workspaceId]);
    await pg.query(
      `INSERT INTO outbox_events
         (id, workspace_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, 'background_job', 'job-1', 'job.ready', '{"backgroundJobId":"job-1"}')`,
      [eventId, workspaceId],
    );
  });

  afterAll(async () => pg.close());

  async function asRole<T extends Record<string, unknown>>(
    role: string,
    sql: string,
    params: unknown[] = [],
  ) {
    await pg.exec(`SET ROLE ${role}`);
    try {
      return await pg.query<T>(sql, params as never[]);
    } finally {
      await pg.exec("RESET ROLE");
    }
  }

  it("claims all tenants without granting raw cross-tenant reads", async () => {
    expect((await asRole("moneo_app", "SELECT id FROM outbox_events")).rows).toEqual([]);
    await expect(asRole("moneo_app", "SELECT * FROM claim_outbox_events(25)")).rejects.toThrow(
      /permission denied for function claim_outbox_events/i,
    );

    const claimed = await asRole<{
      id: string;
      workspace_id: string;
      attempts: number;
    }>("moneo_dispatcher", "SELECT id, workspace_id, attempts FROM claim_outbox_events($1)", [25]);

    expect(claimed.rows).toEqual([{ id: eventId, workspace_id: workspaceId, attempts: 1 }]);
    expect(
      (
        await pg.query<{ status: string }>("SELECT status FROM outbox_events WHERE id = $1", [
          eventId,
        ])
      ).rows[0]?.status,
    ).toBe("claimed");
  });

  it("acknowledges and retries only claimed event ids", async () => {
    await asRole("moneo_dispatcher", "SELECT mark_outbox_events_published($1::uuid[])", [
      [eventId],
    ]);
    expect(
      (
        await pg.query<{ status: string }>("SELECT status FROM outbox_events WHERE id = $1", [
          eventId,
        ])
      ).rows[0]?.status,
    ).toBe("published");

    await pg.query("UPDATE outbox_events SET status = 'claimed' WHERE id = $1", [eventId]);
    await asRole("moneo_dispatcher", "SELECT retry_outbox_event($1, $2)", [
      eventId,
      "transport unavailable",
    ]);
    const retried = await pg.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM outbox_events WHERE id = $1",
      [eventId],
    );
    expect(retried.rows[0]).toEqual({ status: "pending", last_error: "transport unavailable" });
  });

  it("is least privilege with fixed search paths and no PUBLIC execute", async () => {
    const functions = await pg.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[];
      acl: string;
    }>(
      `SELECT proname, prosecdef, proconfig, proacl::text AS acl
       FROM pg_proc WHERE proname IN
         ('claim_outbox_events', 'mark_outbox_events_published', 'retry_outbox_event')
       ORDER BY proname`,
    );
    expect(functions.rows).toHaveLength(3);
    for (const fn of functions.rows) {
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain("search_path=public, pg_temp");
      expect(fn.acl).toContain("moneo_dispatcher=X/");
      expect(fn.acl).not.toContain("moneo_app=X/");
      expect(fn.acl).not.toMatch(/(^|,)=X\//);
    }
  });
});
