import postgres from "postgres";
import { APP, openBrowser } from "./recorder.mjs";
const { browser, page } = await openBrowser();
await page.goto(`${APP}/money/recurring`);
for (let i = 0; i < 10; i++) {
  await page.getByRole("button", { name: /^Confirm .*, / }).first().click();
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor();
  if (i === 0) console.log(await dialog.getByRole("button").evaluateAll(b => b.map(x => x.textContent)));
  await dialog.getByRole("button", { name: /^Confirm|Save|Yes/ }).last().click();
  const closed = await dialog.waitFor({ state: "detached", timeout: 15000 }).then(() => true, () => false);
  if (!closed) { console.log("dialog stayed", i, (await dialog.innerText()).slice(0, 300)); break; }
  await page.waitForTimeout(800);
}
await page.goto(`${APP}/settings`);
const sync = page.getByRole("button", { name: /Sync now/ }).first();
await sync.waitFor(); await sync.click();
await page.getByText("Scalable synced.").waitFor({ timeout: 60000 });
console.log("synced");
// A year of month-end values for the synced positions, so net worth has a history rather than one jump today.
const db = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
const items = await db`select * from public.wealth_items where removed_at is null`;
const curve = [0.62, 0.64, 0.67, 0.66, 0.70, 0.73, 0.71, 0.76, 0.80, 0.84, 0.83, 0.88, 0.94];
for (const [index, share] of curve.entries()) {
  const date = new Date(Date.UTC(2025, 10 + index, 0)).toISOString().slice(0, 10);
  for (const item of items) {
    const after = { ...item, as_of: date, amount_minor: String(Math.round(Number(item.amount_minor) * share)), created_at: item.created_at, updated_at: item.updated_at };
    await db`insert into public.wealth_events(workspace_id,item_id,actor_id,request_id,before,after,created_at)
      select ${item.workspace_id},${item.id},owner_id,${crypto.randomUUID()},null,${db.json(after)},${date + "T12:00:00Z"} from public.workspaces`;
  }
}
await db.end();
await page.goto(`${APP}/`);
await page.waitForTimeout(6000);
console.log(await page.evaluate(() => ({ h1: getComputedStyle(document.querySelector("h1")).fontFamily, body: getComputedStyle(document.body).fontFamily, loaded: [...document.fonts].filter(f => f.status === "loaded").map(f => f.family + f.weight).slice(0, 8), n: document.fonts.size })));
await page.screenshot({ path: "promo/out/check/home2.png" });
await page.goto(`${APP}/money/wealth`); await page.waitForTimeout(3000);
await page.screenshot({ path: "promo/out/check/wealth.png" });
await page.goto(`${APP}/ai?conversation=new`); await page.waitForTimeout(2500);
await page.screenshot({ path: "promo/out/check/ai.png" });
console.log(await page.getByRole("button").evaluateAll(b => b.map(x => x.getAttribute("aria-label") || x.textContent).filter(Boolean).slice(0, 40)));
await page.goto(`${APP}/ai/artifacts`); await page.waitForTimeout(2500);
await page.screenshot({ path: "promo/out/check/artifacts.png" });
await browser.close();
