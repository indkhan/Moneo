// Database checks against the local backend: migration replay with the SQL regressions, then the
// opt-in *.live.test.ts files one at a time (their fixtures lock shared tables). Synthetic data only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL missing: run npm run setup first");
const flags = ["RESERVATION", "IMPORT_EXCLUSION", "IMPORT_ROW_UNDO", "VERIFIED_EVIDENCE", "INVESTIGATION_REQUEST"];
const env = { ...process.env, ...Object.fromEntries(flags.map(flag => [`RUN_${flag}_DB_TESTS`, "1"])) };
for (const args of [["supabase/tests/migrations.mjs"], ["node_modules/vitest/vitest.mjs", "run", "--no-file-parallelism", ".live.test.ts"]]) {
  const { status } = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
}
