// Candidate occurrence migration + exact SQL fixtures, always rolled back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";
process.loadEnvFile(".env");
const connection = new URL(process.env.SUPABASE_DB_URL);
const db = postgres(connection.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
const rollback = new Error("Verified rollback");
try {
  const history = await db`select version from supabase_migrations.schema_migrations order by version`;
  const before = await db`select to_regclass('public.recurring_occurrence_settlements') as relation`;
  try {
    await db.begin(async tx => {
      if (!before[0].relation) await tx.unsafe(readFileSync("supabase/migrations/202610060003_recurring_occurrence_settlements.sql", "utf8"));
      await tx.unsafe(readFileSync("supabase/tests/recurring-occurrences.sql", "utf8"));
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  assert.deepEqual(await db`select to_regclass('public.recurring_occurrence_settlements') as relation`, before, "Candidate schema must roll back");
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, history, "Migration history must remain unchanged");
  console.log("PASS: explicit occurrences, version/owner/date guards, pending-to-posted, reassociation, retained undo/deletion history and authenticated RLS; candidate schema/history rollback verified");
} finally { await db.end(); }
