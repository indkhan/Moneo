// Creates a disposable confirmed QA user, signs in through the local /login page and
// saves e2e/.auth.json for the authenticated Playwright specs.
// Run with the app on http://localhost:3000:  node --env-file=.env scripts/e2e-auth.mjs
// Remove the user afterwards:                 node --env-file=.env scripts/e2e-auth.mjs --delete
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";
import postgres from "postgres";

const journal = ".qa/e2e-auth-user.json", statePath = "e2e/.auth.json";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

if (process.argv.includes("--delete")) {
  if (!existsSync(journal)) throw new Error(`No ${journal}; nothing to delete`);
  const { id } = JSON.parse(readFileSync(journal, "utf8"));
  // Audit history (e.g. planning_events) blocks a plain user delete, so remove the disposable
  // workspace's rows directly. ponytail: column-name sweep; add a table here if a new owner column appears.
  const db = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  await db.begin(async tx => {
    const [user] = await tx`select raw_user_meta_data->>'qa_test' as qa from auth.users where id=${id}`;
    if (user?.qa !== "e2e-auth") throw new Error("Refusing to delete a user not created by this script");
    const owned = [id, ...(await tx`select id from public.workspaces where owner_id=${id}`).map(row => row.id)];
    await tx`set local session_replication_role = replica`;
    const columns = await tx`select table_name, column_name from information_schema.columns join information_schema.tables using (table_schema, table_name)
      where table_schema='public' and table_type='BASE TABLE' and column_name in ('workspace_id','actor_id','user_id','owner_id','created_by')`;
    for (const { table_name, column_name } of columns)
      await tx.unsafe(`delete from public."${table_name}" where "${column_name}"::text = any($1::text[])`, [owned]);
    await tx`delete from public.workspaces where owner_id=${id}`;
    await tx`delete from auth.users where id=${id}`;
  });
  await db.end();
  rmSync(journal); rmSync(statePath, { force: true });
  console.log("Deleted QA user, its workspace and auth state");
  process.exit(0);
}

const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const email = `qa-${Date.now()}@example.test`, password = randomBytes(24).toString("base64url");
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "e2e-auth" } });
if (error) throw error;
mkdirSync(".qa", { recursive: true });
writeFileSync(journal, JSON.stringify({ id: data.user.id, email }));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ baseURL: base });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.context().storageState({ path: statePath });
  console.log(`Saved ${statePath} for ${email}`);
} catch (cause) {
  await admin.auth.admin.deleteUser(data.user.id); // don't leave an orphan behind a failed sign-in
  rmSync(journal);
  throw cause;
} finally {
  await browser.close();
}
