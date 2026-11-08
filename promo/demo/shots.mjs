// Real screen recordings for the launch video. Run one shot at a time:
//   node --env-file=.env promo/demo/shots.mjs home chat budget plan artifact trade settings tour phone
import { APP, glide, openBrowser, record, scroll, slowType, tap } from "./recorder.mjs";

const settle = (page, ms = 2500) => page.waitForLoadState("networkidle").catch(() => {}).then(() => page.waitForTimeout(ms));
const snap = (page, name) => page.screenshot({ path: `promo/out/check/${name}.png` });
/** Waits until a chat stops streaming: its Stop button came and went. */
const answered = async page => {
  await page.getByRole("button", { name: "Stop", exact: true }).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await page.getByRole("button", { name: "Stop", exact: true }).first().waitFor({ state: "detached", timeout: 180_000 });
};

const shots = {
  async home(session) {
    const { page } = session;
    await page.goto(`${APP}/`); await settle(page, 3000);
    const rec = await record(session, "home");
    await page.waitForTimeout(1200); rec.mark("top");
    await glide(page, 500, 520, 700); await page.waitForTimeout(500);
    await scroll(page, 560, 1500); rec.mark("briefing"); await page.waitForTimeout(900);
    await scroll(page, 800, 1500); rec.mark("cashflow"); await page.waitForTimeout(900);
    await scroll(page, 800, 1500); rec.mark("accounts"); await page.waitForTimeout(900);
    await scroll(page, -2200, 1300); await page.waitForTimeout(500);
    await rec.stop();
  },
  async chat(session) {
    const { page } = session;
    await page.goto(`${APP}/ai?conversation=new`); await settle(page);
    const rec = await record(session, "chat");
    await page.waitForTimeout(500);
    await tap(page, page.getByPlaceholder("Ask anything about your money"));
    rec.mark("type");
    await slowType(page, "Where did most of my money go this month? Show me a chart.", 26);
    await page.waitForTimeout(250); await page.keyboard.press("Enter"); rec.mark("sent");
    await answered(page); rec.mark("answered");
    await page.waitForTimeout(1500);
    await glide(page, 1000, 500, 500); await scroll(page, 500, 1200); await page.waitForTimeout(1000);
    await rec.stop(); await snap(page, "chat");
  },
  async budget(session) {
    const { page } = session;
    await page.goto(`${APP}/plan/spending`); await settle(page);
    const rec = await record(session, "budget");
    await page.waitForTimeout(800); rec.mark("top");
    await scroll(page, 420, 1300); await page.waitForTimeout(800); rec.mark("bars");
    await glide(page, 800, 440, 500);
    await scroll(page, 620, 1500); await page.waitForTimeout(800);
    await rec.stop(); await snap(page, "budget");
  },
  async plan(session) {
    const { page } = session;
    await page.goto(`${APP}/plan?horizon=365`); await settle(page);
    if (!await page.getByRole("link", { name: "Lisbon weekend" }).count()) {
      await page.getByPlaceholder("What if…").fill("Lisbon weekend");
      await page.getByRole("button", { name: "Create scenario" }).click();
      await page.getByLabel(/Hypothetical event name/).waitFor();
      const form = page.locator("form").filter({ has: page.getByLabel(/Hypothetical event name/) });
      await page.getByLabel(/Hypothetical event name/).fill("Lisbon");
      await page.getByLabel(/Hypothetical change amount/).fill("1800");
      await form.getByLabel(/^Account/).selectOption({ label: "Revolut (EUR)" });
      await form.getByLabel(/^Cadence/).selectOption("once");
      await form.locator("input[type=date]").first().fill("2027-06-11");
      await form.getByRole("button").last().click();
      await settle(page, 1000);
      await page.goto(`${APP}/plan?horizon=365`); await settle(page);
    }
    const rec = await record(session, "plan");
    await page.waitForTimeout(1000); rec.mark("forecast");
    await glide(page, 500, 330, 700); await glide(page, 1100, 350, 1100); await page.waitForTimeout(300);
    await page.getByRole("link", { name: "Goals" }).first().click().catch(() => {});
    await page.getByRole("heading", { name: "House deposit" }).scrollIntoViewIfNeeded(); await page.waitForTimeout(1200); rec.mark("goal");
    await snap(page, "plan-goal");
    await page.getByPlaceholder("What if…").scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
    await tap(page, page.getByRole("link", { name: "Lisbon weekend" }), 500); rec.mark("scenario");
    await settle(page, 800);
    await page.locator("text=What-if scenarios").scrollIntoViewIfNeeded(); await page.waitForTimeout(1200); rec.mark("compare");
    await snap(page, "plan-compare-table");
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" })); await page.waitForTimeout(1300); rec.mark("compareChart");
    await glide(page, 1000, 360, 700); await page.waitForTimeout(600);
    await rec.stop(); await snap(page, "plan-compare");
    console.log(page.url());
  },
  async artifact(session) {
    const { page } = session;
    await page.goto(`${APP}/ai/artifacts`); await settle(page);
    const rec = await record(session, "artifact");
    await page.waitForTimeout(600);
    await tap(page, page.locator("#artifact-prompt"));
    rec.mark("type");
    await slowType(page, "A page for my Scalable portfolio: holdings table, an allocation donut, gains, and a slider for how much I add each month with a 20-year projection chart at 6% a year. Also a Home card with the total and the slider.", 12);
    await page.waitForTimeout(250); rec.mark("build");
    await tap(page, page.getByRole("button", { name: /^Build/ }), 400);
    await page.waitForURL(/\/ai\/artifacts\/[0-9a-f-]{36}/, { timeout: 60_000 }); rec.mark("building");
    await page.getByRole("button", { name: "Stop", exact: true }).first().waitFor({ timeout: 30_000 }).catch(() => console.log("no stop"));
    await page.getByRole("button", { name: "Stop", exact: true }).first().waitFor({ state: "detached", timeout: 420_000 }); rec.mark("built");
    await settle(page, 2500);
    await snap(page, "artifact-built");
    // The page swaps its frame when the build lands; a reload gives the slider a settled one.
    await page.reload(); await settle(page, 2500); rec.mark("reloaded");
    const frame = page.frames().find(item => item.url() === "about:srcdoc");
    const slider = frame.locator("input[type=range]").first();
    await slider.scrollIntoViewIfNeeded(); await page.waitForTimeout(900);
    const box = await slider.boundingBox();
    const y = box.y + box.height / 2, start = box.x + box.width * 0.2;
    await glide(page, start, y, 600); rec.mark("slider");
    await page.mouse.down();
    await glide(page, box.x + box.width * 0.85, y, 1900);
    await page.mouse.up(); rec.mark("sliderEnd");
    await page.waitForTimeout(800); await snap(page, "artifact-slider");
    await tap(page, page.getByText(/^Home cards/).first()); await settle(page, 2000); rec.mark("cards");
    await snap(page, "artifact-cards");
    await tap(page, page.getByRole("button", { name: "Add to Home" }), 500); rec.mark("addHome");
    await page.getByText("On Home").first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(700);
    await page.goto(`${APP}/`); await settle(page, 2500); rec.mark("home");
    const homeSlider = page.frames().filter(item => item.url() === "about:srcdoc").map(item => item.locator("input[type=range]").first())[0];
    if (homeSlider) {
      await homeSlider.scrollIntoViewIfNeeded(); await page.waitForTimeout(800); rec.mark("homeCard");
      const card = await homeSlider.boundingBox();
      await glide(page, card.x + card.width * 0.15, card.y + card.height / 2, 500);
      await page.mouse.down(); await glide(page, card.x + card.width * 0.8, card.y + card.height / 2, 1300); await page.mouse.up(); rec.mark("homeCardEnd");
      await page.waitForTimeout(800);
    } else console.log("no card slider in a frame");
    await snap(page, "artifact-home");
    await rec.stop();
    console.log("url", page.url());
  },
  async trade(session) {
    const { page } = session;
    await page.goto(`${APP}/ai?conversation=new`); await settle(page);
    const rec = await record(session, "trade");
    await page.waitForTimeout(400);
    await tap(page, page.getByPlaceholder("Ask anything about your money"));
    rec.mark("type");
    await slowType(page, "Buy €1,000 of iShares Core MSCI World", 30);
    await page.keyboard.press("Enter"); rec.mark("sent");
    const card = page.getByRole("region", { name: /Buy card/ });
    await card.waitFor({ timeout: 180_000 }); rec.mark("card");
    await page.waitForTimeout(1200);
    await glide(page, 1000, 420, 400); await scroll(page, 600, 800); await page.waitForTimeout(1000);
    await snap(page, "trade-card");
    rec.mark("buy");
    await tap(page, card.getByRole("button", { name: /^Buy/ }));
    await card.getByText(/Order sent to Scalable/).waitFor({ timeout: 30_000 }); rec.mark("sent-order");
    await page.waitForTimeout(3200);
    await rec.stop(); await snap(page, "trade-done");
  },
  async settings(session) {
    const { page } = session;
    await page.goto(`${APP}/settings#ai-access`); await settle(page);
    await page.locator("#ai-access").scrollIntoViewIfNeeded();
    await snap(page, "settings-ai");
    // The key endings stay out of the recording.
    await page.evaluate(() => { for (const element of document.querySelectorAll("#ai-access p")) if (/ending in/.test(element.textContent)) element.textContent = "Saved. Paste a new one to replace it."; });
    const rec = await record(session, "settings");
    await page.waitForTimeout(700); rec.mark("ai");
    await glide(page, 480, 385, 800); await page.waitForTimeout(250);
    rec.mark("signin");
    await page.mouse.down(); await page.waitForTimeout(70);
    await rec.stop();
    await snap(page, "settings-click");
  },
  async homecard(session) {
    const { page } = session;
    await page.goto(`${APP}/`); await settle(page, 3000);
    const slider = page.locator("input[type=range]").first();
    await slider.scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
    const rec = await record(session, "homecard");
    await page.waitForTimeout(500);
    const box = await slider.boundingBox();
    const y = box.y + box.height / 2;
    await glide(page, box.x + box.width * 0.12, y, 500); rec.mark("start");
    await page.mouse.down(); await glide(page, box.x + box.width * 0.85, y, 1500); await page.mouse.up(); rec.mark("end");
    await page.waitForTimeout(900);
    await rec.stop(); await snap(page, "homecard");
  },
  async tour(session) {
    const { page } = session;
    const rec = await record(session, "tour");
    const visit = async (name, path, action) => {
      await page.goto(`${APP}${path}`); await settle(page, 700); rec.mark(name);
      await action?.(); await page.waitForTimeout(1100);
      await snap(page, `tour-${name}`);
    };
    await visit("transactions", "/money/transactions", () => scroll(page, 500, 900));
    await visit("accounts", "/money/accounts", () => scroll(page, 400, 800));
    await visit("recurring", "/money/recurring", () => scroll(page, 450, 800));
    await visit("wealth", "/money/wealth", () => scroll(page, 700, 1000));
    await visit("import", "/import");
    await visit("organization", "/money/organization");
    await visit("agents", "/ai/agents");
    await visit("activity", "/ai/activity");
    await page.goto(`${APP}/`); await settle(page, 700); rec.mark("palette");
    await page.keyboard.press("Control+k"); await page.waitForTimeout(500);
    await slowType(page, "budget", 90); await page.waitForTimeout(900);
    await snap(page, "tour-palette");
    await rec.stop();
  },
  async phone() {
    const session = await openBrowser({ viewport: { width: 402, height: 874 }, scale: 3 });
    const { page } = session;
    await page.goto(`${APP}/`); await settle(page, 2500);
    const rec = await record(session, "phone");
    await page.waitForTimeout(600);
    await scroll(page, 700, 1500); await page.waitForTimeout(400); await scroll(page, 900, 1500); await page.waitForTimeout(400);
    await rec.stop(); await snap(page, "phone");
    await session.browser.close();
  },
};

for (const name of process.argv.slice(2)) {
  console.log(`--- ${name}`);
  if (name === "phone") { await shots.phone(); continue; }
  const session = await openBrowser();
  try { await shots[name](session); } catch (error) { console.log(`${name} failed:`, error.message.slice(0, 400)); await session.page.screenshot({ path: `promo/out/check/${name}-failed.png` }); }
  await session.browser.close();
}
