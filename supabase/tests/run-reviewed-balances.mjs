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
    await tx.unsafe(readFileSync("supabase/migrations/202610060001_reviewed_balance_boundary.sql", "utf8"));
    if (process.argv.includes("--compile-only")) { console.log("PASS candidate migration compiles; rolled back"); throw rollback; }
    await tx.unsafe(readFileSync("supabase/tests/reviewed-balances.sql", "utf8"));
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  if (!process.argv.includes("--compile-only")) console.log("PASS reviewed balance ownership, exact coverage, stale receipt, correction, reservation and undo; rolled back");
} finally { await db.end(); }
