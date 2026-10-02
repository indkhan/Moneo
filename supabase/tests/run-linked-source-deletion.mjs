import postgres from "postgres";
import { readFileSync } from "node:fs";
process.loadEnvFile(".env");
const db=postgres(process.env.SUPABASE_DB_URL,{ssl:"require",max:1});
try { await db.begin(async tx=>{
  if(process.argv.includes("--candidate")) await tx.unsafe(readFileSync("supabase/migrations/202610010050_preserve_linked_sources.sql","utf8"));
  await tx.unsafe(readFileSync("supabase/tests/linked-source-deletion.sql","utf8"));
  console.log("PASS: legacy linked source retention and valid manual tombstone undo (rolled back)"); throw new Error("ROLLBACK_OK");
}); } catch(error) { if(error.message!=="ROLLBACK_OK") { console.error(error.message); process.exitCode=1; } } finally {await db.end();}
