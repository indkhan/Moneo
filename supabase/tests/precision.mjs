// Actual PostgREST verification with synthetic records and targeted cleanup.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

process.loadEnvFile(".env");
const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
const connection = new URL(process.env.SUPABASE_DB_URL);
const project = endpoint.hostname.split(".")[0];
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured project mismatch");
const db = postgres(connection.toString(), { ssl: "require", max: 1 });
const user = randomUUID(), account = randomUUID(), transaction = randomUUID();
const category = randomUUID(), plan = randomUUID();
const exact = "9007199254740993";
let workspace;
const recoveryPath = ".qa/precision-recovery.json";
assert(!existsSync(recoveryPath), "Recover the exact previous precision fixture before rerunning");
mkdirSync(".qa", { recursive: true });
writeFileSync(recoveryPath, JSON.stringify({ project, user, account, transaction, category, plan }));
try {
  await db.begin(async tx => {
    await tx`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
    [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${user}`;
    await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${account},${workspace},'Synthetic exact money','EUR')`;
    await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
      values(${transaction},${workspace},${account},'2026-10-01','Synthetic exact money',${exact},'EUR')`;
    await tx`insert into public.categories(id,workspace_id,name) values(${category},${workspace},'Synthetic exact limit')`;
    await tx`insert into public.spending_plans(id,workspace_id,category_id,currency_code,limit_minor)
      values(${plan},${workspace},${category},'EUR',${exact})`;
  });
  writeFileSync(recoveryPath, JSON.stringify({ project, user, workspace, account, transaction, category, plan }));
  const url = new URL("/rest/v1/transactions", endpoint);
  url.searchParams.set("id", `eq.${transaction}`);
  // Read the actual page selectors so wildcard detail reads are checked too.
  const { readFileSync } = await import("node:fs");
  const files = ["app/money/transactions/page.tsx", "app/money/recurring/page.tsx", "app/plan/spending/page.tsx"];
  const selections = [...new Set(files.flatMap(file => [...readFileSync(file, "utf8").matchAll(/\.from\(([^)]*)\)\s*\.select\("([^"]*amount_minor[^"]*)"/g)]
    .filter(match => /"(?:transactions|effective_transactions|transaction_category_ledger)"/.test(match[1])).map(match => match[2])))];
  assert(selections.length > 0);
  for (const table of ["transactions", "effective_transactions", "transaction_category_ledger"]) for (const selection of selections) {
    url.pathname = `/rest/v1/${table}`;
    url.searchParams.set("select", selection);
    const response = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
    assert.equal(response.status, 200, `PostgREST ${table} SELECT ${selection} must succeed: ${response.ok ? "" : await response.text()}`);
    const rows = await response.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount_minor, exact, `Exact amount lost for SELECT ${selection}`);
  }
  const limitSelect = readFileSync("app/plan/spending/page.tsx", "utf8").match(/\.select\("([^"]*limit_minor[^"]*)"/)[1];
  const limitUrl = new URL("/rest/v1/spending_plans", endpoint);
  limitUrl.searchParams.set("id", `eq.${plan}`);
  limitUrl.searchParams.set("select", limitSelect);
  const limitResponse = await fetch(limitUrl, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
  assert.equal(limitResponse.status, 200);
  assert.equal((await limitResponse.json())[0].limit_minor, exact);
  console.log(`PASS: ${selections.length * 3} page/view SELECTs preserve a bigint beyond Number.MAX_SAFE_INTEGER`);
} finally {
  await db.begin(async tx => {
    await tx`delete from public.spending_plans where id=${plan} and workspace_id=${workspace ?? null}`;
    await tx`delete from public.spending_plan_limits where workspace_id=${workspace ?? null}`;
    if ((await tx`select to_regclass('public.planning_events') present`)[0].present)
      await tx`delete from public.planning_events where workspace_id=${workspace ?? null}`;
    await tx`delete from public.categories where workspace_id=${workspace ?? null}`;
    await tx`delete from public.transactions where id=${transaction} and workspace_id=${workspace ?? null}`;
    await tx`delete from public.accounts where id=${account} and workspace_id=${workspace ?? null}`;
    await tx`delete from public.workspaces where id=${workspace ?? null} and owner_id=${user}`;
    await tx`delete from auth.users where id=${user}`;
  });
  assert.equal((await db`select 1 from auth.users where id=${user}`).length, 0, "Synthetic user cleanup must complete");
  unlinkSync(recoveryPath);
  await db.end();
}
