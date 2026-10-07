import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("Evidence room handles rich replies, artifacts, cancellation and modal keyboard behavior", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", message => { if (/hydrat/i.test(message.text())) hydrationErrors.push(message.text()); });
  const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const conversation = process.env.E2E_AI_CONVERSATION;
  await page.goto(`${base}/ai${conversation ? `?conversation=${conversation}` : ""}`);
  await expect(page.getByRole("heading", { name: "Every answer has a trail." })).toBeVisible();
  expect(await page.locator("main").evaluate(element => getComputedStyle(element).getPropertyValue("--color-background").trim())).toBe("#182333");
  // Deterministic mocked contract for the dialog's conversation history. The POST
  // /api/chat mock never reaches the server, so the mock records the posted
  // Q&A and the GET serves it back as the consistent owned persisted history.
  // The post-send reload is held until the rich-reply assertions below have run:
  // letting it resolve earlier would replace the local exchange (and its tool
  // activity) before it is asserted, exactly as a real reload would.
  // Production missing/foreign-conversation errors and navigation-fence semantics
  // are untouched (see mne024.gated.spec.ts); only this spec's dialog contract
  // is mocked.
  let persistedConversation: string | null = null;
  let persistedMessages: { id: string; role: string; content: string; created_at: string }[] = [];
  let releaseHistory: () => void = () => {};
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  const selectionKey = "moneo-conversation-qa-evidence";
  const historyPayload = () => ({ json: {
    threads: [{ id: persistedConversation, title: "QA evidence thread", created_at: "2026-01-01T00:00:00.000Z" }],
    selected: { id: persistedConversation, title: "QA evidence thread", created_at: "2026-01-01T00:00:00.000Z" },
    messages: persistedMessages,
    messagesCursor: null,
    threadsCursor: null,
    selectionKey,
  } });
  await page.route("**/api/conversations*", async route => {
    const header = route.request().headers()["cookie"] ?? "";
    let requested: string | null = null;
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index >= 0 && part.slice(0, index).trim() === selectionKey)
        requested = decodeURIComponent(part.slice(index + 1).trim());
    }
    // The reload fired by the first send carries the recorded id but must wait
    // for the release below; earlier loads (no recorded id yet) see an empty
    // owned workspace, exactly like a fresh production workspace.
    if (requested && requested === persistedConversation && persistedMessages.length) {
      await historyGate;
      return route.fulfill(historyPayload());
    }
    return route.fulfill({ json: { threads: [], selected: null, messages: [], messagesCursor: null, threadsCursor: null, selectionKey } });
  });
  await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI assistant" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close AI assistant" })).toBeFocused();
  const reply = '## Finance lookup\n\n**EUR 420**\n\n| Category | Amount |\n| --- | --- |\n| Dining | EUR 420 |\n\n```sql\nSELECT amount_minor FROM transactions;\n```\n\n[Source](https://example.com/evidence)\n\n/ai/library/00000000-0000-4000-8000-000000000001';
  await page.route("**/api/chat", route => {
    const payload = route.request().postDataJSON();
    persistedConversation = payload.conversationId;
    const stamp = new Date().toISOString();
    persistedMessages = [
      { id: randomUUID(), role: "user", content: payload.message, created_at: stamp },
      { id: randomUUID(), role: "assistant", content: reply, created_at: stamp },
    ];
    return route.fulfill({ json: { conversationId: payload.conversationId, answer: reply, toolsUsed: ["transactions_search", "analytics_cashflow"] } });
  });
  await dialog.getByLabel("Question", { exact: true }).fill("Find my dining transactions");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Finance lookup" })).toBeVisible();
  await expect(dialog.locator("table")).toContainText("Dining");
  await expect(dialog.locator("code.language-sql")).toContainText("SELECT amount_minor");
  await expect(dialog.getByRole("link", { name: /Open saved tool/ })).toHaveAttribute("href", /\/ai\/library\//);
  await dialog.getByText("Completed tools · 2", { exact: true }).click();
  await expect(dialog.getByRole("listitem").filter({ hasText: "Search transactions" })).toBeVisible();
  // The rich reply and its tool activity are asserted; release the held
  // post-send reload now, while the dialog is still open, so the recorded Q&A
  // becomes the served owned history. Waiting for the loader to clear proves
  // the swap completed before the dialog is closed and reopened.
  releaseHistory();
  await expect(dialog.getByText("Loading conversation...", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".qa/evidence-room-panel-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: ".qa/evidence-room-panel-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Moneo", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".qa/evidence-room-page-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: ".qa/evidence-room-page-desktop.png", fullPage: true });
  if (conversation) {
    const artifact = page.locator("main").getByRole("link", { name: /Open saved tool/ });
    await expect(artifact).toBeVisible();
    await artifact.click();
    await expect(page).toHaveURL(/\/ai\/library\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "QA spending explorer", exact: true })).toBeVisible();
    await page.goto(`${base}/ai?conversation=${conversation}`);
  }
  // The reopened dialog loads the served owned history without error, so the
  // second Send stays enabled for the cancellation half below.
  await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: { status: "canceled" } });
    await new Promise(resolve => setTimeout(resolve, 500));
    // A canceled answer is never persisted: fulfilling without recording keeps
    // the "Late answer" assertion meaningful.
    await route.fulfill({ json: { conversationId: persistedConversation, answer: "Late answer" } }).catch(() => {});
  });
  await dialog.getByLabel("Question", { exact: true }).fill("Review my spending");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByText("Request running · waiting for response")).toBeVisible();
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(dialog.getByText(/Canceled. Completed edits remain/)).toBeVisible();
  await expect(dialog.getByText("Late answer")).toHaveCount(0);
  expect(hydrationErrors).toEqual([]);
});
