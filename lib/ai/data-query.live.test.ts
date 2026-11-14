import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { expect, it } from "vitest";
import { AI_DATA_SCOPES } from "@/lib/settings";
import { DATA_QUERY_TABLES, DataQueryError, runDataQuery } from "./data-query";

const enabled = process.env.RUN_DATA_QUERY_DB_TESTS === "1";

// The model writes queries from DATA_QUERY_TABLES; a view column it doesn't know about, or one it is told
// about that doesn't exist, makes it write broken SQL.
it.skipIf(!enabled)("describes exactly the tables and columns the moneo_query views expose", async () => {
  process.loadEnvFile(".env.qa");
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  try {
    const rows = await db<{ table_name: string; column_name: string }[]>`select table_name, column_name from information_schema.columns
      where table_schema = 'moneo_query' order by table_name, ordinal_position`;
    const views: Record<string, string[]> = {};
    for (const row of rows) (views[row.table_name] ??= []).push(row.column_name);
    expect(views).toEqual(Object.fromEntries(Object.entries(DATA_QUERY_TABLES).map(([name, table]) => [name, Object.keys(table.columns)])));
  } finally { await db.end(); }
});

// Through PostgREST as a signed-in user, the way chat calls it: the function's 5 second limit applies.
it.skipIf(!enabled)("runs as the signed-in owner through PostgREST and stops slow queries", { timeout: 30_000 }, async () => {
  process.loadEnvFile(".env.qa");
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const user = randomUUID();
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user, role: "authenticated", aud: "authenticated", iat: now, exp: now + 300 })}`;
  const token = `${unsigned}.${createHmac("sha256", process.env.JWT_SECRET!).update(unsigned).digest("base64url")}`;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  let workspace: string | undefined;
  try {
    await db`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
    [{ id: workspace }] = await db<{ id: string }[]>`select id from public.workspaces where owner_id=${user}`;
    await db`insert into public.accounts(workspace_id,name,currency_code) values(${workspace},'Synthetic data query','EUR')`;
    expect(await runDataQuery(supabase, "select name, 9007199254740993::bigint as amount_minor from accounts", AI_DATA_SCOPES))
      .toMatchObject({ rows: [{ name: "Synthetic data query", amount_minor: "9007199254740993" }] });
    const started = Date.now();
    await expect(runDataQuery(supabase, "select pg_sleep(8)", AI_DATA_SCOPES)).rejects.toThrow(DataQueryError);
    expect(Date.now() - started).toBeLessThan(7_500);
  } finally {
    if (workspace) for (const table of ["accounts", "categories", "workspace_settings"]) await db.unsafe(`delete from public.${table} where workspace_id = $1`, [workspace]);
    await db`delete from public.workspaces where owner_id=${user}`;
    await db`delete from auth.users where id=${user}`;
    await db.end();
  }
});
