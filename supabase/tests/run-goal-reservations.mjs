import { readFileSync } from "node:fs";
import postgres from "postgres";
process.loadEnvFile(".env");
const connection = new URL(process.env.SUPABASE_DB_URL);
const db = postgres(connection.toString(), { max: 1, onnotice: () => {} });
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
