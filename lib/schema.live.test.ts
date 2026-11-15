import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/lib/schema";
import { minorDigits } from "@/lib/finance/fx";

const live = process.env.RUN_SCHEMA_DB_TESTS === "1";
let db: ReturnType<typeof postgres>;

beforeAll(() => {
  if (!live) return;
  process.loadEnvFile(".env.qa");
  db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
});
afterAll(async () => { await db?.end(); });

it.skipIf(!live)("lib/schema.ts describes the same tables and columns as the migrated database", async () => {
  const rows = await db<{ table_name: string; column_name: string }[]>`
    select c.table_name, c.column_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`;
  const columnsOf = (pairs: [string, string][]) => {
    const tables: Record<string, string[]> = {};
    for (const [table, column] of pairs) (tables[table] ??= []).push(column);
    for (const columns of Object.values(tables)) columns.sort();
    return tables;
  };
  const described = Object.values(schema).map(table => getTableConfig(table as PgTable)).filter(table => (table.schema ?? "public") === "public")
    .flatMap(table => table.columns.map((column): [string, string] => [table.name, column.name]));
  expect(columnsOf(described)).toEqual(columnsOf(rows.map(row => [row.table_name, row.column_name])));
});

it.skipIf(!live)("the database and the app agree on every currency's minor units", async () => {
  const codes = [...new Set([...Intl.supportedValuesOf("currency"), "ZZZ"])];
  const rows = await db<{ code: string; digits: number | null }[]>`select code, public.currency_minor_digits(code) as digits from unnest(${codes}::text[]) as code`;
  const inApp = (code: string) => { try { return minorDigits(code); } catch { return null; } };
  expect(rows.filter(row => row.digits !== null).length).toBeGreaterThan(150);
  expect(Object.fromEntries(rows.map(row => [row.code, row.digits]))).toEqual(Object.fromEntries(codes.map(code => [code, inApp(code)])));
});

it.skipIf(!live)("no database function reports a conflict as a serialization failure", async () => {
  const rows = await db<{ name: string }[]>`
    select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc ~* 'errcode\\s*=\\s*''40001'''`;
  expect(rows.map(row => row.name)).toEqual([]);
});
