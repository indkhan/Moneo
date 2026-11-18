import { createHmac, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { expect, it } from "vitest";
import { confirmOwnAccount, linkOwnTransfers } from "./own-transfers";

const enabled = process.env.RUN_OWN_TRANSFERS_DB_TESTS === "1";
const OLD_ACCOUNT = "DE02120300000000202051";

async function fixture() {
  process.loadEnvFile(".env.qa");
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const user = randomUUID();
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user, role: "authenticated", aud: "authenticated", iat: now, exp: now + 300 })}`;
  const token = `${unsigned}.${createHmac("sha256", process.env.JWT_SECRET!).update(unsigned).digest("base64url")}`;
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  await db`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
  const [{ id: workspace }] = await db<{ id: string }[]>`select id from public.workspaces where owner_id=${user}`;
  const account = randomUUID(), imported = randomUUID();
  await db`insert into public.accounts(id,workspace_id,name,currency_code) values(${account},${workspace},'Current','EUR')`;
  await db`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,mapping) values(${imported},${workspace},'synthetic.csv','synthetic',${imported},'completed','{}')`;
  let row = 1;
  const payment = async (day: string, name: string, iban: string | null = null) => {
    const id = randomUUID(), source = randomUUID();
    await db`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status,review_reasons)
      values(${source},${workspace},${imported},${row++},${db.json({ counterparty: name, ...(iban ? { counterparty_iban: iban } : {}) })},'new',array['source_transfer'])`;
    await db`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,review_reasons)
      values(${id},${workspace},${account},${day},${`${name} main`},-1000,'EUR',array['source_transfer'])`;
    await db`insert into public.transaction_sources(transaction_id,source_transaction_id) values(${id},${source})`;
    return id;
  };
  const states = (ids: string[]) => db<{ id: string; kind: string; review_reasons: string[] }[]>`select id, kind, review_reasons from public.transactions where id in ${db(ids)}`
    .then(rows => ids.map(id => rows.find(item => item.id === id)!));
  const cleanup = async () => {
    await supabase.rpc("reset_workspace");
    for (const table of ["accounts", "categories", "workspace_settings"]) await db.unsafe(`delete from public.${table} where workspace_id in (select id from public.workspaces where owner_id = $1)`, [user]);
    await db`delete from public.workspaces where owner_id=${user}`;
    await db`delete from auth.users where id=${user}`;
    await db.end();
  };
  return { db, supabase, workspace, payment, states, cleanup };
}

it.skipIf(!enabled)("one yes to an old account marks every payment with it, now and later, and one undo reverts them all", { timeout: 60_000 }, async () => {
  const { db, supabase, workspace, payment, states, cleanup } = await fixture();
  try {
    const first = await payment("2026-03-01", "Usman Khan", OLD_ACCOUNT), second = await payment("2026-03-02", "Usman Khan", OLD_ACCOUNT), third = await payment("2026-03-03", "Usman Khan", OLD_ACCOUNT);
    const stranger = await payment("2026-03-04", "Landlord", "DE44500105175407324931");
    await db`insert into public.agent_proposals(workspace_id,agent,kind,conflict_key,title,payload)
      values(${workspace},'chat','own_transfer',${`own_transfer:${second}`},'Usman Khan: your own account?',${db.json({ transactionId: second, name: "Usman Khan" })})`;

    await confirmOwnAccount(supabase, workspace, first, "Usman Khan", { locale: "en-GB", timezone: "UTC", now: new Date() });
    expect((await states([first, second, third, stranger])).map(item => item.kind)).toEqual(["transfer", "transfer", "transfer", "ordinary"]);
    const [identifier] = await db<{ id: string; iban: string; confirmed: boolean; account_id: string | null }[]>`select id, iban, confirmed, account_id from public.own_account_identifiers where workspace_id=${workspace}`;
    expect(identifier).toMatchObject({ iban: OLD_ACCOUNT, confirmed: true, account_id: null });
    expect((await db`select status from public.agent_proposals where workspace_id=${workspace}`)[0].status).toBe("accepted");

    const later = await payment("2026-04-01", "Usman Khan", OLD_ACCOUNT);
    await linkOwnTransfers(supabase, workspace, { locale: "en-GB", timezone: "UTC", now: new Date() });
    expect((await states([later]))[0].kind).toBe("transfer");

    const { data: reverted, error } = await supabase.rpc("undo_own_account_confirmation", { p_identifier_id: identifier.id });
    expect(error).toBeNull();
    expect(reverted).toBe(4);
    expect((await states([first, second, third, later])).map(({ kind, review_reasons }) => ({ kind, review_reasons }))).toEqual(Array(4).fill({ kind: "ordinary", review_reasons: ["source_transfer"] }));
    expect(await db`select id from public.own_account_identifiers where workspace_id=${workspace}`).toHaveLength(0);
  } finally { await cleanup(); }
});

it.skipIf(!enabled)("remembers an old account that carries no IBAN by its name, and leaves other names alone", { timeout: 60_000 }, async () => {
  const { db, supabase, workspace, payment, states, cleanup } = await fixture();
  try {
    const first = await payment("2026-03-01", "Usman Khan"), second = await payment("2026-03-02", "USMAN  KHAN"), other = await payment("2026-03-03", "Landlord");
    await confirmOwnAccount(supabase, workspace, first, "Usman Khan", { locale: "en-GB", timezone: "UTC", now: new Date() });
    expect((await states([first, second, other])).map(item => item.kind)).toEqual(["transfer", "transfer", "ordinary"]);
    expect(await db`select name_key, iban from public.own_account_identifiers where workspace_id=${workspace}`).toEqual([{ name_key: "usman khan", iban: null }]);
  } finally { await cleanup(); }
});
