import postgres from "postgres";
import { readFileSync } from "node:fs";

process.loadEnvFile(".env");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is required for database regression checks");
const db = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
try {
  await db.begin(async tx => {
    if (process.argv.includes("--candidate")) {
      await tx.unsafe(readFileSync("supabase/migrations/202610010020_review_account_routing.sql", "utf8"));
    }
    await tx.unsafe(readFileSync("supabase/tests/import-review.sql", "utf8"));
    console.log("PASS: reviewed routing, status, idempotency and workspace isolation (rolled back)");
    throw new Error("ROLLBACK_OK");
  });
} catch (error) {
  if (error.message !== "ROLLBACK_OK") { console.error(error.message); process.exitCode = 1; }
} finally { await db.end(); }
