import postgres from "postgres";
import { readFileSync } from "node:fs";

process.loadEnvFile(".env");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is required");
const db = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
try {
  await db.begin(async tx => {
    if (process.argv.includes("--candidate")) await tx.unsafe(readFileSync("supabase/migrations/202610010021_planning_history.sql", "utf8"));
    await tx.unsafe(readFileSync("supabase/tests/planning-history.sql", "utf8"));
    console.log("PASS: planning exact money, audit, retry, stale edits, soft removal, sequential undo and isolation (rolled back)");
    throw new Error("ROLLBACK_OK");
  });
} catch (error) {
  if (error.message !== "ROLLBACK_OK") { console.error(error.message, error.position ?? "", error.internalPosition ?? "", error.where ?? ""); process.exitCode = 1; }
} finally { await db.end(); }
