import postgres from "postgres";
import { readFileSync } from "node:fs";
process.loadEnvFile(".env");
const db = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
try {
  await db.begin(async tx => {
    if (process.argv.includes("--candidate")) await tx.unsafe(readFileSync("supabase/migrations/202610010041_verified_transaction_links.sql", "utf8"));
    await tx.unsafe(readFileSync("supabase/tests/verified-links.sql", "utf8"));
    console.log("PASS: dated FX links, exact fee expenses, aggregate partial refunds, versioned undo and foreign isolation (rolled back)");
    throw new Error("ROLLBACK_OK");
  });
} catch (error) {
  if (error.message !== "ROLLBACK_OK") { console.error(error.message); process.exitCode = 1; }
} finally { await db.end(); }
