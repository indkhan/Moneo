// Signs the persistent QA user in and saves e2e/.auth.json for the authenticated Playwright
// specs, so tests never touch the owner's workspace. The first run creates the user and stores
// its login as E2E_USER_EMAIL / E2E_USER_PASSWORD in the git-ignored .env.
// Sign in (E2E_BASE_URL defaults to http://localhost:3000):  node --env-file=.env scripts/e2e-auth.mjs
// Empty its workspace (specs expect one):      node --env-file=.env scripts/e2e-auth.mjs --reset
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
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

// There is no sign-in page (the app signs its owner in automatically), so sign the QA user in
// here and save its session cookie: with it, the app serves the QA user's workspace instead.
const cookies = [];
const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  cookies: { getAll: () => [], setAll: list => cookies.push(...list) },
});
const { error } = await auth.auth.signInWithPassword({ email, password });
if (error) throw error;
const { hostname } = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000");
const expires = Math.floor(Date.now() / 1000) + 400 * 86_400;
writeFileSync(statePath, JSON.stringify({ cookies: cookies.map(({ name, value }) => ({ name, value, domain: hostname, path: "/", expires, httpOnly: false, secure: false, sameSite: "Lax" })), origins: [] }, null, 2));
console.log(`Saved ${statePath} for ${email}`);
