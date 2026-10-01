import postgres from "postgres";
import { readFileSync } from "node:fs";
process.loadEnvFile(".env");
const db = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
try {
  await db.begin(async tx => {
    if (process.argv.includes("--candidate")) await tx.unsafe(readFileSync("supabase/migrations/202610010033_wealth_history.sql", "utf8"));
    await tx.unsafe(readFileSync("supabase/tests/wealth-history.sql", "utf8"));
    console.log("PASS: exact wealth sources, optimistic edits, retry, reversible history and workspace isolation (rolled back)");
    throw new Error("ROLLBACK_OK");
  });
} catch (error) {
  if (error.message !== "ROLLBACK_OK") { console.error(error.message, error.position ?? "", error.where ?? ""); process.exitCode = 1; }
} finally { await db.end(); }
