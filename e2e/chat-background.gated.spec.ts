import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());

test("coming back to a chat still answering shows it working, then the saved answer", async ({ page }) => {
  test.setTimeout(60_000);
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const conversationId = randomUUID(), requestId = randomUUID();
  const question = `Background QA ${requestId.slice(0, 8)}`;
  try {
    await db`insert into public.conversations (id, workspace_id, title) values (${conversationId}, ${workspaceId}, ${question})`;
    await db`insert into public.chat_requests (id, workspace_id, conversation_id, message) values (${requestId}, ${workspaceId}, ${conversationId}, ${question})`;
    await db`insert into public.messages (workspace_id, conversation_id, role, content, context, request_id) values (${workspaceId}, ${conversationId}, 'user', ${question}, '{}', ${requestId})`;

    await page.goto(`/ai?conversation=${conversationId}`);
    const main = page.locator("main");
    await expect(main.getByText(question, { exact: true }).last()).toBeVisible();
    await expect(main.getByRole("status").filter({ hasText: "Thinking…" })).toBeVisible();

    await db`insert into public.messages (workspace_id, conversation_id, role, content, reply_to) values (${workspaceId}, ${conversationId}, 'assistant', 'Finished while you were away', ${requestId})`;
    await db`update public.chat_requests set status = 'completed', answer = 'Finished while you were away', updated_at = now() where id = ${requestId}`;
    await expect(main.getByText("Finished while you were away")).toBeVisible({ timeout: 15_000 });
    await expect(main.getByRole("status").filter({ hasText: "Thinking…" })).toHaveCount(0);
  } finally {
    await db`delete from public.messages where conversation_id = ${conversationId}`;
    await db`delete from public.chat_requests where id = ${requestId}`;
    await db`delete from public.conversations where id = ${conversationId}`;
    await db.end();
  }
});

test("a long chat and a long chat list stay usable: the app stays on screen, every search match is reachable, menus close, and a fresh chat's text box stays reachable", async ({ page }) => {
  test.setTimeout(120_000);
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const tag = randomUUID().slice(0, 8);
  const conversations = Array.from({ length: 65 }, (_, index) => ({ id: randomUUID(), workspace_id: workspaceId, title: `Layout QA ${tag} ${index}` }));
  const longId = conversations[0]!.id;
  const messages = Array.from({ length: 42 }, (_, index) => ({ workspace_id: workspaceId, conversation_id: longId, role: index % 2 ? "assistant" : "user", content: `Synthetic message ${index} ${"about spending ".repeat(20)}`, created_at: new Date(Date.now() - (42 - index) * 60_000) }));
  const documentScroll = () => page.evaluate(() => document.scrollingElement!.scrollTop);
  try {
    await db`insert into public.conversations ${db(conversations)}`;
    await db`insert into public.messages ${db(messages)}`;
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 500 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/ai?conversation=${longId}`);
      const heading = page.getByRole("heading", { level: 1, name: `Layout QA ${tag} 0` });
      await expect(heading).toBeVisible();
      const message = page.getByText(/^Synthetic message/).last();
      await expect(message).toBeVisible();
      const sidebar = page.locator("aside");
      if (await sidebar.isVisible()) {
        const older = sidebar.getByRole("button", { name: "Older conversations" });
        const links = sidebar.getByRole("navigation", { name: "Conversations" }).getByRole("link");
        while (await older.isVisible()) {
          const shown = await links.count();
          await older.click();
          await expect.poll(() => links.count()).toBeGreaterThan(shown);
        }
        await sidebar.hover();
        for (let step = 0; step < 30; step++) await page.mouse.wheel(0, 800);
        expect(await documentScroll(), `${viewport.width}×${viewport.height} sidebar`).toBe(0);
      }
      await message.hover();
      for (let step = 0; step < 30; step++) await page.mouse.wheel(0, 800);
      expect(await documentScroll(), `${viewport.width}×${viewport.height} messages`).toBe(0);
      await expect(heading).toBeInViewport();
      if (!(await sidebar.isVisible())) {
        const conversationsMenu = page.locator("details").filter({ has: page.getByLabel("Show conversations") });
        await page.getByLabel("Show conversations").click();
        await expect(conversationsMenu).toHaveAttribute("open");
        await page.keyboard.press("Escape");
        await expect(conversationsMenu).not.toHaveAttribute("open");
        await page.getByLabel("Show conversations").click();
        await expect(conversationsMenu).toHaveAttribute("open");
        await heading.click();
        await expect(conversationsMenu).not.toHaveAttribute("open");
        continue;
      }
      const search = sidebar.getByRole("searchbox", { name: "Search chats" });
      const results = sidebar.getByRole("navigation", { name: "Conversations" }).getByRole("link");
      await search.fill(`Layout QA ${tag}`);
      await expect(sidebar.getByText("Showing 30 of 65")).toBeVisible();
      await expect(results).toHaveCount(30);
      const olderMatches = sidebar.getByRole("button", { name: "Older matches" });
      while (await olderMatches.isVisible()) {
        const shown = await results.count();
        await olderMatches.click();
        await expect.poll(() => results.count()).toBeGreaterThan(shown);
      }
      await expect(results).toHaveCount(65);
      await expect(sidebar.getByText(/^Showing \d+ of/)).toHaveCount(0);
      await search.fill("");
      const rowMenu = sidebar.locator("details").filter({ has: page.getByLabel(`Actions for Layout QA ${tag} 0`, { exact: true }) });
      await sidebar.getByLabel(`Actions for Layout QA ${tag} 0`, { exact: true }).click();
      for (const action of ["Rename", "New title", "Delete"]) await expect(rowMenu.getByRole("button", { name: action })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(rowMenu).not.toHaveAttribute("open");
    }
    await page.setViewportSize({ width: 1024, height: 500 });
    await page.goto("/ai?conversation=new");
    const box = page.getByLabel("Ask about your finances");
    await expect(box).toBeVisible();
    const where = (await box.boundingBox())!;
    await page.mouse.click(where.x + where.width / 2, where.y + where.height / 2);
    await expect(box).toBeFocused();
    await page.keyboard.type("Where did my money go?");
    await expect(box).toHaveValue("Where did my money go?");
  } finally {
    await db`delete from public.messages where conversation_id = ${longId}`;
    await db`delete from public.conversations where id in ${db(conversations.map(conversation => conversation.id))}`;
    await db.end();
  }
});
