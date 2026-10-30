// Signs the persistent QA user in through the local /login page and saves e2e/.auth.json
// for the authenticated Playwright specs. The first run creates the user and stores its
// login as E2E_USER_EMAIL / E2E_USER_PASSWORD in the git-ignored .env.
// Run with the app on http://localhost:3000 (or E2E_BASE_URL):  node --env-file=.env scripts/e2e-auth.mjs
// Empty its workspace (specs expect one):      node --env-file=.env scripts/e2e-auth.mjs --reset
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";
import postgres from "postgres";

const statePath = "e2e/.auth.json";
let email = process.env.E2E_USER_EMAIL, password = process.env.E2E_USER_PASSWORD;

if (process.argv.includes("--reset")) {
  if (!email) throw new Error("No E2E_USER_EMAIL in .env; run without --reset first");
  const db = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  await db.begin(async tx => {
    const [user] = await tx`select id, raw_user_meta_data->>'qa_test' as qa from auth.users where email=${email}`;
    if (user?.qa !== "e2e-auth") throw new Error("Refusing to reset a user not created by this script");
    const workspaces = (await tx`select id from public.workspaces where owner_id=${user.id}`).map(row => row.id);
    // Audit tables reference each other, so skip FK triggers for this one owned sweep.
    // ponytail: column-name sweep; extend the list if a new owner column appears.
    await tx`set local session_replication_role = replica`;
    const columns = await tx`select table_name, column_name from information_schema.columns join information_schema.tables using (table_schema, table_name)
      where table_schema='public' and table_type='BASE TABLE' and table_name <> 'workspaces'
      and column_name in ('workspace_id','actor_id','user_id','created_by')`;
    for (const { table_name, column_name } of columns)
      await tx.unsafe(`delete from public."${table_name}" where "${column_name}"::text = any($1::text[])`, [[user.id, ...workspaces]]);
    // Same starting categories a new signup gets from seed_default_categories().
    await tx`insert into public.categories(workspace_id,name) select w,n from unnest(${workspaces}::uuid[]) w cross join unnest(public.default_category_names()) n`;
  });
  await db.end();
  console.log("Emptied the QA user's workspace");
  process.exit(0);
}

if (!email) {
  email = `qa-${Date.now()}@example.test`;
  password = randomBytes(24).toString("base64url");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "e2e-auth" } });
  if (error) throw error;
  appendFileSync(".env", `\nE2E_USER_EMAIL=${email}\nE2E_USER_PASSWORD=${password}\n`);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 60_000 });
  await page.context().storageState({ path: statePath });
  console.log(`Saved ${statePath} for ${email}`);
} finally {
  await browser.close();
}
