import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import postgres from "postgres";

test("owned September/August investigation uses exact splits/refunds, complete support, FX and read-only scenarios", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  for (const key of ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) expect(process.env[key], `${key} required`).toBeTruthy();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(process.env.SUPABASE_DB_URL!, { ssl: "require", max: 1, onnotice: () => {} });
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const run = randomUUID(), account = randomUUID(), otherAccount = randomUUID(), groceries = randomUUID(), travel = randomUUID(), merchant = randomUUID(), split = randomUUID(), splitSet = randomUUID(), series = randomUUID();
  const foreignAccount = randomUUID(), imported = randomUUID(), source = randomUUID();
  const email = `qa-${run}@example.invalid`, password = randomBytes(24).toString("hex"), journal = `.qa/mne017-${run}.json`;
  let user: string | undefined, workspace: string | undefined, foreignUser: string | undefined, foreignWorkspace: string | undefined;
  mkdirSync(".qa", { recursive: true });
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "mne017-investigation", run_id: run } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    writeFileSync(journal, JSON.stringify({ user, workspace, run }));
    const foreignCreated = await admin.auth.admin.createUser({ email: `qa-foreign-${run}@example.invalid`, password: randomBytes(24).toString("hex"), email_confirm: true, user_metadata: { qa_test: "mne017-isolation", run_id: run } });
    expect(foreignCreated.error).toBeNull(); foreignUser = foreignCreated.data.user!.id;
    [{ id: foreignWorkspace }] = await db`select id from public.workspaces where owner_id=${foreignUser}`;
    writeFileSync(journal, JSON.stringify({ user, workspace, foreignUser, foreignWorkspace, run }));
    const ids = Array.from({ length: 25 }, () => randomUUID());
    await db.begin(async tx => {
      for (const [id, name] of [[account, "Synthetic account A"], [otherAccount, "Synthetic account B"]]) await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${id},${workspace!},${name},'EUR')`;
      for (const [id, name] of [[groceries, "Synthetic groceries"], [travel, "Synthetic travel"]]) await tx`insert into public.categories(id,workspace_id,name) values(${id},${workspace!},${name})`;
      await tx`insert into public.merchants(id,workspace_id,name,normalized_name) values(${merchant},${workspace!},'Synthetic shop','synthetic shop')`;
      const insert = async (id: string, amount: string, date = "2026-09-03", options: { account?: string; currency?: string; kind?: string; status?: string; event?: string; reasons?: string[] } = {}) => tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,category_id,merchant_id,tags,event_name,kind,status,review_reasons)
        values(${id},${workspace!},${options.account ?? account},${date},'Synthetic grocery record',${amount},${options.currency ?? "EUR"},${groceries},${merchant},array['food'],${options.event ?? null},${options.kind ?? "ordinary"},${options.status ?? "posted"},${options.reasons ?? []})`;
      for (const id of ids) await insert(id, "-100");
      await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${foreignAccount},${foreignWorkspace!},'Synthetic account A','EUR')`;
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows) values(${imported},${workspace!},'synthetic.csv',${`${workspace}/synthetic.csv`},${imported},'completed',1)`;
      await tx`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,normalized_row,status) values(${source},${workspace!},${imported},2,${tx.json({ description: "Synthetic source record", amount: "-1.00" })},${tx.json({ rowContractVersion: "normalized-row-v1", accountId: account, row: { postedOn: "2026-09-03", currencyCode: "EUR", amountMinor: "-100", description: "Synthetic source record" } })},'new')`;
      await tx`insert into public.transaction_sources(transaction_id,source_transaction_id) values(${ids[0]},${source})`;
      await insert(randomUUID(), "-1000", "2026-08-03");
      await insert(randomUUID(), "-9999", undefined, { account: otherAccount });
      await insert(randomUUID(), "-999", undefined, { event: "Berlin trip" });
      await insert(randomUUID(), "-500", undefined, { kind: "transfer" });
      await insert(randomUUID(), "-500", undefined, { reasons: ["source_transfer"] });
      await insert(randomUUID(), "-100", undefined, { status: "pending" });
      await insert(randomUUID(), "30", undefined, { kind: "refund" });
      await insert(randomUUID(), "-200", undefined, { currency: "USD" });
      await insert(split, "-100");
      await tx`insert into public.transaction_split_sets(id,workspace_id,transaction_id,request_id,actor_id,before,after) values(${splitSet},${workspace!},${split},${randomUUID()},${user!},'{}','{}')`;
      await tx`insert into public.transaction_splits(workspace_id,parent_transaction_id,split_set_id,category_id,amount_minor,ordinal) values(${workspace!},${split},${splitSet},${groceries},-60,1),(${workspace!},${split},${splitSet},${travel},-40,2)`;
      await tx`insert into public.fx_rates(workspace_id,from_currency,to_currency,rate_text,rate_date,source) values(${workspace!},'USD','EUR','0.5','2026-09-03','synthetic dated evidence')`;
      await tx`insert into public.recurring_series(id,workspace_id,account_id,label,normalized_label,cadence,currency_code,amount_min_minor,amount_max_minor,occurrences,confidence,status) values(${series},${workspace!},${account},'Synthetic groceries','synthetic groceries','monthly','EUR',-100,-100,3,50,'pending')`;
      for (const id of ids.slice(0, 3)) await tx`insert into public.recurring_series_transactions(series_id,transaction_id,workspace_id) values(${series},${id},${workspace!})`;
    });
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, key, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => { for (const value of values) cookies.set(value.name, value.value); } } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const query = { version: 1, period: { from: "2026-09-01", to: "2026-09-30" }, comparison: { from: "2026-08-01", to: "2026-08-31" },
      accounts: { include: [{ name: "Synthetic account A" }] }, categories: { include: [{ name: "Synthetic groceries" }] }, merchants: { include: [{ name: "Synthetic shop" }] },
      tags: { include: ["food"] }, events: { exclude: ["Berlin trip"] }, groupBy: ["category", "merchant"], metric: "spending" };
    const request = async (input: unknown) => { const response = await context.request.post("/api/investigations", { data: input }); expect(response.status(), await response.text()).toBe(200); return response.json(); };
    const result = await request({ operation: "query", query });
    expect(result.groups.find((g: { currency: string }) => g.currency === "EUR")).toMatchObject({ currentMinor: "2530", comparisonMinor: "1000", deltaMinor: "1530" });
    expect(result.groups.find((g: { currency: string }) => g.currency === "USD").currentMinor).toBe("200");
    expect(result.records.total).toBe(29);
    expect(result.records.items.length).toBe(25);
    const next = await request({ operation: "query", query: { ...query, page: { cursor: result.records.nextCursor } } });
    expect(next.records.items.length).toBe(4); expect(next.records.nextCursor).toBeNull();
    expect(new Set([...result.records.items, ...next.records.items].map((r: { id: string }) => r.id)).size).toBe(29);
    const sourced = [...result.records.items, ...next.records.items].find((r: { id: string }) => r.id === ids[0]);
    expect(sourced.sourceVersions[0]).toMatchObject({ id: source, importId: imported, link: `/import/${imported}/review`, import: { run_version: 1, status: "completed" } });
    expect(result.coverage).toMatchObject({ classificationExcluded: 1, pendingExcluded: 1, transferExcluded: 1, partial: true });
    expect(result.coverage.sourceCoverage.current.financialCompleteness).toBe("unknown");
    const base = await request({ operation: "query", query: { ...query, currencyPolicy: { mode: "base", currency: "EUR" } } });
    expect(base.groups[0].currentMinor).toBe("2630");
    expect(base.reporting.postings.find((r: { originalCurrencyCode: string }) => r.originalCurrencyCode === "USD").rate.source).toBe("synthetic dated evidence");
    const detail = await request({ operation: "detail", detail: { kind: "transaction", id: split } });
    expect(detail.transaction.amount_minor).toBe("-100"); expect(detail.effectiveRows.map((r: { amountMinor: string }) => r.amountMinor).sort()).toEqual(["-40", "-60"]);
    const recurring = await request({ operation: "detail", detail: { kind: "recurring", id: series, size: 2 } });
    expect(recurring.total).toBe(3); expect(recurring.nextOffset).toBe(2);
    const hypothetical = await request({ operation: "scenario", scenario: { query, overrides: [{ id: ids[0], amountMinor: "-300" }] } });
    expect(hypothetical.canonicalMutations).toBe(false); expect(hypothetical.hypothetical.groups.find((g: { currency: string }) => g.currency === "EUR").currentMinor).toBe("2730");
    expect((await db`select amount_minor::text from public.transactions where id=${ids[0]} and workspace_id=${workspace!}`)[0].amount_minor).toBe("-100");
    const foreign = await context.request.post("/api/investigations", { data: { operation: "query", query: { ...query, accounts: { include: [{ id: foreignAccount }] } } } }); expect(foreign.status()).toBe(400);
    const malformed = await context.request.post("/api/investigations", { data: { operation: "query", query: { ...query, period: { from: "2026-02-30", to: "2026-03-01" } } } }); expect(malformed.status()).toBe(400);
    const page = await context.newPage();
    await page.goto(`/money/investigations?${new URLSearchParams({ query: JSON.stringify(query) })}`);
    await expect(page.getByRole("heading", { name: "Investigate your money" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Comparison results" })).toContainText("EUR 25.30");
    await expect(page.getByRole("region", { name: "Interpreted scope" })).toContainText("exclude events: Berlin trip");
    await expect(page.getByRole("listbox", { name: "Include (empty means all)" }).first()).toHaveValues([account]);
    await page.screenshot({ path: ".qa/mne017-investigation-desktop.png", fullPage: true });
    await page.getByRole("link", { name: "Open records (28)" }).click();
    await expect(page.getByRole("heading", { name: "Supporting records (28)" })).toBeVisible();
    await page.getByRole("link", { name: "Next supporting records" }).click();
    await expect(page.getByRole("region", { name: "Supporting records" }).locator("tbody tr")).toHaveCount(3);
    await page.getByRole("region", { name: "Supporting records" }).getByRole("link", { name: "Synthetic grocery record" }).first().click();
    await expect(page.getByRole("complementary", { name: "Transaction details" })).toBeVisible();
    const anonymous = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    try { expect((await anonymous.request.post("/api/investigations", { data: { operation: "entities" } })).status()).toBe(401); } finally { await anonymous.close(); }
    writeFileSync(".qa/mne017-browser-result.json", JSON.stringify({ result: "pass", syntheticOnly: true, rowPages: [25, 4], eurCurrentMinor: "2530", eurBaseCurrentMinor: "2630", canonicalMutations: false }));
  } finally {
    await context.close();
    if (workspace) await db.begin(async tx => {
      await tx`delete from public.transaction_sources where source_transaction_id in (select id from public.source_transactions where workspace_id=${workspace!})`;
      for (const table of ["recurring_series_transactions", "recurring_series", "transaction_splits", "transaction_split_sets", "transactions", "fx_rates", "accounts", "categories", "merchants", "workspace_settings"])
        await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      await tx`delete from public.source_transactions where workspace_id=${workspace!}`;
      await tx`delete from public.imports where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (foreignWorkspace) await db.begin(async tx => {
      for (const table of ["accounts", "categories", "workspace_settings"]) await tx`delete from ${tx("public." + table)} where workspace_id=${foreignWorkspace!}`;
      await tx`delete from public.workspaces where id=${foreignWorkspace!} and owner_id=${foreignUser!}`;
    });
    for (const actor of [user, foreignUser]) if (actor) { expect((await admin.auth.admin.deleteUser(actor)).error).toBeNull(); expect((await db`select id from auth.users where id=${actor}`).length).toBe(0); }
    if (workspace) expect((await db`select id from public.workspaces where id=${workspace}`).length).toBe(0);
    if (foreignWorkspace) expect((await db`select id from public.workspaces where id=${foreignWorkspace}`).length).toBe(0);
    if (user) unlinkSync(journal);
    await db.end();
  }
});
