import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable Supabase authentication and migration013");

test("owned Stop and reload distinguish request, worker acknowledgment and unconfirmed termination", async ({ browser }) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  let user: string | undefined, workspace: string | undefined, journal: string | undefined;
  const context = await browser.newContext({ baseURL: "http://localhost:3000" });
  try {
    const [migration] = await db`select pg_get_functiondef('public.cancel_financial_review(uuid)'::regprocedure) definition`;
    expect(migration.definition).toContain("return 'cancel_requested'");
    const [failure] = await db`select pg_get_functiondef('public.fail_financial_review(uuid,uuid,text,text,text)'::regprocedure) definition`;
    expect(failure.definition).toContain("cancellation_unconfirmed");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "provider-stop" } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    journal = `.qa/provider-stop-${user}.json`;
    mkdirSync(".qa", { recursive: true }); writeFileSync(journal, JSON.stringify({ project, user, workspace }));
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const account = randomUUID(), transaction = randomUUID(), correction = randomUUID(), completed = randomUUID(), job = randomUUID(), uncertain = randomUUID();
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace!},'Synthetic cash','EUR','checking')`;
    await db`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,note) values(${transaction},${workspace!},${account},'2026-10-01','Synthetic posting',-1000,'EUR','Completed intentional correction')`;
    await db`insert into public.correction_events(id,workspace_id,transaction_id,actor_id,before,after) values(${correction},${workspace!},${transaction},${user},'{"note":null}','{"note":"Completed intentional correction"}')`;
    const originalTransaction = (await db`select * from public.transactions where id=${transaction}`)[0];
    const originalCorrection = (await db`select * from public.correction_events where id=${correction}`)[0];
    await db`insert into public.background_jobs(id,workspace_id,kind,status,stage) values(${completed},${workspace!},'financial_review','completed','completed')`;
    await db`insert into public.saved_analyses(workspace_id,job_id,title,body,evidence) values(${workspace!},${completed},'Completed historical review','Synthetic retained body','{}')`;
    const run = `wrun_synthetic_${randomUUID()}`;
    await db`insert into public.background_jobs(id,workspace_id,kind,status,stage,workflow_run_id,dispatched_at) values(${job},${workspace!},'financial_review','running','writing_review',${run},now())`;
    const page = await context.newPage();
    await page.goto("/ai");
    await page.getByLabel("Saved reviews").selectOption(job);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Stop requested. Waiting for active work");
    expect(await (await context.request.get(`/api/analysis/${job}`)).json()).toMatchObject({ status: "running", stage: "cancel_requested", cancel_requested: true, analysis: null });
    await page.reload();
    await expect(page.getByRole("status")).toContainText("Stop requested. Waiting for active work");
    expect((await context.request.delete(`/api/analysis/${randomUUID()}`)).status()).toBe(404);
    // Installed-runtime transport acknowledgment is separately exercised by the
    // real HTTP provider test. This gate verifies its persisted receipt/UI contract.
    expect((await admin.rpc("fail_financial_review", { p_job_id: job, p_workspace_id: workspace, p_run_id: run, p_stage: "writing_review", p_error: "Synthetic settled transport" })).data).toBe("canceled");
    await page.reload();
    await expect(page.getByText("Application work stopped.", { exact: false })).toBeVisible();
    expect(await (await context.request.get(`/api/analysis/${job}`)).json()).toMatchObject({ status: "canceled", stage: "canceled", cancel_requested: true, analysis: null });
    expect((await admin.rpc("finish_financial_review", { p_job_id: job, p_workspace_id: workspace, p_title: "Late", p_body: "Late synthetic result", p_evidence: {}, p_scheduled: false })).data).toBe("canceled");
    expect(await (await context.request.delete(`/api/analysis/${completed}`)).json()).toEqual({ status: "completed" });
    expect((await db`select body from public.saved_analyses where job_id=${completed}`)[0].body).toBe("Synthetic retained body");
    expect((await db`select * from public.transactions where id=${transaction}`)[0]).toEqual(originalTransaction);
    expect((await db`select * from public.correction_events where id=${correction}`)[0]).toEqual(originalCorrection);
    await db`insert into public.background_jobs(id,workspace_id,kind,status,stage,cancel_requested,workflow_run_id,dispatched_at) values(${uncertain},${workspace!},'financial_review','running','cancel_requested',true,${run + '_uncertain'},now())`;
    expect((await admin.rpc("fail_financial_review", { p_job_id: uncertain, p_workspace_id: workspace, p_run_id: run + "_uncertain", p_stage: "cancellation_unconfirmed", p_error: "Synthetic runtime ended with a running step" })).data).toBe("canceled");
    await page.reload();
    await expect(page.getByText("request termination could not be confirmed", { exact: false })).toBeVisible();
    await expect(page.getByText("Application work stopped.", { exact: false })).toHaveCount(0);
  } finally {
    await context.close().catch(() => {});
    if (workspace && user) {
      await db.begin(async tx => {
        for (const table of ["saved_analyses", "background_jobs", "correction_events", "transactions", "accounts", "workspace_settings"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
        await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
      });
      expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
      if (journal) unlinkSync(journal);
    }
    await db.end();
  }
});
