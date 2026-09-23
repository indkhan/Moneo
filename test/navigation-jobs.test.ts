// E07-S04 complete navigation and job feedback: durable job list, per-user
// notices, exact-route palette. Real disposable PostgreSQL
// (`moneo_e07_navigation_jobs`) + real Redis (dedicated logical DB 15,
// loopback-guarded; only this DB is ever flushed). Synthetic data only.
// Chromium + Firefox keyboard journeys at 320px (WebKit best-effort,
// recorded honestly and never counted as pass when unavailable).

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { chromium, firefox, webkit } from "@playwright/test";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant, type TenantClaims } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { dispatchOutbox, jobsQueue, processImportJob, type JobPayload } from "../apps/web/src/jobs.ts";
import { insertTerminalNoticeTx, listNotices } from "../apps/web/src/notices.ts";
import { listJobs } from "../apps/web/src/ui/jobs.ts";
import { createArtifactDraft } from "../apps/web/src/commands/artifacts.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");
let redisUrl: string;
let redisDb = -1;
let queue: Queue<JobPayload>;
let webkitOk = false;

function navRedisUrl(): string {
  const base = env("E07-S04", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E07-S04 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["NAV_JOBS_REDIS_DB"] ?? "15";
  if (!/^\d+$/.test(db) || Number(db) < 1 || Number(db) > 15) throw new Error("E07-S04 misconfigured: NAV_JOBS_REDIS_DB must be 1-15.");
  redisDb = Number(db);
  u.pathname = `/${db}`;
  return u.toString();
}

async function startApp(): Promise<string> {
  const config: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const uiConfig = { appBaseUrl: "http://127.0.0.1:1", sessionSecret };
  const server = createApp(
    createAuthRouter(config, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
    { ui: createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), uiConfig), controls: null },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
  uiConfig.appBaseUrl = base;
  return base;
}

async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

type Setup = { cookie: string; userId: string; workspaceId: string; claims: TenantClaims };

async function setupWorkspace(base: string, sub: string, suffix: string): Promise<Setup> {
  const cookie = await login(base, sub);
  const ws = (await (
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `NAV-${suffix}`, baseCurrency: "EUR" }),
    })
  ).json()) as { id: string };
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId: ws.id, claims: { userId, workspaceId: ws.id } };
}

async function call(method: string, url: string, cookie: string, body?: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    headers: { cookie, ...(method === "POST" ? { Origin: new URL(url).origin } : {}), ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: body !== undefined ? new URLSearchParams(body).toString() : undefined,
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

function scoped<T>(claims: TenantClaims, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, claims, work);
}

async function insertImport(claims: TenantClaims): Promise<{ sourceId: string; importId: string; parseJobId: string }> {
  const sourceId = randomUUID();
  const importId = randomUUID();
  const parseJobId = randomUUID();
  await scoped(claims, async (client) => {
    await client.query("INSERT INTO data_sources (workspace_id, id, type, name, status) VALUES ($1, $2, 'csv_upload', 'bank.csv', 'ACTIVE')", [claims.workspaceId, sourceId]);
    await client.query(
      "INSERT INTO imports (workspace_id, id, data_source_id, idempotency_key, file_name, file_sha256, object_key, parser_version, status) VALUES ($1, $2, $3, $4, 'bank.csv', $5, 'q/key', 'p1', 'UPLOAD_REGISTERED')",
      [claims.workspaceId, importId, sourceId, randomUUID(), "ab".repeat(32)],
    );
    // The import status page resolves through the parse job (acceptUpload
    // writes both rows in one transaction); mirror that pairing here.
    await client.query(
      "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, input_ref) VALUES ($1, $2, 'imports.parse', '1', 'QUEUED', $3, $4)",
      [claims.workspaceId, parseJobId, `imports.parse:${importId}`, JSON.stringify({ importId })],
    );
  });
  return { sourceId, importId, parseJobId };
}

async function insertJob(
  claims: TenantClaims,
  opts: { type: string; status: string; inputRef: Record<string, unknown>; errorCode?: string; errorSummary?: string; resultRef?: Record<string, unknown> },
): Promise<string> {
  const jobId = randomUUID();
  await scoped(claims, async (client) => {
    await client.query(
      "INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, input_ref, result_ref, error_code, error_summary, queued_at, started_at, completed_at) VALUES ($1, $2, $3, '1', $4, $5, $6, $7, $8, $9, now(), now(), CASE WHEN $4 IN ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED') THEN now() ELSE NULL END)",
      [claims.workspaceId, jobId, opts.type, opts.status, `nav:${jobId}`, JSON.stringify(opts.inputRef), opts.resultRef ? JSON.stringify(opts.resultRef) : null, opts.errorCode ?? null, opts.errorSummary ?? null],
    );
  });
  return jobId;
}

beforeAll(async () => {
  pool = await ensureTestPool("E07-S04", "moneo_e07_navigation_jobs", [
    "notices",
    "chat_activity",
    "chat_attempts",
    "chat_turns",
    "chat_threads",
    "artifact_versions",
    "artifacts",
    "deep_analysis_findings",
    "deep_analysis_steps",
    "deep_analysis_runs",
    "home_layout_tiles",
    "home_layouts",
    "manual_transactions",
    "balance_snapshots",
    "balance_audit",
    "mapping_provider_usage",
    "mapping_provider_reservations",
    "mapping_proposals",
    "mapping_profiles",
    "review_decisions",
    "source_links",
    "transactions",
    "import_commit_batches",
    "parsed_observations",
    "source_objects",
    "imports",
    "data_sources",
    "background_job_attempts",
    "job_dispatch_index",
    "outbox_events",
    "background_job_results",
    "background_jobs",
    "ai_dispatch_permits",
    "ai_exclusions",
    "ai_policies",
    "command_operations",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  stub = await startStubIssuer();
  redisUrl = navRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
  try {
    const probe = await webkit.launch({ headless: true });
    await probe.close();
    webkitOk = true;
  } catch (err) {
    // Best-effort only: recorded honestly, never counted as pass.
    // eslint-disable-next-line no-console
    console.log(`[navigation-jobs] webkit unavailable on this host: ${(err as Error).message}`);
    webkitOk = false;
  }
}, 90_000);

afterAll(async () => {
  if (queue) await queue.close();
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e07-s04 navigation and job feedback", () => {
  it("040 notices migration is additive with forced RLS, NULLIF guard and unscoped zero rows", async () => {
    const tables = await pool.query("SELECT 1 FROM pg_tables WHERE tablename = 'notices'");
    expect(tables.rowCount).toBe(1);
    const forced = await pool.query("SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'notices'");
    expect((forced.rows[0] as { forced: boolean }).forced).toBe(true);
    const policies = await pool.query("SELECT qual, with_check FROM pg_policies WHERE tablename = 'notices'");
    expect(policies.rowCount).toBe(1);
    expect(JSON.stringify(policies.rows[0])).toContain("NULLIF");
    const uniq = await pool.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid = 'notices'::regclass AND contype = 'u' AND pg_get_constraintdef(oid) LIKE '%source_event%'",
    );
    expect(uniq.rowCount).toBe(1);
    // Unscoped app-role reads return zero rows by design (FORCE RLS).
    expect(((await pool.query("SELECT count(*)::int AS n FROM notices")).rows[0] as { n: number }).n).toBe(0);
    const role = await pool.query("SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
    expect((role.rows[0] as { bypass: boolean }).bypass).toBe(false);
  });

  it("a completed import job appears once as a notice after reload; refresh never duplicates or restarts", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-once-${tag}`, "once");
    const { importId } = await insertImport(me.claims);
    const jobId = await insertJob(me.claims, { type: "imports.parse", status: "SUCCEEDED", inputRef: { importId } });

    const first = await call("GET", `${base}/w/${me.workspaceId}/notices`, me.cookie);
    expect(first.status).toBe(200);
    expect(first.text).toContain("Import parsed");
    expect(first.text).toContain(`/w/${me.workspaceId}/imports/${importId}`);
    // Reload + jobs-page refresh converge on exactly one notice; no restart.
    const second = await call("GET", `${base}/w/${me.workspaceId}/notices`, me.cookie);
    expect(second.status).toBe(200);
    await call("GET", `${base}/w/${me.workspaceId}/jobs`, me.cookie);
    const listed = await listNotices(pool, me.claims, me.userId, {});
    expect(listed.total).toBe(1);
    expect(listed.unread).toBe(1);
    expect(listed.notices[0].sourceEvent).toBe(`background_job:${jobId}:SUCCEEDED`);
    const attempts = await scoped(me.claims, async (client) => client.query("SELECT count(*)::int AS n FROM background_job_attempts WHERE workspace_id = $1 AND background_job_id = $2", [me.workspaceId, jobId]));
    expect((attempts.rows[0] as { n: number }).n).toBe(0);
    const status = await scoped(me.claims, async (client) => client.query("SELECT status FROM background_jobs WHERE workspace_id = $1 AND id = $2", [me.workspaceId, jobId]));
    expect((status.rows[0] as { status: string }).status).toBe("SUCCEEDED");
    // Mark-read is idempotent and scoped.
    const read = await call("POST", `${base}/w/${me.workspaceId}/notices/${listed.notices[0].id}/read`, me.cookie, {});
    expect(read.status).toBe(303);
    expect((await listNotices(pool, me.claims, me.userId, {})).unread).toBe(0);
  });

  it("failed jobs show a safe error class plus recovery link, never secrets or raw payloads", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-fail-${tag}`, "fail");
    const { importId } = await insertImport(me.claims);
    const evil = `"><script>alert(1)</script>`;
    const secret = "sk-secret-ABC123-hidden";
    const jobId = await insertJob(me.claims, {
      type: "imports.commit",
      status: "FAILED_FINAL",
      inputRef: { importId, accountId: randomUUID() },
      errorCode: "provider_timeout",
      errorSummary: `raw payload leaked ${secret}`,
    });
    const evilJob = await insertJob(me.claims, { type: "imports.parse", status: "FAILED_FINAL", inputRef: { importId }, errorCode: evil });

    const detail = await call("GET", `${base}/w/${me.workspaceId}/jobs/${jobId}`, me.cookie);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("provider_timeout");
    expect(detail.text).toContain("Review mapping and retry");
    expect(detail.text).toContain(`/w/${me.workspaceId}/imports/${importId}/mapping`);
    expect(detail.text).not.toContain(secret);
    expect(detail.text).not.toContain("<script");
    const evilDetail = await call("GET", `${base}/w/${me.workspaceId}/jobs/${evilJob}`, me.cookie);
    expect(evilDetail.status).toBe(200);
    expect(evilDetail.text).toContain("unknown_error");
    expect(evilDetail.text).not.toContain(evil);
    const notices = await call("GET", `${base}/w/${me.workspaceId}/notices`, me.cookie);
    expect(notices.status).toBe(200);
    expect(notices.text).toContain("Import failed");
    expect(notices.text).toContain("provider_timeout");
    expect(notices.text).not.toContain(secret);
    expect(notices.text).not.toContain("<script");
  });

  it("foreign and deleted references yield uniform 404 or an inert notice", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, `synthetic-nav-xa-${tag}`, "xa");
    const b = await setupWorkspace(base, `synthetic-nav-xb-${tag}`, "xb");
    const { importId } = await insertImport(a.claims);
    const jobId = await insertJob(a.claims, { type: "imports.parse", status: "SUCCEEDED", inputRef: { importId } });
    await call("GET", `${base}/w/${a.workspaceId}/notices`, a.cookie);
    const noticeId = (await listNotices(pool, a.claims, a.userId, {})).notices[0].id;

    // Tenant B sees neither the job nor the notice, and cannot mark it read.
    expect((await call("GET", `${base}/w/${a.workspaceId}/jobs/${jobId}`, b.cookie)).status).toBe(404);
    const bJobs = await call("GET", `${base}/w/${b.workspaceId}/jobs`, b.cookie);
    expect(bJobs.status).toBe(200);
    expect(bJobs.text).toContain("No background jobs yet");
    const bNotices = await call("GET", `${base}/w/${b.workspaceId}/notices`, b.cookie);
    expect(bNotices.text).not.toContain("Import parsed");
    expect((await call("POST", `${base}/w/${a.workspaceId}/notices/${noticeId}/read`, b.cookie, {})).status).toBe(404);
    expect((await call("GET", `${base}/w/${b.workspaceId}/jobs/${jobId}`, b.cookie)).status).toBe(404);
    expect((await call("GET", `${base}/w/${a.workspaceId}/jobs/${randomUUID()}`, a.cookie)).status).toBe(404);

    // Deleted import: the notice goes inert (no dead link), the URL 404s.
    await scoped(a.claims, async (client) => {
      await client.query("DELETE FROM imports WHERE workspace_id = $1 AND id = $2", [a.workspaceId, importId]);
    });
    const after = await call("GET", `${base}/w/${a.workspaceId}/notices`, a.cookie);
    expect(after.status).toBe(200);
    expect(after.text).toContain("Import parsed");
    expect(after.text).toContain("no longer available");
    expect(after.text).not.toContain(`/w/${a.workspaceId}/imports/${importId}`);
    expect((await call("GET", `${base}/w/${a.workspaceId}/imports/${importId}`, a.cookie)).status).toBe(404);
  });

  it("Stop uses the existing cancel command with owner authorization; retry links point at owning domains", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-stop-${tag}`, "stop");
    const other = await setupWorkspace(base, `synthetic-nav-stop-o-${tag}`, "stop-o");
    const queued = await insertJob(me.claims, { type: "imports.start", status: "QUEUED", inputRef: { source: "synthetic", label: "t" } });

    const detail = await call("GET", `${base}/w/${me.workspaceId}/jobs/${queued}`, me.cookie);
    expect(detail.text).toContain("Stop job");
    const stop = await call("POST", `${base}/w/${me.workspaceId}/jobs/${queued}/cancel`, me.cookie, {});
    expect(stop.status).toBe(303);
    expect((await call("GET", `${base}/w/${me.workspaceId}/jobs/${queued}`, me.cookie)).text).toContain("CANCELLED");
    // Foreign workspace path: uniform 404, no state change possible.
    expect((await call("POST", `${base}/w/${me.workspaceId}/jobs/${queued}/cancel`, other.cookie, {})).status).toBe(404);
    // Legacy dead batch-page Cancel form now resolves to the same command.
    expect((await call("POST", `${base}/w/${me.workspaceId}/jobs/${randomUUID()}/cancel`, me.cookie, {})).status).toBe(404);

    const failedAnalysis = await insertJob(me.claims, { type: "deep-analysis.run", status: "FAILED_FINAL", inputRef: { runId: randomUUID() }, errorCode: "timeout" });
    const analysisDetail = await call("GET", `${base}/w/${me.workspaceId}/jobs/${failedAnalysis}`, me.cookie);
    expect(analysisDetail.text).toContain("Retry analysis");
    expect(analysisDetail.text).not.toContain("Stop job");
  });

  it("job page caps at 50 rows; notices cap at 50 per page and 500 visible chars", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-caps-${tag}`, "caps");
    await scoped(me.claims, async (client) => {
      const values = Array.from({ length: 55 }, (_, i) => `('${me.workspaceId}', '${randomUUID()}', 'imports.start', '1', 'QUEUED', 'navcap:${i}:${randomUUID()}', '{"source":"synthetic"}')`).join(",");
      await client.query(`INSERT INTO background_jobs (workspace_id, id, job_type, job_version, status, deduplication_key, input_ref) VALUES ${values}`);
    });
    const page = await call("GET", `${base}/w/${me.workspaceId}/jobs`, me.cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain("of 55");
    expect((page.text.match(/<tr><td>/g) ?? []).length).toBe(50);
    expect((await listJobs(pool, me.claims, { limit: 50, offset: 50 })).jobs.length).toBe(5);
    await expect(listJobs(pool, me.claims, { limit: 51, offset: 0 })).rejects.toThrow();

    await scoped(me.claims, async (client) => {
      for (let i = 0; i < 55; i++) {
        await insertTerminalNoticeTx(client, me.workspaceId, me.userId, {
          sourceEvent: `navcap:${i}`,
          kind: "import_completed",
          title: `Done ${i}`,
          body: `Body ${i}`,
          linkHref: null,
        });
      }
    });
    const notices = await listNotices(pool, me.claims, me.userId, {});
    expect(notices.total).toBe(55);
    expect(notices.notices.length).toBe(50);
    const secondPage = await call("GET", `${base}/w/${me.workspaceId}/notices?offset=50`, me.cookie);
    expect(secondPage.text).toContain("of 55");
    await expect(listNotices(pool, me.claims, me.userId, { limit: 51 })).rejects.toThrow();
    await expect(
      scoped(me.claims, (client) => insertTerminalNoticeTx(client, me.workspaceId, me.userId, { sourceEvent: "toolong", kind: "import_completed", title: "t", body: "x".repeat(501), linkHref: null })),
    ).rejects.toThrow();
    expect((await call("GET", `${base}/w/${me.workspaceId}/jobs?offset=nope`, me.cookie)).status).toBe(400);
  });

  it("palette resolves exact routes with a visible button and fallback links; unknown is 404", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-go-${tag}`, "go");
    const landing = await call("GET", `${base}/w/${me.workspaceId}/go`, me.cookie);
    expect(landing.status).toBe(200);
    expect(landing.text).toContain('id="palette-input"');
    expect(landing.text).toContain("autofocus");
    expect(landing.text).toContain(">Go<");
    expect(landing.text).toContain("All destinations");
    expect(landing.text).not.toContain("<script");
    const money = await call("GET", `${base}/w/${me.workspaceId}/go?to=money`, me.cookie);
    expect(money.status).toBe(303);
    expect(money.location).toBe(`/w/${me.workspaceId}/transactions`);
    const upper = await call("GET", `${base}/w/${me.workspaceId}/go?to=%20PLAN%20`, me.cookie);
    expect(upper.status).toBe(303);
    expect(upper.location).toBe(`/w/${me.workspaceId}/planning`);
    const unknown = await call("GET", `${base}/w/${me.workspaceId}/go?to=quarterly%20report`, me.cookie);
    expect(unknown.status).toBe(404);
    expect(unknown.text).toContain("exact route");
    expect(unknown.text).toContain("All destinations");
  });

  it("workspace nav is present and script-free on Home, chat, import, artifact, jobs and notices", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-shell-${tag}`, "shell");
    const { importId } = await insertImport(me.claims);
    const thread = await call("POST", `${base}/w/${me.workspaceId}/chat/new`, me.cookie, { title: "Nav check" });
    expect(thread.status).toBe(303);
    const threadId = thread.location!.split("/")[4];
    const artifactId = await scoped(me.claims, (client) => createArtifactDraft(client, me.claims, "Nav artifact").then((r) => r.artifactId));
    const urls = [
      `${base}/w/${me.workspaceId}/home`,
      `${base}/w/${me.workspaceId}/chat`,
      `${base}/w/${me.workspaceId}/chat/${threadId}`,
      `${base}/w/${me.workspaceId}/imports/${importId}`,
      `${base}/w/${me.workspaceId}/artifacts`,
      `${base}/w/${me.workspaceId}/artifacts/${artifactId}?tab=preview`,
      `${base}/w/${me.workspaceId}/jobs`,
      `${base}/w/${me.workspaceId}/notices`,
      `${base}/w/${me.workspaceId}/go`,
    ];
    for (const url of urls) {
      const res = await call("GET", url, me.cookie);
      expect(res.status).toBe(200);
      for (const label of [`aria-label="Workspace"`, ">Home<", ">Money<", ">Plan<", ">AI<", ">Jobs<", ">Notices<", "Jump to", 'accesskey="k"']) {
        expect(res.text).toContain(label);
      }
      expect(res.text).not.toContain("<script");
    }
  });

  async function keyboardJourney(browserType: typeof chromium, label: string, linksTabbable = true): Promise<void> {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-kb-${label}-${tag}`, `kb-${label}`);
    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 320, height: 720 }, reducedMotion: "reduce" });
      const equals = me.cookie.indexOf("=");
      await context.addCookies([{ name: me.cookie.slice(0, equals), value: me.cookie.slice(equals + 1), url: base }]);
      const pg = await context.newPage();
      await pg.goto(`${base}/w/${me.workspaceId}/home`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      // 320px: no horizontal overflow on Home.
      expect(await pg.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      // Primary destinations are keyboard-reachable landmarks.
      await pg.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Home" }).waitFor({ state: "visible", timeout: 5_000 });
      if (linksTabbable) {
        // First Tab stop is the skip link (focus restoration target).
        // WebKit is excluded: its default Tab order covers form controls
        // only, not links (platform behavior without full keyboard access).
        await pg.keyboard.press("Tab");
        expect(await pg.evaluate(() => (document.activeElement as HTMLElement).textContent)).toContain("Skip to main content");
        // Keyboard-activate the palette entry, assert autofocus lands in it.
        await pg.getByRole("link", { name: /Jump to/ }).focus();
        await Promise.all([pg.waitForURL(`**/w/${me.workspaceId}/go`, { timeout: 5_000 }), pg.keyboard.press("Enter")]);
      } else {
        await pg.goto(`${base}/w/${me.workspaceId}/go`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      }
      await pg.waitForFunction(() => (document.activeElement as HTMLElement).id === "palette-input", null, { timeout: 5_000 });
      // Escape is safe: it neither submits nor leaves the palette (zero-JS
      // page); the native Clear button empties the field by keyboard.
      await pg.keyboard.type("money");
      await pg.keyboard.press("Escape");
      expect(pg.url()).toContain(`/w/${me.workspaceId}/go`);
      expect(await pg.evaluate(() => (document.getElementById("palette-input") as HTMLInputElement).value)).toBe("money");
      await pg.getByRole("button", { name: "Clear" }).focus();
      await pg.keyboard.press("Enter");
      expect(await pg.evaluate(() => (document.getElementById("palette-input") as HTMLInputElement).value)).toBe("");
      await pg.getByRole("combobox", { name: "Route name" }).focus();
      await pg.keyboard.type("money");
      if (linksTabbable) {
        await Promise.all([pg.waitForURL(`**/w/${me.workspaceId}/transactions`, { timeout: 5_000 }), pg.keyboard.press("Enter")]);
      } else {
        // WebKit consumes Enter inside a datalist-backed input (dismisses
        // suggestions instead of submitting): Tab to the native Go button
        // (form controls do tab in WebKit) and submit by keyboard there.
        await pg.keyboard.press("Tab");
        expect(await pg.evaluate(() => (document.activeElement as HTMLElement).textContent)).toContain("Go");
        await Promise.all([pg.waitForURL(`**/w/${me.workspaceId}/transactions`, { timeout: 5_000 }), pg.keyboard.press("Enter")]);
      }
      // Back returns to the workspace; the skip link stays the first stop
      // (link-tabbable engines; WebKit asserts Back navigation only).
      await pg.goto(`${base}/w/${me.workspaceId}/go`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (linksTabbable) {
        await pg.getByRole("link", { name: "Back" }).focus();
        await Promise.all([pg.waitForURL(`**/w/${me.workspaceId}`, { timeout: 5_000 }), pg.keyboard.press("Enter")]);
        await pg.keyboard.press("Tab");
        expect(await pg.evaluate(() => (document.activeElement as HTMLElement).textContent)).toContain("Skip to main content");
      } else {
        await pg.getByRole("link", { name: "Back" }).click();
        await pg.waitForURL(`**/w/${me.workspaceId}`, { timeout: 5_000 });
      }
      // Jobs + notices expose a screen-reader live status region.
      await pg.goto(`${base}/w/${me.workspaceId}/jobs`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await pg.getByRole("status").first().waitFor({ state: "visible", timeout: 5_000 });
      expect(await pg.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await pg.goto(`${base}/w/${me.workspaceId}/notices`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await pg.getByRole("status").first().waitFor({ state: "visible", timeout: 5_000 });
    } finally {
      await browser.close();
    }
  }

  it("Chromium 320px keyboard journey: nav, palette, Escape, focus, live status", async () => {
    await keyboardJourney(chromium, "chromium");
  }, 60_000);

  it("Firefox 320px keyboard journey: nav, palette, Escape, focus, live status", async () => {
    await keyboardJourney(firefox, "firefox");
  }, 60_000);

  it("WebKit 320px keyboard journey (best-effort)", async (ctx) => {
    if (!webkitOk) {
      // Best-effort only: recorded honestly via skip, never counted as pass.
      ctx.skip();
      return;
    }
    await keyboardJourney(webkit, "webkit", false);
  }, 60_000);

  it("complete Redis loss rebuilds transport from PG; the notice still appears exactly once", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-redis-${tag}`, "redis");
    const accepted = await (
      await fetch(`${base}/api/workspaces/${me.workspaceId}/import-jobs`, {
        method: "POST",
        headers: { cookie: me.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
      })
    ).json() as { jobId: string };
    await dispatchOutbox(pool, queue);
    const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    try {
      await admin.flushdb();
    } finally {
      admin.disconnect();
    }
    const recovered = await dispatchOutbox(pool, queue);
    expect(recovered.enqueued).toBeGreaterThanOrEqual(1);
    expect(await processImportJob(pool, accepted.jobId)).toBe("applied");
    expect(await processImportJob(pool, accepted.jobId)).toBe("duplicate-terminal-noop");
    const first = await call("GET", `${base}/w/${me.workspaceId}/notices`, me.cookie);
    expect(first.text).toContain("Import job finished");
    const second = await call("GET", `${base}/w/${me.workspaceId}/notices`, me.cookie);
    expect(second.status).toBe(200);
    expect((await listNotices(pool, me.claims, me.userId, {})).total).toBe(1);
    const jobs = await call("GET", `${base}/w/${me.workspaceId}/jobs/${accepted.jobId}`, me.cookie);
    expect(jobs.text).toContain("SUCCEEDED");
    expect(redisDb).not.toBe(0);
  }, 60_000);

  it("failed artifact versions produce exactly one safe notice with a recovery link", async () => {
    const base = await startApp();
    const me = await setupWorkspace(base, `synthetic-nav-art-${tag}`, "art");
    const artifactId = await scoped(me.claims, (client) => createArtifactDraft(client, me.claims, "Feedback chart").then((r) => r.artifactId));
    const versionId = randomUUID();
    await scoped(me.claims, async (client) => {
      await client.query(
        "INSERT INTO artifact_versions (workspace_id, id, artifact_id, manifest, source_hash, build_hash, status, error_class, settled_at) VALUES ($1, $2, $3, '{}', decode('aa','hex'), decode('bb','hex'), 'failed', 'build_timeout', now())",
        [me.workspaceId, versionId, artifactId],
      );
    });
    const page = await call("GET", `${base}/w/${me.workspaceId}/notices`, me.cookie);
    expect(page.text).toContain("Artifact build failed");
    expect(page.text).toContain("build_timeout");
    expect(page.text).toContain(`/w/${me.workspaceId}/artifacts/${artifactId}?tab=versions`);
    await call("GET", `${base}/w/${me.workspaceId}/notices`, me.cookie);
    expect((await listNotices(pool, me.claims, me.userId, {})).total).toBe(1);
  });

  it("migration 040 rolls back and re-applies on the suite database", async () => {
    const { readFileSync } = await import("node:fs");
    const admin = await pool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query(readFileSync("apps/web/migrations/040_notices.rollback.sql", "utf8"));
      await admin.query("COMMIT");
    } catch (err) {
      try {
        await admin.query("ROLLBACK");
      } catch { /* preserve */ }
      throw err;
    } finally {
      admin.release();
    }
    const gone = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'notices'");
    expect((gone.rows[0] as { n: number }).n).toBe(0);
    await pool.query("DELETE FROM schema_migrations WHERE version = '040_notices'");
    const { migrate } = await import("../apps/web/src/db.ts");
    await migrate(pool, "apps/web/migrations");
    const back = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'notices'");
    expect((back.rows[0] as { n: number }).n).toBe(1);
    const recorded = await pool.query("SELECT 1 FROM schema_migrations WHERE version = '040_notices'");
    expect(recorded.rowCount).toBe(1);
  });
});
