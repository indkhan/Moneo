import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());

// The run is written directly, as the chat route does when the user has left, so no AI provider is called.
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

    // The run finishes on the server while the page is open.
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
