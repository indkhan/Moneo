import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test("MNE024 owned direct history, stable pagination, newest reply and shared panel selection", async ({ browser, baseURL }) => {
  test.setTimeout(360_000);
  for (const name of ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) expect(Boolean(process.env[name]), `Missing ${name}`).toBe(true);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, connect_timeout: 15, connection: { statement_timeout: 30000 } });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const userIds: string[] = [], workspaceIds: string[] = [], threadIds: string[] = [], messageIds: string[] = [];
  const journal = `.qa/mne024-seed-${randomUUID()}.json`;
  mkdirSync(".qa", { recursive: true });
  const record = () => writeFileSync(journal, JSON.stringify({ userIds, workspaceIds, threadIds, messageIds }));
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  // SSR controls can be visible before hydration; the selection effect marks readiness.
  await page.addInitScript(() => {
    window.addEventListener("moneo-conversation-change", () => { document.documentElement.dataset.mne024Ready = "true"; });
  });
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  try {
    const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
    for (let i = 0; i < 2; i++) {
      const result = await admin.auth.admin.createUser({ email: i ? `qa-${randomUUID()}@example.invalid` : email, password, email_confirm: true });
      expect(result.error).toBeNull(); userIds.push(result.data.user!.id); record();
      const [workspace] = await db`select id from public.workspaces where owner_id=${userIds[i]}`;
      workspaceIds.push(workspace.id); record();
    }
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    // Deliberate timestamp ties; UUID determines the immutable secondary order.
    threadIds.push(...Array.from({ length: 101 }, () => randomUUID())); record();
    const owned = threadIds.slice(0, 100).sort();
    await db`insert into public.conversations ${db(threadIds.map((id, i) => ({ id, workspace_id: workspaceIds[i === 100 ? 1 : 0], title: `Synthetic thread ${id}`, created_at: "2026-01-01T00:00:00Z" })))}`;
    const selected = owned[0];
    messageIds.push(...Array.from({ length: 1000 }, () => randomUUID())); record();
    const sorted = [...messageIds].sort();
    await db`insert into public.messages ${db(sorted.map((id, i) => ({ id, workspace_id: workspaceIds[0], conversation_id: selected, role: i % 2 ? "assistant" : "user", content: `Synthetic message ${i + 1}`, created_at: "2026-01-01T00:00:00Z" })))}`;
    console.log("MNE024: authenticated synthetic fixtures ready");
    await page.goto(`/ai?conversation=${owned[69]}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("h2").filter({ hasText: `Synthetic thread ${owned[69]}` })).toBeVisible();
    await page.goto(`/ai?conversation=${selected}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Synthetic message 1000", { exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic message 1", { exact: true })).toHaveCount(0);
    console.log("MNE024: direct 31st/100th and newest 1000th message visible");
    const first = await context.request.get(`/api/conversations?conversation=${selected}`, { timeout: 60_000 });
    if (!first.headers()["content-type"]?.includes("application/json")) {
      writeFileSync(".qa/mne024-http-failure.txt", await first.text());
      writeFileSync(".qa/mne024-http-failure.json", JSON.stringify({ status: first.status(), path: new URL(first.url()).pathname }));
    }
    expect(first.headers()["content-type"]).toContain("application/json");
    const initial = await first.json(); expect(first.ok()).toBe(true);
    const arrivalThread = randomUUID(), arrivalMessage = randomUUID(); threadIds.push(arrivalThread); messageIds.push(arrivalMessage); record();
    await db`insert into public.conversations(id,workspace_id,title) values(${arrivalThread},${workspaceIds[0]},'Synthetic new arrival')`;
    await db`insert into public.messages(id,workspace_id,conversation_id,role,content) values(${arrivalMessage},${workspaceIds[0]},${selected},'assistant','Synthetic new arrival answer')`;
    const older = await context.request.get(`/api/conversations?${new URLSearchParams({ conversation: selected, threadsBefore: initial.threadsCursor, messagesBefore: initial.messagesCursor })}`, { timeout: 60_000 });
    const old = await older.json(); expect(older.ok()).toBe(true);
    expect(old.threads.some((row: { id: string }) => row.id === arrivalThread)).toBe(false);
    expect(old.messages.some((row: { id: string }) => row.id === arrivalMessage)).toBe(false);
    const all = [...initial.messages.map((row: { id: string }) => row.id)];
    let cursor = initial.messagesCursor, message101Cursor: string | undefined;
    while (cursor) { const response = await context.request.get(`/api/conversations?${new URLSearchParams({ conversation: selected, messagesBefore: cursor })}`, { timeout: 60_000 }); expect(response.ok()).toBe(true); const body = await response.json(); if (body.messages.some((row: { content: string }) => row.content === "Synthetic message 101")) message101Cursor = cursor; all.push(...body.messages.map((row: { id: string }) => row.id)); cursor = body.messagesCursor; }
    console.log("MNE024: tied history paged through 1000 records after new arrivals");
    expect(all).toHaveLength(1000); expect(new Set(all).size).toBe(1000); expect([...new Set(all)].sort()).toEqual(sorted);
    await page.getByRole("link", { name: "Older messages", exact: true }).click();
    await expect(page.getByText("Synthetic message 801", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Latest messages", exact: true }).click();
    await expect(page.getByText("Synthetic new arrival answer", { exact: true })).toBeVisible();
    expect(message101Cursor).toBeTruthy();
    await page.goto(`/ai?${new URLSearchParams({ conversation: selected, messagesBefore: message101Cursor! })}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Synthetic message 101", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Latest messages", exact: true }).click();
    let delayedReply: Promise<void> | undefined;
    let delayedStarted: (() => void) | undefined;
    await page.route("**/api/chat", async route => {
      expect(route.request().method()).toBe("POST");
      const payload = route.request().postDataJSON();
      if (payload.message.startsWith("Synthetic delayed ")) { delayedStarted?.(); await delayedReply; }
      if (payload.message === "Synthetic new panel question") {
        expect(payload.conversationId).not.toBe(selected);
        threadIds.push(payload.conversationId); record();
        await db`insert into public.conversations(id,workspace_id,title) values(${payload.conversationId},${workspaceIds[0]},'Synthetic new panel thread')`;
      } else expect(payload.conversationId).toBe(selected);
      const answer = payload.message.startsWith("Synthetic delayed ") ? payload.message.replace("Synthetic delayed ", "Synthetic delayed answer ") : payload.message === "Synthetic new panel question" ? "Synthetic new panel answer" : payload.message === "Synthetic panel follow-up" ? "Synthetic panel post-send answer" : "Synthetic newest post-send answer";
      const ids = [randomUUID(), randomUUID()]; messageIds.push(...ids); record();
      await db`insert into public.messages ${db(ids.map((id, i) => ({ id, workspace_id: workspaceIds[0], conversation_id: payload.conversationId, role: i ? "assistant" : "user", content: i ? answer : payload.message, created_at: new Date(Date.now() + i).toISOString() })))}`;
      await route.fulfill({ json: { conversationId: payload.conversationId, answer } });
    });
    await page.getByLabel("Ask about your finances").fill("Synthetic question");
    await page.locator("main").getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Synthetic newest post-send answer", { exact: true })).toBeVisible();
    console.log("MNE024: newest post-send answer visible");
    await page.goto("/ai", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "AI assistant" });
    await expect(panel.getByText("Synthetic newest post-send answer", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Older messages", exact: true }).click();
    await expect(panel.getByText("Synthetic message 850", { exact: true })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
    await expect(panel.getByText("Synthetic newest post-send answer", { exact: true })).toBeVisible();
    await panel.getByLabel("Question", { exact: true }).fill("Synthetic panel follow-up");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByText("Synthetic panel post-send answer", { exact: true })).toBeVisible();
    await panel.getByRole("link", { name: "Continue in AI workspace" }).click();
    await expect(page).toHaveURL(new RegExp(selected));
    console.log("MNE024: panel reload and fullpage share selected identity");
    await page.getByRole("link", { name: "Older conversations", exact: true }).click();
    await expect(page).toHaveURL(/threadsBefore=/);
    await expect(page.getByRole("navigation", { name: "Conversations" }).getByRole("link")).toHaveCount(30);
    await expect(page.getByRole("navigation", { name: "Conversations" }).getByText("Synthetic new arrival", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Latest conversations", exact: true }).click();
    await expect(page).not.toHaveURL(/threadsBefore=/);
    await expect(page.getByRole("navigation", { name: "Conversations" }).getByText("Synthetic new arrival", { exact: true })).toBeVisible();
    for (const destination of ["B", "New", "navigation"] as const) {
      await page.goto(`/ai?conversation=${selected}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
      await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
      let release!: () => void;
      delayedReply = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { delayedStarted = resolve; });
      const question = `Synthetic delayed ${destination}`, answer = `Synthetic delayed answer ${destination}`;
      await panel.getByLabel("Question", { exact: true }).fill(question);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      await started;
      await panel.getByRole("button", { name: "Close AI assistant" }).click();
      const other = owned[99], identity = destination === "New" ? "new" : other;
      if (destination === "New") await page.getByRole("link", { name: "New conversation", exact: true }).click();
      else await page.getByRole("navigation", { name: "Conversations" }).locator(`a[href="/ai?conversation=${other}"]`).click();
      await expect(page.locator("main").getByRole("heading", { name: destination === "New" ? "New conversation" : `Synthetic thread ${other}`, exact: true })).toBeVisible();
      if (destination === "navigation") {
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await expect(page).toHaveURL(/\/settings$/);
      }
      await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Loading conversation...", { exact: true })).toHaveCount(0);
      const staleNavigations: string[] = [];
      const navigation = (request: import("@playwright/test").Request) => {
        const target = new URL(request.url());
        if (target.pathname === "/ai" && target.searchParams.get("conversation") === selected) staleNavigations.push(target.pathname);
      };
      page.on("request", navigation);
      const completed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().postDataJSON().message === question);
      release(); await completed;
      await expect(panel.getByText(/Request running/)).toHaveCount(0);
      await expect(panel.getByText("Loading conversation...", { exact: true })).toHaveCount(0);
      const selectedCookie = (await context.cookies()).find(cookie => cookie.name === initial.selectionKey)?.value;
      expect.soft(selectedCookie, `Delayed A must preserve ${destination} identity`).toBe(identity);
      await expect.soft(page).toHaveURL(destination === "navigation" ? /\/settings$/ : new RegExp(`conversation=${identity}`), { timeout: 1000 });
      await expect.soft(panel.getByText(answer, { exact: true })).toHaveCount(0, { timeout: 1000 });
      expect.soft(staleNavigations, "Completion must not navigate using captured /ai pathname").toEqual([]);
      page.off("request", navigation);
      const saved = await db`select id from public.messages where workspace_id=${workspaceIds[0]} and conversation_id=${selected} and content=${answer}`;
      expect(saved).toHaveLength(1); // Work completed on A; only its obsolete UI projection is dropped.
      delayedReply = undefined; delayedStarted = undefined;
      console.log(`MNE024: checked delayed A completion after ${destination} and persisted server work`);
    }
    for (const id of [threadIds[100], randomUUID()]) {
      await page.goto(`/ai?conversation=${id}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main").getByRole("alert")).toContainText("Conversation unavailable");
      await expect(page.getByLabel("Ask about your finances")).toHaveCount(0);
      const response = await context.request.get(`/api/conversations?conversation=${id}`, { timeout: 60_000 }); expect(response.ok()).toBe(false);
      await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("Conversation unavailable");
      await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      await panel.getByRole("button", { name: "Close AI assistant" }).click();
    }
    await page.goto(`/ai?conversation=${selected}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
    await panel.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect(page).toHaveURL(/conversation=new/);
    await expect(panel.getByText("Synthetic newest post-send answer", { exact: true })).toHaveCount(0);
    await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
    await expect(panel.getByText("Synthetic newest post-send answer", { exact: true })).toHaveCount(0);
    await expect(page.locator("main").getByRole("heading", { name: "New conversation", exact: true })).toBeVisible();
    await expect(panel).toBeVisible();
    await panel.getByLabel("Question", { exact: true }).fill("Synthetic new panel question");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByText("Synthetic new panel answer", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close AI assistant" }).click();
    await page.goto("/ai", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main").getByText("Synthetic new panel answer", { exact: true })).toBeVisible();
    await expect(page.locator("main").getByText("Synthetic newest post-send answer", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "New conversation", exact: true }).click();
    await expect(page.locator("main").getByRole("heading", { name: "New conversation", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
    await expect(panel.getByText("Synthetic new panel answer", { exact: true })).toHaveCount(0);
    await page.route("**/api/conversations*", route => route.fulfill({ status: 500, json: { error: "Synthetic database failure" } }));
    await panel.getByRole("button", { name: "Close AI assistant" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mne024-ready", "true");
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("Synthetic database failure");
    await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    expect(runtimeErrors, "No browser JavaScript runtime errors are expected, including the synthetic HTTP 500").toEqual([]);
  } catch (cause) {
    await page.screenshot({ path: ".qa/mne024-failure.png" }).catch(() => {});
    writeFileSync(".qa/mne024-failure.txt", JSON.stringify({ errors: runtimeErrors, body: await page.locator("body").innerText({ timeout: 5000 }).catch(() => "Unavailable") }));
    throw cause;
  } finally {
    await context.close().catch(() => {});
    await db`delete from public.messages where id in ${db(messageIds.length ? messageIds : [randomUUID()])} and workspace_id in ${db(workspaceIds.length ? workspaceIds : [randomUUID()])}`;
    await db`delete from public.conversations where id in ${db(threadIds.length ? threadIds : [randomUUID()])} and workspace_id in ${db(workspaceIds.length ? workspaceIds : [randomUUID()])}`;
    for (let i = 0; i < workspaceIds.length; i++) await db`delete from public.workspaces where id=${workspaceIds[i]} and owner_id=${userIds[i]}`;
    for (const id of userIds) expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();
    await db.end(); unlinkSync(journal);
  }
});
