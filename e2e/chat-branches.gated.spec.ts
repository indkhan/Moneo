import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());

test("switching replies, regenerating with another model and editing all continue from the version on screen", async ({ page }) => {
  test.setTimeout(90_000);
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const conversationId = randomUUID(), first = randomUUID(), again = randomUUID();
  const question = `Branch QA ${first.slice(0, 8)}`;
  const sent: Record<string, unknown>[] = [];
  try {
    await db`insert into public.conversations (id, workspace_id, title) values (${conversationId}, ${workspaceId}, ${question})`;
    await db`insert into public.chat_requests (id, workspace_id, conversation_id, message, status, answer, created_at) values (${first}, ${workspaceId}, ${conversationId}, ${question}, 'completed', 'First reply', now() - interval '2 minutes')`;
    await db`insert into public.messages (workspace_id, conversation_id, role, content, context, request_id, created_at) values (${workspaceId}, ${conversationId}, 'user', ${question}, '{}', ${first}, now() - interval '2 minutes')`;
    await db`insert into public.messages (workspace_id, conversation_id, role, content, reply_to, created_at) values (${workspaceId}, ${conversationId}, 'assistant', 'First reply', ${first}, now() - interval '2 minutes')`;
    await db`insert into public.chat_requests (id, workspace_id, conversation_id, message, status, answer, regenerates, created_at) values (${again}, ${workspaceId}, ${conversationId}, ${question}, 'completed', 'Second reply', ${first}, now() - interval '1 minute')`;
    await db`insert into public.messages (workspace_id, conversation_id, role, content, reply_to, created_at) values (${workspaceId}, ${conversationId}, 'assistant', 'Second reply', ${again}, now() - interval '1 minute')`;

    await page.route("**/api/ai/status", route => route.fulfill({ json: { ai: true, voice: false, models: ["model-a", "model-b"], chatModel: "model-a" } }));
    await page.route("**/api/chat", async route => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      sent.push(body);
      const parent = body.regenerates || body.edits ? null : body.parent ?? null;
      await route.fulfill({ json: { conversationId, answer: `Reply ${sent.length}`, parent } });
    });

    await page.goto(`/ai?conversation=${conversationId}`);
    const main = page.locator("main");
    await expect(main.getByText("Second reply")).toBeVisible();
    await expect(main.getByText("First reply")).toHaveCount(0);
    await main.getByRole("button", { name: "Previous answer" }).click();
    await expect(main.getByText("First reply")).toBeVisible();

    await main.getByLabel("Ask about your finances").fill("Go on");
    await main.getByRole("button", { name: "Send" }).click();
    await expect(main.getByText("Reply 1")).toBeVisible();
    expect(sent[0]).toMatchObject({ message: "Go on", parent: first });
    await expect(main.getByText("First reply")).toBeVisible();

    await main.getByLabel("Regenerate with another model").first().click();
    await main.getByRole("button", { name: "model-b" }).first().click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ message: question, regenerates: first, model: "model-b" });

    await main.getByLabel("Model for this chat").selectOption("model-b");
    await expect.poll(async () => (await db`select model from public.conversations where id = ${conversationId}`)[0]?.model).toBe("model-b");
    await page.reload();
    await expect(main.getByLabel("Model for this chat")).toHaveValue("model-b");

    await main.getByRole("article").getByText(question, { exact: true }).hover();
    await main.getByRole("button", { name: "Edit message" }).click();
    await main.getByLabel("Edit your message").fill("Edited question");
    await main.getByRole("button", { name: "Send", exact: true }).first().click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toMatchObject({ message: "Edited question", edits: first, model: "model-b" });
  } finally {
    await db`delete from public.messages where conversation_id = ${conversationId}`;
    await db`delete from public.chat_requests where conversation_id = ${conversationId}`;
    await db`delete from public.conversations where id = ${conversationId}`;
    await db.end();
  }
});

test("an artifact's page follows the reply on screen, and the next request continues from that reply's page", async ({ page }) => {
  test.setTimeout(90_000);
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspaceId }] = await db`select w.id from public.workspaces w join auth.users u on u.id = w.owner_id where u.email = ${process.env.E2E_USER_EMAIL!}`;
  const artifactId = randomUUID(), conversationId = randomUUID(), first = randomUUID(), again = randomUUID();
  const title = `Branch artifact ${first.slice(0, 8)}`;
  const html = (text: string) => `<!doctype html><html><body><h1>${text}</h1></body></html>`;
  const sent: Record<string, unknown>[] = [];
  try {
    await db`insert into public.artifacts (id, workspace_id, title) values (${artifactId}, ${workspaceId}, ${title})`;
    await db`insert into public.conversations (id, workspace_id, title, artifact_id) values (${conversationId}, ${workspaceId}, ${title}, ${artifactId})`;
    await db`insert into public.chat_requests (id, workspace_id, conversation_id, message, status, answer, created_at) values (${first}, ${workspaceId}, ${conversationId}, 'Build it', 'completed', 'Monthly built', now() - interval '2 minutes')`;
    await db`insert into public.messages (workspace_id, conversation_id, role, content, context, request_id, created_at) values (${workspaceId}, ${conversationId}, 'user', 'Build it', '{}', ${first}, now() - interval '2 minutes')`;
    await db`insert into public.messages (workspace_id, conversation_id, role, content, reply_to, created_at) values (${workspaceId}, ${conversationId}, 'assistant', 'Monthly built', ${first}, now() - interval '2 minutes')`;
    await db`insert into public.chat_requests (id, workspace_id, conversation_id, message, status, answer, regenerates, created_at) values (${again}, ${workspaceId}, ${conversationId}, 'Build it', 'completed', 'Weekly built', ${first}, now() - interval '1 minute')`;
    await db`insert into public.messages (workspace_id, conversation_id, role, content, reply_to, created_at) values (${workspaceId}, ${conversationId}, 'assistant', 'Weekly built', ${again}, now() - interval '1 minute')`;
    await db`insert into public.artifact_versions (workspace_id, artifact_id, version, prompt, html, request_id) values (${workspaceId}, ${artifactId}, 1, 'Build it', ${html("Monthly page")}, ${first}), (${workspaceId}, ${artifactId}, 2, 'Build it', ${html("Weekly page")}, ${again})`;

    await page.route("**/api/chat", async route => {
      if (route.request().method() !== "POST") return route.fallback();
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { conversationId, answer: "Noted", parent: first } });
    });
    const shown = page.getByRole("region", { name: "Artifact" }).frameLocator("iframe").frameLocator("iframe");
    const chat = page.getByLabel("Artifact chat messages");

    await page.goto(`/ai/artifacts/${artifactId}`);
    await expect(shown.getByText("Weekly page")).toBeVisible({ timeout: 30_000 });
    await chat.getByRole("button", { name: "Previous answer" }).click();
    await expect(chat.getByText("Monthly built")).toBeVisible();
    await expect(shown.getByText("Monthly page")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`branch=${first}`));

    await page.reload();
    await expect(chat.getByText("Monthly built")).toBeVisible();
    await expect(shown.getByText("Monthly page")).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Ask about your finances").fill("Add an average line");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ message: "Add an average line", parent: first });
  } finally {
    await db`delete from public.messages where conversation_id = ${conversationId}`;
    await db`delete from public.artifact_versions where artifact_id = ${artifactId}`;
    await db`delete from public.chat_requests where conversation_id = ${conversationId}`;
    await db`delete from public.conversations where id = ${conversationId}`;
    await db`delete from public.artifacts where id = ${artifactId}`;
    await db.end();
  }
});
