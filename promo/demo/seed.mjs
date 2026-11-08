// Fills the disposable demo backend with an invented person's money, for recording the launch video.
// Refuses to run against anything but the moneo-demo database (port 54422).
//   node --env-file=.env promo/demo/seed.mjs
import postgres from "postgres";
import { encryptToken } from "../../lib/bank/token-crypto.ts";

if (!process.env.SUPABASE_DB_URL?.includes(":54422/")) throw new Error("Refusing to seed: this is not the demo database.");
const db = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
const [{ id: workspace, owner_id: owner }] = await db`select id, owner_id from public.workspaces`;
const TODAY = new Date(Date.UTC(2026, 10, 8));

// A small repeatable random source, so every reseed tells the same story.
let seed = 4242;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = list => list[Math.floor(rnd() * list.length)];
const between = (low, high) => Math.round((low + rnd() * (high - low)) / 5) * 5;
const iso = date => date.toISOString().slice(0, 10);

const CATEGORIES = ["Groceries", "Eating out", "Going out", "Transport", "Travel", "Subscriptions", "Shopping", "Housing", "Utilities", "Income", "Health"];
const MERCHANTS = {
  Groceries: [["REWE", 1800, 8500], ["Lidl", 1200, 5200], ["Edeka", 1500, 6000], ["dm-drogerie markt", 900, 3200]],
  "Eating out": [["Trattoria Da Gino", 2800, 5400], ["Five Elephant", 600, 1400], ["Burgermeister", 1100, 2200], ["Dishoom Berlin", 2600, 4800], ["Mustafa's Gemüse Kebap", 700, 1200]],
  "Going out": [["Berghain", 2000, 3000], ["Kino International", 1100, 2400], ["Klunkerkranich", 1500, 4200], ["Eventim", 3500, 7800]],
  Transport: [["Uber", 900, 2400], ["Deutsche Bahn", 2900, 8900], ["Bolt", 500, 1500]],
  Shopping: [["Amazon", 1500, 8900], ["Zalando", 3500, 9900], ["IKEA", 2500, 14000], ["Apple", 2900, 12900]],
  Health: [["Urban Sports Club", 7900, 7900], ["Apotheke am Markt", 800, 3400]],
};
const MONTHLY = [ // day, description, category, minor
  [1, "Hausverwaltung Berlin Miete", "Housing", -118000],
  [3, "Vattenfall Strom", "Utilities", -6400],
  [4, "O2 Mobilfunk", "Utilities", -2499],
  [5, "Spotify", "Subscriptions", -1199],
  [6, "Netflix", "Subscriptions", -1399],
  [7, "ChatGPT Plus", "Subscriptions", -2300],
  [7, "iCloud+", "Subscriptions", -299],
  [12, "Deutschlandticket", "Transport", -5800],
  [15, "Urban Sports Club", "Health", -7900],
  [27, "Lumen Robotics GmbH Gehalt", "Income", 395000],
];

const categoryId = new Map();
const merchantId = new Map();
const account = { revolut: crypto.randomUUID(), savings: crypto.randomUUID(), cash: crypto.randomUUID() };

await db.begin(async tx => {
  // Reseeding starts from an empty workspace. The demo database holds nothing else.
  await tx`truncate public.conversations, public.artifacts, public.scenarios, public.chat_requests, public.voice_calls, public.agent_runs cascade`;
  for (const table of ["planning_events", "goal_reservation_events", "goal_allocations", "goal_events", "recurring_occurrence_settlements", "recurring_series_transactions", "recurring_series", "financial_assumptions", "spending_plan_limits", "spending_plans", "goals", "wealth_events", "wealth_items", "agent_proposals"])
    await tx.unsafe(`delete from public.${table} where workspace_id=$1`, [workspace]);
  await tx`delete from public.forecast_preferences where workspace_id=${workspace}`;
  await tx`delete from public.scalable_connections where workspace_id=${workspace}`;
  await tx`delete from public.balance_snapshots where workspace_id=${workspace}`;
  await tx`delete from public.transactions where workspace_id=${workspace}`;
  await tx`delete from public.accounts where workspace_id=${workspace}`;
  await tx`delete from public.merchants where workspace_id=${workspace}`;
  await tx`insert into public.workspace_settings(workspace_id,timezone,locale,theme,summary_cadence,voice) values(${workspace},'Europe/Berlin','en-GB','dark','none','marin')
    on conflict(workspace_id) do update set timezone=excluded.timezone,locale=excluded.locale,theme=excluded.theme,summary_cadence='none',voice='marin'`;
  await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values
    (${account.revolut},${workspace},'Revolut','EUR','checking'),
    (${account.savings},${workspace},'Commerzbank Savings','EUR','savings'),
    (${account.cash},${workspace},'Cash','EUR','cash')`;
  for (const name of CATEGORIES) {
    const [existing] = await tx`select id from public.categories where workspace_id=${workspace} and name=${name}`;
    const { id } = existing ?? (await tx`insert into public.categories(workspace_id,name) values(${workspace},${name}) returning id`)[0];
    categoryId.set(name, id);
  }
  const merchantFor = async name => {
    if (!merchantId.has(name)) {
      const id = crypto.randomUUID(); merchantId.set(name, id);
      await tx`insert into public.merchants(id,workspace_id,name,normalized_name) values(${id},${workspace},${name},${name.toLowerCase()})`;
    }
    return merchantId.get(name);
  };
  const rows = [];
  const add = async (date, description, category, minor, acct = account.revolut) =>
    rows.push({ id: crypto.randomUUID(), workspace_id: workspace, account_id: acct, posted_on: iso(date), description, amount_minor: minor, currency_code: "EUR", status: "posted", kind: "ordinary", category_id: categoryId.get(category), merchant_id: await merchantFor(description) });

  for (let date = new Date(Date.UTC(2025, 9, 1)); date <= TODAY; date = new Date(date.getTime() + 86_400_000)) {
    const day = date.getUTCDate();
    for (const [on, description, category, minor] of MONTHLY) if (on === day) await add(date, description, category, minor);
    const weekend = [0, 5, 6].includes(date.getUTCDay());
    const chance = { Groceries: 0.42, "Eating out": weekend ? 0.42 : 0.14, "Going out": weekend ? 0.13 : 0.015, Transport: 0.08, Shopping: 0.07, Health: 0.015 };
    for (const [category, odds] of Object.entries(chance)) {
      if (rnd() > odds) continue;
      const [name, low, high] = pick(MERCHANTS[category].filter(([merchant]) => !(category === "Health" && merchant === "Urban Sports Club")));
      await add(date, name, category, -between(low, high));
    }
  }
  // This month so far, so budgets on 8 November have something to say.
  for (const [day, name, category, minor] of [[2, "REWE", "Groceries", -6840], [3, "Lidl", "Groceries", -3120], [5, "Edeka", "Groceries", -5260], [7, "REWE", "Groceries", -4310],
    [1, "Dishoom Berlin", "Eating out", -4250], [4, "Five Elephant", "Eating out", -890], [6, "Burgermeister", "Eating out", -1640], [7, "Five Elephant", "Eating out", -760],
    [1, "Klunkerkranich", "Going out", -3800], [6, "Eventim", "Going out", -7400], [7, "Berghain", "Going out", -2500], [3, "Uber", "Transport", -1420], [5, "Zalando", "Shopping", -6990]])
    await add(new Date(Date.UTC(2026, 10, day)), name, category, minor);
  // Lisbon flights and a past long weekend, so Travel has a history.
  await add(new Date(Date.UTC(2026, 6, 18)), "Ryanair", "Travel", -18600);
  await add(new Date(Date.UTC(2026, 7, 2)), "Booking.com Porto", "Travel", -34200);
  await add(new Date(Date.UTC(2026, 10, 3)), "TAP Air Portugal", "Travel", -24800);
  // Savings: a standing transfer's interest, plain and modest.
  for (let month = 0; month < 13; month++) {
    await add(new Date(Date.UTC(2025, 9 + month, 28)), "Commerzbank Zinsen", "Income", 3100 + month * 11, account.savings);
    // Money moved on payday, so Revolut stays level over the year.
    const moved = new Date(Date.UTC(2025, 9 + month, 28));
    rows.push({ id: crypto.randomUUID(), workspace_id: workspace, account_id: account.revolut, posted_on: iso(moved), description: "Scalable Capital Sparplan", amount_minor: -100000, currency_code: "EUR", status: "posted", kind: "transfer", category_id: null, merchant_id: null });
    rows.push({ id: crypto.randomUUID(), workspace_id: workspace, account_id: account.revolut, posted_on: iso(moved), description: "Commerzbank Savings", amount_minor: -30000, currency_code: "EUR", status: "posted", kind: "transfer", category_id: null, merchant_id: null });
    rows.push({ id: crypto.randomUUID(), workspace_id: workspace, account_id: account.savings, posted_on: iso(moved), description: "From Revolut", amount_minor: 30000, currency_code: "EUR", status: "posted", kind: "transfer", category_id: null, merchant_id: null });
  }

  await tx`insert into public.transactions ${tx(rows)}`;
  for (const [id, balance] of [[account.revolut, 642015n], [account.savings, 2840000n], [account.cash, 18500n]]) {
    const covered = await tx`select id,version,amount_minor::text,currency_code,posted_on::text,posted_at from public.transactions where workspace_id=${workspace} and account_id=${id}`;
    await tx`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id)
      values(${workspace},${id},${balance},'EUR',now(),'Demo opening balance','reviewed_activity',${tx.json(covered)},${owner})`;
  }
  await tx`insert into public.forecast_preferences(workspace_id,currency_code,uncertainty_bps) values(${workspace},'EUR',800) on conflict do nothing`;
  // What the confirmed bills leave out, so the forecast follows the year instead of climbing forever.
  for (const [name, minor] of [["Everyday spending", -135000n], ["Scalable savings plan", -100000n], ["Commerzbank savings", -30000n]])
    await tx`insert into public.financial_assumptions(workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,source,confirmed,enabled)
      values(${workspace},${account.revolut},'expense',${name},${minor},'EUR','monthly','2026-11-28','user',true,true)`;
  // A live connection to the demo Scalable server (promo/demo/scalable.mjs), never the real one.
  const connection = crypto.randomUUID();
  const tokens = encryptToken(JSON.stringify({ accessToken: "demo-access", refreshToken: "demo-refresh", expiresAt: Date.now() + 365 * 86_400_000 }), connection);
  await tx`insert into public.scalable_connections (id, workspace_id, client_id, redirect_uri, status, tokens_encrypted)
    values (${connection}, ${workspace}, 'demo', ${process.env.NEXT_PUBLIC_APP_URL + "/api/scalable/callback"}, 'active', ${tokens})`;
  console.log(`Seeded ${rows.length} transactions.`);
});
await db.end();
