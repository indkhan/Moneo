import { test, expect, type Page } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());
// Each step waits for its save, and Home's sections stream in after load.
test.setTimeout(120_000);

const order = (page: Page) => page.locator("[data-widget]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.widget));
// The grid only moves once hydrated.
const open = (page: Page) => page.goto("/", { waitUntil: "networkidle" });
const saved = (page: Page) => page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/");

test("Home widgets are moved, resized, hidden and added back in place, and stay that way", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("link", { name: "Edit layout" })).toHaveCount(0);
  const grid = page.locator("[data-widget]");
  await expect(grid.first()).toBeVisible({ timeout: 30_000 });
  // Start from Goals at the end, so the moves below are predictable.
  if (!(await order(page)).includes("goals")) {
    await page.getByRole("button", { name: "Add widget" }).click();
    const added = saved(page);
    await page.getByRole("list", { name: "Hidden widgets" }).getByRole("button", { name: "Goals", exact: true }).click();
    await added;
  }
  const goals = page.locator('[data-widget="goals"]');
  await expect(goals.getByRole("heading", { name: "Goals" })).toBeVisible({ timeout: 30_000 });

  // Move Goals one place back from the keyboard.
  const before = await order(page);
  const at = before.indexOf("goals");
  test.skip(at === 0, "Goals is already first");
  await goals.getByRole("button", { name: "Move Goals" }).focus();
  const moved = saved(page);
  await page.keyboard.press("ArrowLeft");
  await moved;
  await expect(goals.getByRole("button", { name: "Move Goals" })).toBeFocused();
  const after = await order(page);
  expect(after.indexOf("goals")).toBe(at - 1);

  // Resize it one step from the keyboard: wider, or narrower if it is already full width.
  const resize = goals.getByRole("button", { name: /^Resize Goals/ });
  const width = (await goals.boundingBox())!.width;
  const wider = !(await resize.getAttribute("aria-label"))!.endsWith("XL");
  const resized = saved(page);
  await resize.focus();
  await page.keyboard.press(wider ? "ArrowRight" : "ArrowLeft");
  await resized;
  const changed = (await goals.boundingBox())!.width;
  expect(wider ? changed > width : changed < width).toBe(true);

  await page.reload({ waitUntil: "networkidle" });
  await expect(goals).toBeVisible({ timeout: 30_000 });
  expect(await order(page)).toEqual(after);
  expect((await goals.boundingBox())!.width).toBe(changed);

  // Hide it, undo, then hide it for good and add it back.
  await goals.hover();
  const hiding = saved(page);
  await goals.getByRole("button", { name: "Hide Goals" }).click();
  await expect(goals).toHaveCount(0);
  await hiding;
  // Undo must preserve a later resize of a different widget.
  const overviewResize = page.getByRole("button", { name: /^Resize Overview/ });
  const overviewBefore = await overviewResize.getAttribute("aria-label");
  const laterSave = saved(page);
  await overviewResize.focus();
  await page.keyboard.press(overviewBefore!.endsWith("XL") ? "ArrowLeft" : "ArrowRight");
  await laterSave;
  const overviewAfter = await overviewResize.getAttribute("aria-label");
  const undone = saved(page);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(goals).toBeVisible();
  await undone;
  await expect(overviewResize).toHaveAttribute("aria-label", overviewAfter!);
  // A server refresh for another addition must not prevent Undo restoring content.
  await goals.hover();
  const hideAgain = saved(page);
  await goals.getByRole("button", { name: "Hide Goals" }).click();
  await hideAgain;
  await page.getByRole("button", { name: "Add widget", exact: true }).click();
  const other = page.getByRole("list", { name: "Hidden widgets" }).getByRole("button").filter({ hasNotText: /^Goals$/ }).first();
  if (await other.count()) {
    const addedOther = saved(page);
    await other.click();
    await addedOther;
    const restored = saved(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await restored;
    await expect(goals.getByRole("heading", { name: "Goals", exact: true })).toBeVisible({ timeout: 30_000 });
  } else {
    await page.getByRole("button", { name: "Add widget", exact: true }).click();
    const restored = saved(page);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await restored;
  }

  await goals.hover();
  const hidden = saved(page);
  await goals.getByRole("button", { name: "Hide Goals" }).click();
  await hidden;
  await page.reload({ waitUntil: "networkidle" });
  await expect(grid.first()).toBeVisible({ timeout: 30_000 });
  await expect(goals).toHaveCount(0);
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByRole("list", { name: "Hidden widgets" }).getByRole("button", { name: "Goals", exact: true }).click();
  await expect(goals.getByRole("heading", { name: "Goals" })).toBeVisible({ timeout: 30_000 });
});

test("a long press drags a widget on a phone, and a swipe still scrolls", async ({ browser }) => {
  const context = await browser.newContext({ storageState: state!, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await open(page);
  await expect(page.locator("[data-widget]").nth(1)).toBeVisible({ timeout: 30_000 });
  const cdp = await context.newCDPSession(page);
  // One touch point per frame, as a finger moves.
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await page.waitForTimeout(20);
  };
  const before = await order(page);
  const [first, second] = before;
  await page.locator(`[data-widget="${first}"]`).evaluate(node => node.scrollIntoView({ block: "start" }));
  await page.evaluate(() => scrollBy(0, -120));
  const start = (await page.locator(`[data-widget="${first}"]`).boundingBox())!;
  const end = (await page.locator(`[data-widget="${second}"]`).boundingBox())!;
  await touch("touchStart", start.x + 40, start.y + 30);
  await page.waitForTimeout(400);
  for (let step = 1; step <= 10; step++) await touch("touchMove", start.x + 40, start.y + 30 + (end.y + end.height - 20 - start.y - 30) * step / 10);
  const moved = saved(page);
  await touch("touchEnd");
  await moved;
  expect((await order(page)).indexOf(first)).toBeGreaterThan(0);

  // A quick swipe over a widget scrolls the page and moves nothing.
  const after = await order(page);
  const from = (await page.locator(`[data-widget="${first}"]`).boundingBox())!;
  const top = await page.evaluate(() => scrollY);
  await touch("touchStart", from.x + 40, from.y + 30);
  for (let step = 1; step <= 6; step++) await touch("touchMove", from.x + 40, from.y + 30 - step * 20);
  await touch("touchEnd");
  await expect.poll(() => page.evaluate(() => scrollY)).not.toBe(top);
  expect(await order(page)).toEqual(after);

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator("[data-widget]").first()).toBeVisible({ timeout: 30_000 });
  expect((await order(page)).indexOf(first)).toBeGreaterThan(0);
  await context.close();
});
