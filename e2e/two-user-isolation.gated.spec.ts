import { test, expect, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";

test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  "Requires configured Supabase admin/auth/database for disposable real users; no stored auth state or email needed");

test("two real users isolate pages, APIs, statement files and review cancellation; account/view edits undo", async ({ browser }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const project = new URL(url).hostname.split(".")[0];
  const connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBeTruthy();
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const users: string[] = [], workspaces: string[] = [], contexts: BrowserContext[] = [];
  const runId = randomUUID(), recoveryPath = `.qa/isolation-${runId}.json`;
  mkdirSync(".qa", { recursive: true });
  const account = randomUUID(), transaction = randomUUID(), imported = randomUUID(), source = randomUUID(), job = randomUUID(), savedView = randomUUID();
  let artifact: string | undefined, storagePath: string | undefined;
  const secret = `Synthetic private ${randomUUID()}`;
  try {
    const sessions = [];
    for (let index = 0; index < 2; index++) {
      const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "two-user-isolation", run_id: runId } });
      expect(created.error).toBeNull();
      users.push(created.data.user!.id);
      const [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${created.data.user!.id}`;
      workspaces.push(workspace);
      writeFileSync(recoveryPath, JSON.stringify({ project, users, workspaces }));
      const cookies = new Map<string, string>();
      const auth = createServerClient(url, key, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => { for (const value of values) cookies.set(value.name, value.value); } } });
      const signedIn = await auth.auth.signInWithPassword({ email, password });
      expect(signedIn.error).toBeNull();
      const context = await browser.newContext({ baseURL: "http://localhost:3000" });
      contexts.push(context);
      await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
      sessions.push(auth);
    }
    const [workspace] = workspaces;
    storagePath = `${workspace}/${randomUUID()}.csv`;
    const upload = await admin.storage.from("imports").upload(storagePath, `date,description,amount\n2026-10-01,${secret},-1.00\n`, { contentType: "text/csv" });
    expect(upload.error).toBeNull();
    await db.begin(async tx => {
      await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${account},${workspace},${secret},'EUR')`;
      await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(${transaction},${workspace},${account},'2026-10-01',${secret},-100,'EUR')`;
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,review_rows) values(${imported},${workspace},'synthetic-private.csv',${storagePath!},${randomUUID()},'completed',1)`;
      await tx`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status) values(${source},${workspace},${imported},2,${tx.json({ description: secret })},'review')`;
      await tx`insert into public.background_jobs(id,workspace_id,kind) values(${job},${workspace},'financial_review')`;
      await tx`insert into public.transaction_views(id,workspace_id,name) values(${savedView},${workspace},${secret})`;
      await tx`select set_config('request.jwt.claim.sub',${users[0]},true)`;
      await tx.unsafe("set local role authenticated");
      [{ id: artifact }] = await tx`select (public.create_trusted_artifact('custom_tracker',${secret})).id`;
    });
    const [owner, foreign] = contexts;
    expect((await owner.request.get(`/api/imports/${imported}`)).status()).toBe(200);
    expect((await owner.request.get(`/api/artifacts/${artifact}/versions`)).status()).toBe(200);
    expect((await owner.request.get(`/api/analysis/${job}`)).status()).toBe(200);
    for (const path of [`/api/imports/${imported}`, `/api/artifacts/${artifact}/versions`, `/api/analysis/${job}`]) expect((await foreign.request.get(path)).status()).toBe(404);
    expect((await foreign.request.post(`/api/imports/${imported}/review`, { data: { sourceId: source, action: "reject" } })).status()).toBe(404);
    expect((await foreign.request.delete(`/api/analysis/${job}`)).status()).toBe(404);
    expect((await db`select status from public.background_jobs where id=${job}`)[0].status).toBe("queued");
    expect((await db`select status from public.source_transactions where id=${source}`)[0].status).toBe("review");
    expect((await sessions[0].storage.from("imports").download(storagePath)).error).toBeNull();
    expect((await sessions[1].storage.from("imports").download(storagePath)).error).not.toBeNull();
    const stranger = await foreign.newPage();
    for (const path of [`/import/${imported}/review`, `/ai/library/${artifact}`, `/ai/activity/${job}`]) {
      const response = await stranger.goto(path);
      expect(response?.status()).toBe(404);
      await expect(stranger.locator("body")).not.toContainText(secret);
    }
    await stranger.goto(`/money/transactions?transaction=${transaction}&view=${savedView}`);
    await expect(stranger.locator("body")).not.toContainText(secret);
    const page = await owner.newPage();
    await page.goto(`/import/${imported}/review`);
    await expect(page.locator("body")).toContainText(secret);
    await page.goto("/money/accounts");
    const article = page.locator("article").filter({ hasText: secret });
    await article.getByLabel("Name", { exact: true }).fill(`${secret} renamed`);
    await article.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.locator("article strong")).toHaveText(`${secret} renamed`);
    await page.getByRole("button", { name: "Archive account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restore account", exact: true })).toBeVisible();
    await expect(page.locator("article")).toContainText("Archived");
    await page.getByRole("button", { name: "Undo", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Archive account", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).first().click();
    await expect(page.locator("article strong")).toHaveText(secret);
    await page.goto("/money/transactions");
    const views = page.getByRole("region", { name: "Saved views" });
    await views.getByLabel(`Rename saved view ${secret}`).fill(`${secret} renamed view`);
    await views.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(views.getByRole("link", { name: `${secret} renamed view`, exact: true })).toBeVisible();
    await views.getByRole("button", { name: `Delete saved view ${secret} renamed view`, exact: true }).click();
    await expect(views.getByRole("link", { name: `${secret} renamed view`, exact: true })).toHaveCount(0);
    await page.goto("/money/accounts");
    await page.getByRole("button", { name: "Undo", exact: true }).first().click();
    await expect.poll(async () => (await db`select removed_at from public.transaction_views where id=${savedView}`)[0].removed_at).toBeNull();
    await page.goto("/money/transactions");
    await expect(views.getByRole("link", { name: `${secret} renamed view`, exact: true })).toBeVisible();
    await page.goto(`/money/transactions?q=${encodeURIComponent(secret)}`);
    await views.getByRole("button", { name: `Update filters for saved view ${secret} renamed view`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=${savedView}$`));
    expect(new URL(page.url()).searchParams.has("q")).toBe(false);
    await expect.poll(async () => (await db`select filters from public.transaction_views where id=${savedView}`)[0].filters.q).toBe(secret);
    expect((await owner.request.delete(`/api/analysis/${job}`)).status()).toBe(200);
    expect((await db`select status from public.background_jobs where id=${job}`)[0].status).toBe("canceled");
  } finally {
    for (const context of contexts) await context.close();
    if (storagePath) expect((await admin.storage.from("imports").remove([storagePath])).error).toBeNull();
    for (const workspace of workspaces) await db.begin(async tx => {
      await tx`delete from public.money_metadata_events where workspace_id=${workspace}`;
      await tx`delete from public.transaction_views where workspace_id=${workspace}`;
      await tx`delete from public.saved_analyses where workspace_id=${workspace}`;
      await tx`delete from public.background_jobs where workspace_id=${workspace}`;
      await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace}`;
      await tx`delete from public.artifact_state where workspace_id=${workspace}`;
      await tx`delete from public.artifact_versions where workspace_id=${workspace}`;
      await tx`delete from public.artifacts where workspace_id=${workspace}`;
      await tx`delete from public.source_transactions where workspace_id=${workspace}`;
      await tx`delete from public.imports where workspace_id=${workspace}`;
      await tx`delete from public.transactions where workspace_id=${workspace}`;
      await tx`delete from public.accounts where workspace_id=${workspace}`;
      await tx`delete from public.workspaces where id=${workspace} and owner_id in ${tx(users)}`;
    });
    for (const user of users) expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    if (users.length) expect((await db`select id from auth.users where id in ${db(users)}`).length).toBe(0);
    if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
    await db.end();
  }
});
