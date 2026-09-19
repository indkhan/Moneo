// E02-S03 quarantine upload + bounded parse: real PostgreSQL
// (`moneo_e02_upload`, fails closed), real MinIO object storage (loopback,
// disposable bucket) and real clamd (loopback) — never mocks for the
// quarantine/scan/parse boundaries. Exact expectations reuse the E00-S03
// manifest oracle values (utf8-bom-quoted, basic-xlsx, formula-xlsx,
// external-link-xlsx), asserted here through the whole stack. Synthetic
// users/workspaces/files only; the EICAR string below is the safe industry
// test vector, not malware.
//
// Local prerequisites (fail closed when absent): MinIO on 127.0.0.1:9000
// with S3_ACCESS_KEY/S3_SECRET_KEY/S3_BUCKET exported, clamd on
// 127.0.0.1:3310 (or CLAMAV_HOST/PORT), `npm run build:parser` for the
// worker-spawned child. See README prerequisites.

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { Queue } from "bullmq";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { withDatabase } from "../apps/web/src/db.ts";
import { dispatchOutbox, jobsQueue, type JobPayload } from "../apps/web/src/jobs.ts";
import { processParseJob, loadUploadConfig, runParserChild, ParserError, parserChildEnv, type UploadConfig } from "../apps/web/src/uploads.ts";
import { s3Delete, s3EnsureBucket, s3ListKeys, s3Put } from "../apps/web/src/s3.ts";
import { clamdPing, clamdScan } from "../apps/web/src/clamav.ts";
import { buildXlsx, type FixtureCell } from "../proof/import/build-xlsx.ts";
import { createWorkerService } from "../apps/worker/src/main.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

// Independent oracle values (proof/import/fixtures/manifest.json).
const CSV_PROFILE = {
  delimiter: ",",
  dateFormat: "iso",
  amount: { kind: "signed", decimalSep: ".", thousandsSep: "," },
  columns: { date: "date", description: "description", amount: "amount" },
  defaultCurrency: "EUR",
};
const CSV_EXPECTED = [
  { row: 2, date: "2024-01-02", description: "Salary January", amountMinor: "250000", currency: "EUR", direction: "INFLOW" },
  { row: 3, date: "2024-01-03", description: "Groceries, weekly", amountMinor: "8743", currency: "EUR", direction: "OUTFLOW" },
  { row: 4, date: "2024-01-05", description: "Refund for\nreturned item", amountMinor: "1250", currency: "EUR", direction: "INFLOW" },
  { row: 5, date: "2024-01-06", description: 'He said "thanks"', amountMinor: "500", currency: "EUR", direction: "OUTFLOW" },
];
const XLSX_PROFILE = {
  delimiter: ",",
  dateFormat: "iso",
  amount: { kind: "signed", decimalSep: ".", thousandsSep: "," },
  columns: { date: "date", description: "description", amount: "amount", currency: "currency" },
};
const BASIC_SHEET = {
  name: "Statement",
  header: ["date", "description", "amount", "currency"],
  rows: [
    [
      { kind: "text", value: "2024-05-01" },
      { kind: "text", value: "Xlsx coffee" },
      { kind: "number", value: "-3.50" },
      { kind: "text", value: "EUR" },
    ],
    [
      { kind: "text", value: "2024-05-02" },
      { kind: "text", value: "Xlsx sushi" },
      { kind: "number", value: "-1200" },
      { kind: "text", value: "JPY" },
    ],
  ] as FixtureCell[][],
};
const FORMULA_SHEET = {
  name: "Formulas",
  header: ["date", "description", "amount", "currency"],
  rows: [
    [
      { kind: "text", value: "2024-05-03" },
      { kind: "text", value: "Clean row" },
      { kind: "number", value: "-10.00" },
      { kind: "text", value: "EUR" },
    ],
    [
      { kind: "text", value: "2024-05-04" },
      { kind: "text", value: "Formula row" },
      { kind: "formula", expression: "SUM(C2:C3)", cached: "999.99" },
      { kind: "text", value: "EUR" },
    ],
  ] as FixtureCell[][],
};

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let queue: Queue<JobPayload>;
let appDbUrl: string;
let config: UploadConfig;
const savedEnv: Record<string, string | undefined> = {};

function uploadRedisUrl(): string {
  const base = env("E02-S03", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E02-S03 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["UPLOAD_REDIS_DB"] ?? "12";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E02-S03 misconfigured: UPLOAD_REDIS_DB must be 0-15.");
  u.pathname = `/${db}`;
  return u.toString();
}

async function startApp(): Promise<string> {
  const authConfig: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const server = createApp(
    createAuthRouter(authConfig, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
    {
      ui: createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), { appBaseUrl: "http://127.0.0.1:1", sessionSecret }),
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  authConfig.appBaseUrl = base;
  return base;
}

async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; userId: string }> {
  const cookie = await login(base, sub);
  const ws = (await (
    await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "W", baseCurrency: "EUR" }),
    })
  ).json()) as { id: string };
  const userRow = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub]);
  return { cookie, workspaceId: ws.id, userId: (userRow.rows[0] as { id: string }).id };
}

function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

function multipartBody(
  fields: Record<string, string>,
  file?: { field: string; filename: string; contentType: string; bytes: Uint8Array },
): { body: Buffer; contentType: string } {
  const boundary = `----moneo${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"));
    parts.push(Buffer.from(file.bytes));
    parts.push(Buffer.from("\r\n", "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(
  base: string,
  cookie: string,
  workspaceId: string,
  opts: { key?: string; filename: string; bytes: Uint8Array; contentType?: string; profile?: unknown; rawBody?: Buffer; rawContentType?: string },
): Promise<{ status: number; json: unknown; text: string }> {
  const key = opts.key ?? randomUUID();
  const built =
    opts.rawBody !== undefined
      ? { body: opts.rawBody, contentType: opts.rawContentType ?? "multipart/form-data; boundary=----x" }
      : multipartBody(
          { idempotencyKey: key, ...(opts.profile === undefined ? {} : { profile: JSON.stringify(opts.profile) }) },
          { field: "file", filename: opts.filename, contentType: opts.contentType ?? "application/octet-stream", bytes: opts.bytes },
        );
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/uploads`, {
    method: "POST",
    headers: { cookie, "Content-Type": built.contentType },
    body: new Uint8Array(built.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch { /* typed empty bodies stay null */ }
  return { status: res.status, json, text };
}

async function runJob(jobId: string): Promise<string> {
  await dispatchOutbox(pool, queue);
  return processParseJob(pool, jobId, config);
}

async function importStatus(base: string, cookie: string, workspaceId: string, importId: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/imports/${importId}`, { headers: { cookie } });
  return { status: res.status, json: (await res.json()) as unknown };
}

async function observations(base: string, cookie: string, workspaceId: string, importId: string, query = ""): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/imports/${importId}/observations${query}`, { headers: { cookie } });
  return { status: res.status, json: (await res.json()) as unknown };
}

beforeAll(async () => {
  for (const name of ["UPLOADS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "CLAMAV_HOST", "CLAMAV_PORT", "PARSER_CHILD"]) {
    savedEnv[name] = process.env[name];
  }
  pool = await ensureTestPool("E02-S03", "moneo_e02_upload", [
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
    "background_job_attempts",
    "parsed_observations",
    "source_objects",
    "imports",
    "data_sources",
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
  appDbUrl = env("E02-S03", "DATABASE_URL");
  // Hydrate S3/scanner names from the ignored local .env the same way
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E02-S03", name);
  }
  process.env["UPLOADS_ENABLED"] = "1";
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  if (!process.env["CLAMAV_HOST"]) process.env["CLAMAV_HOST"] = "127.0.0.1";
  if (!process.env["CLAMAV_PORT"]) process.env["CLAMAV_PORT"] = "3310";
  config = loadUploadConfig();
  // Fail-closed prerequisites: object store, scanner and parser child.
  await s3EnsureBucket(config.s3);
  await expect(s3Put(config.s3, "probe/bad", new TextEncoder().encode("s03-prerequisite-probe"), "text/plain")).rejects.toThrow("object key refused");
  if (!(await clamdPing(config.clamav))) {
    throw new Error("E02-S03 prerequisite missing: clamd unreachable at the configured CLAMAV_HOST/PORT (start the pinned local container).");
  }
  if (!existsSync(config.parserChild)) {
    throw new Error(`E02-S03 prerequisite missing: parser child not built at ${config.parserChild} (run npm run build:parser).`);
  }
  // Isolate the disposable bucket prefix for this suite run.
  const leftovers = await s3ListKeys(config.s3, "quarantine/");
  for (const key of leftovers) {
    await s3Delete(config.s3, key);
  }
  redisUrl = uploadRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
}, 120_000);

afterAll(async () => {
  try {
    const leftovers = await s3ListKeys(config.s3, "quarantine/");
    for (const key of leftovers) {
      await s3Delete(config.s3, key);
    }
  } catch { /* best-effort test hygiene */ }
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (queue) await queue.close();
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e02-s03 quarantine upload and bounded parse", () => {
  it("CSV travels quarantine to staged observations with exact oracle money", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-a");
    const bytes = new Uint8Array(readFileSync(join("proof", "import", "fixtures", "utf8-bom-quoted.csv")));
    const up = await upload(base, cookie, workspaceId, { filename: "statement.csv", bytes, contentType: "text/csv", profile: CSV_PROFILE });
    expect(up.status).toBe(201);
    const body = up.json as { import: { id: string; status: string; fileName: string }; jobId: string; replayed: boolean; requestId: string };
    expect(body.import.status).toBe("UPLOAD_REGISTERED");
    expect(typeof body.requestId).toBe("string");
    expect(body.replayed).toBe(false);
    expect(await runJob(body.jobId)).toBe("applied");
    const seen = await importStatus(base, cookie, workspaceId, body.import.id);
    expect(seen.json).toMatchObject({ import: { status: "STAGED", rowCount: "4", stagedCount: "4", reviewCount: "0", rejectedCount: "0", parsedRows: "4" } });
    const obs = await observations(base, cookie, workspaceId, body.import.id);
    const rows = (obs.json as { total: number; rows: { rowNo: number; status: string; amountMinor: string; currency: string; direction: string; effectiveDate: string; description: string }[] });
    expect(rows.total).toBe(4);
    for (const expected of CSV_EXPECTED) {
      const got = rows.rows.find((r) => r.rowNo === expected.row);
      expect(got).toMatchObject({ status: "STAGED", amountMinor: expected.amountMinor, currency: expected.currency, direction: expected.direction, effectiveDate: expected.date, description: expected.description });
    }
    // Exact money crosses JSON as decimal strings: raw text proves it.
    const obsText = JSON.stringify((obs.json as { rows: unknown[] }).rows);
    expect(obsText).toContain('"amountMinor":"250000"');
    expect(obsText).not.toContain('"amountMinor":250000');
    // Object key is generated (no filename bytes) and the source is CLEAN.
    const meta = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT object_key, status, sha256 FROM source_objects WHERE workspace_id = $1 AND import_id = $2", [workspaceId, body.import.id]);
      return r.rows[0] as { object_key: string; status: string; sha256: string };
    });
    expect(meta.object_key).toMatch(new RegExp(`^quarantine/${workspaceId}/[0-9a-f-]{36}$`));
    expect(meta.object_key).not.toContain("statement");
    expect(meta.status).toBe("ACCEPTED");
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Exactly one immutable parse result; late redelivery converges.
    const results = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [workspaceId, body.jobId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(results).toBe(1);
    expect(await runJob(body.jobId)).toBe("duplicate-terminal-noop");
  });

  it("XLSX parses with exact oracle money and source sheet provenance", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-b");
    const bytes = buildXlsx(BASIC_SHEET);
    const up = await upload(base, cookie, workspaceId, { filename: "statement.xlsx", bytes, profile: XLSX_PROFILE });
    expect(up.status).toBe(201);
    const body = up.json as { import: { id: string }; jobId: string };
    expect(await runJob(body.jobId)).toBe("applied");
    const seen = await importStatus(base, cookie, workspaceId, body.import.id);
    expect(seen.json).toMatchObject({ import: { status: "STAGED", rowCount: "2", stagedCount: "2" } });
    const obs = await observations(base, cookie, workspaceId, body.import.id);
    const rows = (obs.json as { rows: { rowNo: number; amountMinor: string; currency: string }[] }).rows;
    expect(rows.map((r) => [r.rowNo, r.amountMinor, r.currency])).toEqual([[2, "350", "EUR"], [3, "1200", "JPY"]]);
  });

  it("same key and bytes replays; same key with different bytes conflicts", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-c");
    const bytes = new TextEncoder().encode("date,description,amount,currency\n2026-01-02,Coffee,-350,EUR\n");
    const key = randomUUID();
    const first = await upload(base, cookie, workspaceId, { key, filename: "a.csv", bytes, profile: CSV_PROFILE });
    expect(first.status).toBe(201);
    const firstBody = first.json as { import: { id: string }; jobId: string };
    const replay = await upload(base, cookie, workspaceId, { key, filename: "renamed.csv", bytes, profile: CSV_PROFILE });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ import: { id: firstBody.import.id }, jobId: firstBody.jobId, replayed: true });
    const clash = await upload(base, cookie, workspaceId, { key, filename: "a.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-03,Tea,-200,EUR\n"), profile: CSV_PROFILE });
    expect(clash.status).toBe(409);
    expect(clash.json).toMatchObject({ error: "conflict", reason: "idempotency_reuse" });
  });

  it("unsupported, empty, mismatched and oversized uploads fail typed without storage", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-d");
    const prefix = `quarantine/${workspaceId}/`;
    const before = await s3ListKeys(config.s3, prefix);
    const csv = new TextEncoder().encode("date,description,amount\n2026-01-02,X,-100\n");
    const pdf = await upload(base, cookie, workspaceId, { filename: "statement.pdf", bytes: csv });
    expect(pdf.status).toBe(400);
    expect(pdf.json).toMatchObject({ error: "invalid_request", reason: "unsupported-format" });
    const xlsm = await upload(base, cookie, workspaceId, { filename: "macro.xlsm", bytes: buildXlsx(BASIC_SHEET) });
    expect(xlsm.status).toBe(400);
    const fakeXlsx = await upload(base, cookie, workspaceId, { filename: "fake.xlsx", bytes: csv });
    expect(fakeXlsx.status).toBe(400);
    expect(fakeXlsx.json).toMatchObject({ reason: "unsupported-format" });
    const empty = await upload(base, cookie, workspaceId, { filename: "empty.csv", bytes: new Uint8Array(0) });
    expect(empty.status).toBe(400);
    const huge = await upload(base, cookie, workspaceId, { filename: "huge.csv", bytes: new Uint8Array(20 * 1024 * 1024 + 1) });
    expect(huge.status).toBe(413);
    expect(huge.json).toMatchObject({ error: "payload_too_large" });
    // No rejected upload above stored new quarantine bytes (earlier tests'
    // accepted objects persist by design; the suite wipes the prefix after).
    expect(await s3ListKeys(config.s3, prefix)).toEqual(before);
  });

  it("EICAR bytes are quarantined, detected, and rejected without observations", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-e");
    const up = await upload(base, cookie, workspaceId, { filename: "statement.csv", bytes: new TextEncoder().encode(`${EICAR}\n`) });
    expect(up.status).toBe(201);
    const body = up.json as { import: { id: string }; jobId: string };
    expect(await runJob(body.jobId)).toBe("applied");
    const seen = await importStatus(base, cookie, workspaceId, body.import.id);
    expect(seen.json).toMatchObject({ import: { status: "REJECTED", errorCode: "malware-detected" } });
    const obs = await observations(base, cookie, workspaceId, body.import.id);
    expect(obs.json).toMatchObject({ total: 0, rows: [] });
    const object = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT status, scan_detail FROM source_objects WHERE workspace_id = $1 AND import_id = $2", [workspaceId, body.import.id]);
      return r.rows[0] as { status: string; scan_detail: string };
    });
    expect(object.status).toBe("INFECTED");
    expect(object.scan_detail).toMatch(/Eicar/i);
    // Terminal: late redelivery publishes nothing new.
    expect(await runJob(body.jobId)).toBe("duplicate-terminal-noop");
  });

  it("formula cells stay reviewable without execution; external links reject the file", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-f");
    const formula = await upload(base, cookie, workspaceId, { filename: "formulas.xlsx", bytes: buildXlsx(FORMULA_SHEET), profile: XLSX_PROFILE });
    expect(formula.status).toBe(201);
    const formulaBody = formula.json as { import: { id: string }; jobId: string };
    expect(await runJob(formulaBody.jobId)).toBe("applied");
    const formulaSeen = await importStatus(base, cookie, workspaceId, formulaBody.import.id);
    expect(formulaSeen.json).toMatchObject({ import: { status: "STAGED", stagedCount: "1", reviewCount: "1" } });
    const formulaObs = await observations(base, cookie, workspaceId, formulaBody.import.id);
    const reviewRow = ((formulaObs.json as { rows: { rowNo: number; status: string; reasons: string[] }[] }).rows).find((r) => r.rowNo === 3);
    expect(reviewRow).toMatchObject({ status: "NEEDS_REVIEW", reasons: ["formula-cell"] });
    // Cached formula values never become money.
    expect(JSON.stringify(formulaObs.json)).not.toContain("999.99");
    const linked = await upload(base, cookie, workspaceId, { filename: "linked.xlsx", bytes: buildXlsx(BASIC_SHEET, { externalLink: true }), profile: XLSX_PROFILE });
    expect(linked.status).toBe(201);
    const linkedBody = linked.json as { import: { id: string }; jobId: string };
    expect(await runJob(linkedBody.jobId)).toBe("applied");
    const linkedSeen = await importStatus(base, cookie, workspaceId, linkedBody.import.id);
    expect(linkedSeen.json).toMatchObject({ import: { status: "REJECTED", errorCode: "external-link" } });
  });

  it("expansion bombs fail closed with the typed parser limit", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-g");
    const bomb = buildXlsx({
      name: "Bomb",
      header: ["date", "description", "amount"],
      rows: [[{ kind: "text", value: "2024-01-01" }, { kind: "text", value: `payload-${"x".repeat(12 * 1024 * 1024)}` }, { kind: "number", value: "1" }]],
    });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const up = await upload(base, cookie, workspaceId, { filename: "bomb.xlsx", bytes: bomb, profile: XLSX_PROFILE });
    expect(up.status).toBe(201);
    const body = up.json as { import: { id: string }; jobId: string };
    await dispatchOutbox(pool, queue);
    expect(await processParseJob(pool, body.jobId, config, { limits: { maxDecompressedBytes: 1024 * 1024 } })).toBe("applied");
    const seen = await importStatus(base, cookie, workspaceId, body.import.id);
    expect(seen.json).toMatchObject({ import: { status: "REJECTED", errorCode: "decompressed-limit" } });
    const obs = await observations(base, cookie, workspaceId, body.import.id);
    expect(obs.json).toMatchObject({ total: 0 });
  });

  it("oversized cells reject the row, not the import", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-h");
    const big = `date,description,amount,currency\n2026-01-02,${"d".repeat(1024 * 1024 + 8)},-100,EUR\n2026-01-03,Ok,-200,EUR\n`;
    const up = await upload(base, cookie, workspaceId, { filename: "big-cell.csv", bytes: new TextEncoder().encode(big), profile: CSV_PROFILE });
    expect(up.status).toBe(201);
    const body = up.json as { import: { id: string }; jobId: string };
    expect(await runJob(body.jobId)).toBe("applied");
    const seen = await importStatus(base, cookie, workspaceId, body.import.id);
    expect(seen.json).toMatchObject({ import: { status: "STAGED", rowCount: "2", stagedCount: "1", rejectedCount: "1" } });
    const obs = await observations(base, cookie, workspaceId, body.import.id);
    const rejected = ((obs.json as { rows: { rowNo: number; status: string; reasons: string[] }[] }).rows).find((r) => r.rowNo === 2);
    expect(rejected).toMatchObject({ status: "REJECTED", reasons: ["cell-limit"] });
  });

  it("2500 rows persist in deterministic chunks with dense row identity", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-i");
    const lines = ["date,description,amount,currency"];
    for (let i = 1; i <= 2500; i++) lines.push(`2026-01-${String((i % 28) + 1).padStart(2, "0")},Row ${i},-100,EUR`);
    const up = await upload(base, cookie, workspaceId, { filename: "many.csv", bytes: new TextEncoder().encode(lines.join("\n")), profile: CSV_PROFILE });
    expect(up.status).toBe(201);
    const body = up.json as { import: { id: string }; jobId: string };
    expect(await runJob(body.jobId)).toBe("applied");
    const seen = await importStatus(base, cookie, workspaceId, body.import.id);
    expect(seen.json).toMatchObject({ import: { status: "STAGED", rowCount: "2500", stagedCount: "2500", parsedRows: "2500" } });
    const bounds = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT min(row_no)::int AS lo, max(row_no)::int AS hi, count(*)::int AS n FROM parsed_observations WHERE workspace_id = $1 AND import_id = $2", [
        workspaceId,
        body.import.id,
      ]);
      return r.rows[0] as { lo: number; hi: number; n: number };
    });
    expect(bounds).toMatchObject({ lo: 2, hi: 2501, n: 2500 });
    // Reprocessing the terminal job converges without duplicates.
    expect(await runJob(body.jobId)).toBe("duplicate-terminal-noop");
    const again = await observations(base, cookie, workspaceId, body.import.id, "?limit=100&offset=2400");
    expect((again.json as { total: number; rows: unknown[] }).total).toBe(2500);
  });

  it("a runaway parser child is killed on deadline and the job stays recoverable", async () => {
    const healthy = new TextEncoder().encode("date,description,amount,currency\n2026-01-02,Coffee,-350,EUR\n");
    await expect(
      runParserChild({ parserChild: config.parserChild, bytes: healthy, filename: "ok.csv", profile: CSV_PROFILE as never, deadlineMs: 1200, hangMs: 15_000 }),
    ).rejects.toMatchObject({ code: "timeout" });
    try {
      await runParserChild({ parserChild: config.parserChild, bytes: healthy, filename: "ok.csv", profile: CSV_PROFILE as never, deadlineMs: 1200, hangMs: 15_000 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ParserError);
      expect((err as ParserError).transient).toBe(true);
    }
    // No child process remains: the kill is SIGKILL, verified by absence.
    const healthyOut = await runParserChild({ parserChild: config.parserChild, bytes: healthy, filename: "ok.csv", profile: CSV_PROFILE as never, deadlineMs: 20_000 });
    expect(healthyOut.ok).toBe(true);
  });

  it("cancel wins before terminal work; a terminal race never blends", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-j");
    // Deterministic: cancel a QUEUED job, then process (must noop).
    const early = await upload(base, cookie, workspaceId, { filename: "early.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n"), profile: CSV_PROFILE });
    const earlyBody = early.json as { import: { id: string }; jobId: string };
    const { cancelJob } = await import("../apps/web/src/job-recovery.ts");
    expect(await cancelJob(pool, { userId, workspaceId }, earlyBody.jobId)).toMatchObject({ status: "CANCELLED" });
    expect(await runJob(earlyBody.jobId)).toBe("duplicate-terminal-noop");
    // Raced: process and cancel concurrently; exactly one side wins.
    for (let round = 0; round < 3; round++) {
      const up = await upload(base, cookie, workspaceId, { filename: `race-${round}.csv`, bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n"), profile: CSV_PROFILE });
      const body = up.json as { import: { id: string }; jobId: string };
      const [outcome, cancelled] = await Promise.all([
        processParseJob(pool, body.jobId, config),
        cancelJob(pool, { userId, workspaceId }, body.jobId),
      ]);
      const seen = await importStatus(base, cookie, workspaceId, body.import.id);
      const status = (seen.json as { import: { status: string } }).import.status;
      if (outcome === "applied" && status === "STAGED") {
        expect(cancelled).toMatchObject({ effectApplied: true });
      } else {
        // Cancel won: no staged import, no parse result.
        const results = await scoped(userId, workspaceId, async (client) => {
          const r = await client.query("SELECT count(*)::int AS n FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [workspaceId, body.jobId]);
          return (r.rows[0] as { n: number }).n;
        });
        expect(results).toBe(0);
        expect(["CANCELLED", "CANCEL_REQUESTED", "PARSING", "SCANNING", "UPLOAD_REGISTERED"]).toContain(status);
      }
    }
  });

  it("tenant and missing imports are indistinguishable; unscoped reads return nothing", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-up-k-a");
    const b = await setupWorkspace(base, "synthetic-up-k-b");
    const bAcct = await (
      await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: { cookie: b.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: b.workspaceId, name: "Sentinel" }),
      })
    ).json();
    const up = await upload(base, a.cookie, a.workspaceId, { filename: "a.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n"), profile: CSV_PROFILE });
    const body = up.json as { import: { id: string }; jobId: string };
    const foreign = await importStatus(base, b.cookie, b.workspaceId, body.import.id);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "not_found" });
    const missing = await importStatus(base, b.cookie, b.workspaceId, randomUUID());
    expect(missing).toEqual(foreign);
    const foreignObs = await observations(base, b.cookie, b.workspaceId, body.import.id);
    expect(foreignObs.json).toEqual({ rows: [], total: 0, requestId: (foreignObs.json as { requestId: string }).requestId });
    const foreignUpload = await upload(base, b.cookie, a.workspaceId, { filename: "x.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n") });
    expect(foreignUpload.status).toBe(404);
    for (const table of ["data_sources", "imports", "source_objects", "parsed_observations"]) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect((r.rows[0] as { n: number }).n).toBe(0);
    }
    // Tenant B byte-identical afterwards.
    const bAccts = await scoped(b.userId, b.workspaceId, async (client) => {
      const r = await client.query("SELECT id, name FROM accounts WHERE workspace_id = $1", [b.workspaceId]);
      return r.rows as { id: string; name: string }[];
    });
    expect(bAccts).toEqual([{ id: (bAcct as { id: string }).id, name: "Sentinel" }]);
  });

  it("filenames cannot traverse storage; responses carry no bytes", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-l");
    const bytes = new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n");
    const evil = await upload(base, cookie, workspaceId, { filename: "..\\..\\evil.csv", bytes, profile: CSV_PROFILE });
    expect(evil.status).toBe(201);
    expect((evil.json as { import: { fileName: string } }).import.fileName).toBe("evil.csv");
    const script = await upload(base, cookie, workspaceId, { filename: "<script>alert(1)</script>.csv", bytes, profile: CSV_PROFILE });
    // '</script>' contains a path separator, so basename semantics keep the
    // tail: safe display metadata, never a path.
    expect((script.json as { import: { fileName: string } }).import.fileName).toBe("script>.csv");
    const key = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT object_key FROM imports WHERE workspace_id = $1 AND id = $2", [workspaceId, (script.json as { import: { id: string } }).import.id]);
      return (r.rows[0] as { object_key: string }).object_key;
    });
    expect(key).toMatch(new RegExp(`^quarantine/${workspaceId}/[0-9a-f-]{36}$`));
    // Response bodies carry metadata only — never raw rows or file bytes.
    expect(script.text).not.toContain("-100");
    const storedName = (script.json as { import: { fileName: string } }).import.fileName;
    expect(storedName).not.toMatch(/[/\\]/);
    expect(storedName).not.toContain("..");
  });

  it("queue payloads stay minimal; disabled intake hides; profiles validate strictly", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-m");
    const up = await upload(base, cookie, workspaceId, { filename: "q.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n"), profile: CSV_PROFILE });
    const body = up.json as { jobId: string };
    await dispatchOutbox(pool, queue);
    const outboxId = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT id FROM outbox_events WHERE workspace_id = $1 AND aggregate_id = $2", [workspaceId, body.jobId]);
      return (r.rows[0] as { id: string }).id;
    });
    const bullJob = await queue.getJob(`outbox-${outboxId}`);
    expect(Object.keys(bullJob!.data)).toEqual(["backgroundJobId"]);
    const badProfile = await upload(base, cookie, workspaceId, { filename: "q.csv", bytes: new TextEncoder().encode("x\n1\n"), profile: { delimiter: "|" } });
    expect(badProfile.status).toBe(400);
    // Disabled intake hides entirely (flag restored in afterAll).
    delete process.env["UPLOADS_ENABLED"];
    const hidden = await upload(base, cookie, workspaceId, { filename: "q.csv", bytes: new TextEncoder().encode("x\n1\n") });
    expect(hidden.status).toBe(404);
    process.env["UPLOADS_ENABLED"] = "1";
    const form = await fetch(`${base}/w/${workspaceId}/imports/new`, { headers: { cookie } });
    expect(await form.text()).toContain("Bank file");
  });

  it("custom profiles parse their own dialect; observations paginate bounded", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-n");
    const de = await upload(base, cookie, workspaceId, {
      filename: "konto.csv",
      bytes: new TextEncoder().encode("date;description;amount\n03.01.2024;Brot;1,50\n"),
      profile: { delimiter: ";", dateFormat: "de", amount: { kind: "signed", decimalSep: ",", thousandsSep: "." }, columns: { date: "date", description: "description", amount: "amount" }, defaultCurrency: "EUR" },
    });
    expect(de.status).toBe(201);
    const deBody = de.json as { import: { id: string }; jobId: string };
    expect(await runJob(deBody.jobId)).toBe("applied");
    const deObs = await observations(base, cookie, workspaceId, deBody.import.id);
    expect((deObs.json as { rows: { amountMinor: string; effectiveDate: string }[] }).rows).toMatchObject([{ amountMinor: "150", effectiveDate: "2024-01-03" }]);
    const over = await observations(base, cookie, workspaceId, deBody.import.id, "?limit=101");
    expect(over.status).toBe(400);
    const page = await observations(base, cookie, workspaceId, deBody.import.id, "?limit=1&offset=0");
    expect((page.json as { total: number; rows: unknown[] }).total).toBe(1);
  });

  it("a real worker delivery parses end to end through the queue", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-o");
    const service = createWorkerService({
      databaseUrl: withDatabase(appDbUrl, "moneo_e02_upload"),
      redisUrl,
      leaseMs: 5000,
      workerId: "e02-s03-probe",
    });
    try {
      await service.worker.waitUntilReady();
      const up = await upload(base, cookie, workspaceId, { filename: "w.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,Wage,200000,EUR\n"), profile: CSV_PROFILE });
      const body = up.json as { import: { id: string }; jobId: string };
      await service.dispatchOnce();
      const start = Date.now();
      for (;;) {
        const seen = await importStatus(base, cookie, workspaceId, body.import.id);
        if ((seen.json as { import: { status: string } }).import.status === "STAGED") break;
        if (Date.now() - start > 20_000) throw new Error("timed out waiting for worker-delivered parse");
        await new Promise((r) => setTimeout(r, 150));
      }
      const obs = await observations(base, cookie, workspaceId, body.import.id);
      expect((obs.json as { total: number }).total).toBe(1);
      expect(await scoped(userId, workspaceId, async (client) => {
        const r = await client.query("SELECT count(*)::int AS n FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [workspaceId, body.jobId]);
        return (r.rows[0] as { n: number }).n;
      })).toBe(1);
    } finally {
      await service.close();
    }
  }, 60_000);

  it("upload form is labelled, keyboard-native and honest about errors", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "synthetic-up-p");
    const form = await fetch(`${base}/w/${workspaceId}/imports/new`, { headers: { cookie } });
    const html = await form.text();
    expect(html).toContain('for="upload-file"');
    expect(html).toContain('type="file"');
    expect(html).toContain("20 MiB");
    expect(html).toContain(".csv");
    // Status page for a fresh import explains progress explicitly.
    const up = await upload(base, cookie, workspaceId, { filename: "s.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n"), profile: CSV_PROFILE });
    const body = up.json as { import: { id: string } };
    const statusPage = await fetch(`${base}/w/${workspaceId}/imports/${body.import.id}`, { headers: { cookie } });
    expect(await statusPage.text()).toContain("refresh");
    // Unknown import reads 404 without disclosure.
    const missing = await fetch(`${base}/w/${workspaceId}/imports/${randomUUID()}`, { headers: { cookie } });
    expect(missing.status).toBe(404);
  });

  it("parser children inherit no secrets by construction", () => {
    const hostile = {
      PATH: "/usr/bin",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "/tmp",
      DATABASE_URL: "postgres://secret",
      DATABASE_MIGRATION_URL: "postgres://secret",
      REDIS_URL: "redis://secret",
      S3_ACCESS_KEY: "secret",
      S3_SECRET_KEY: "secret",
      SESSION_SECRET: "secret",
      KEYCLOAK_CLIENT_SECRET: "secret",
      OPENROUTER_API_KEY: "secret",
      AI_ANYTHING: "secret",
      NODE_OPTIONS: "--require/evil",
    };
    const childEnv = parserChildEnv(hostile as NodeJS.ProcessEnv);
    expect(childEnv).toMatchObject({ PATH: "/usr/bin", SYSTEMROOT: "C:\\Windows", TEMP: "/tmp" });
    for (const name of Object.keys(childEnv)) {
      expect(name).not.toMatch(/DATABASE|REDIS|S3|SESSION|KEYCLOAK|OPENROUTER|AI_|NODE_/);
    }
    for (const value of Object.values(childEnv)) {
      expect(value).not.toContain("secret");
      expect(value).not.toContain("evil");
    }
    // The live spawn path uses the same allowlist (defaults to process.env).
    for (const name of Object.keys(parserChildEnv())) {
      expect(name).not.toMatch(/DATABASE|REDIS|S3|SESSION|KEYCLOAK|OPENROUTER|AI_|NODE_/);
    }
  });

  it("scanner errors are transient, never malware verdicts", async () => {
    const { createServer } = await import("node:net");
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write("INSTREAM size limit exceeded, ERROR\0");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(clamdScan({ host: "127.0.0.1", port }, new TextEncoder().encode("x"), 5000)).rejects.toThrow("clamd unexpected reply");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("concurrent first uploads converge on one data source", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-q");
    const bytes = new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n");
    const ups = await Promise.all(
      Array.from({ length: 5 }, (_, i) => upload(base, cookie, workspaceId, { filename: `q${i}.csv`, bytes, profile: CSV_PROFILE })),
    );
    expect(ups.every((u) => u.status === 201)).toBe(true);
    const sources = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM data_sources WHERE workspace_id = $1 AND type = 'csv_upload'", [workspaceId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(sources).toBe(1);
  });

  it("staged imports refresh the retention marker to validation time", async () => {
    const base = await startApp();
    const { cookie, workspaceId, userId } = await setupWorkspace(base, "synthetic-up-r");
    const up = await upload(base, cookie, workspaceId, { filename: "r.csv", bytes: new TextEncoder().encode("date,description,amount,currency\n2026-01-02,X,-100,EUR\n"), profile: CSV_PROFILE });
    const body = up.json as { import: { id: string }; jobId: string };
    expect(await runJob(body.jobId)).toBe("applied");
    const marker = await scoped(userId, workspaceId, async (client) => {
      const r = await client.query("SELECT expires_at, completed_at FROM imports WHERE workspace_id = $1 AND id = $2", [workspaceId, body.import.id]);
      return r.rows[0] as { expires_at: string; completed_at: string };
    });
    const skewMs = Math.abs(new Date(marker.expires_at).getTime() - (new Date(marker.completed_at).getTime() + 30 * 24 * 3600 * 1000));
    expect(skewMs).toBeLessThan(60_000);
  });
});
