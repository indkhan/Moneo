import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import postgres from "postgres";
process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`));
const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
const rollback = new Error("Successful rollback");
try {
  try { await db.begin(async tx => {
    if (!(await tx`select to_regclass('public.goal_reservation_events') present`)[0].present)
      await tx.unsafe(readFileSync("supabase/migrations/202610010034_goal_reservations.sql", "utf8"));
    await tx.unsafe(readFileSync("supabase/tests/goal-reservations.sql", "utf8"));
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  console.log("PASS: candidate current-cash/pending-hold/currency/liquidity/version/history/undo guards; rolled back");
} finally { await db.end(); }
