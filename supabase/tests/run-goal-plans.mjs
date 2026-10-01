import postgres from "postgres";
import { readFileSync } from "node:fs";
process.loadEnvFile(".env");
const db=postgres(process.env.SUPABASE_DB_URL,{ssl:"require",max:1,onnotice:()=>{}});
const rollback=new Error("verified rollback");
try {
  try { await db.begin(async tx=>{
    if(process.argv.includes("--candidate")) await tx.unsafe(readFileSync("supabase/migrations/202610010037_goal_plans.sql","utf8"));
    if(process.argv.includes("--date-candidate")) await tx.unsafe(readFileSync("supabase/migrations/202610010039_goal_evidence_date.sql","utf8"));
    await tx.unsafe(readFileSync("supabase/tests/goal-plans.sql","utf8"));
    throw rollback;
  }); } catch(error) { if(error!==rollback) throw error; }
  console.log("PASS: exact goal history, dated savings, retry, stale edits, sequential undo and isolation (rolled back)");
} finally {await db.end();}
