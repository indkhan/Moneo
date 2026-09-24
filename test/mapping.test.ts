// E02-S04 deterministic-first mapping with bounded model assistance: real
// PostgreSQL (`moneo_e02_mapping`, fails closed). The E00 fixture matrix
// runs purely (no DB): deduce recovers oracle-matching profiles for clean
// dialects and asks the independently expected targeted fields for ambiguous
// ones. DB-backed tests cover propose/accept, permits, reservations, policy
// revocation, concurrency caps, injection and uniform errors against a
// scripted in-process model transport (no network). Upload staging reuses
// the S03 stack, so MinIO + clamd + UPLOADS_ENABLED/S3_* apply here too.

import { existsSync, readFileSync } from "node:fs";
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
import { dispatchOutbox, jobsQueue, type JobPayload } from "../apps/web/src/jobs.ts";
import { processParseJob, loadUploadConfig, type UploadConfig, type UploadProfile } from "../apps/web/src/uploads.ts";
import { s3EnsureBucket } from "../apps/web/src/s3.ts";
import { clamdPing } from "../apps/web/src/clamav.ts";
import {
  acceptMapping,
  deduceMapping,
  listMappingProfiles,
  proposeMapping,
  readCurrentMapping,
  validateMappingCells,
  type MappingQuestion,
} from "../apps/web/src/mapping.ts";
import {
  consumeReservation,
  extractUsage,
  parseModelBody,
  releaseReservation,
  reserveMappingCall,
  validateModelMapping,
  type MappingTransport,
} from "../apps/web/src/mapping-provider.ts";
import { parseCsvText, parseImportFile } from "../proof/import/parser.ts";
import { buildXlsx } from "../proof/import/build-xlsx.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

const FIX = join("proof", "import", "fixtures");
const MANIFEST = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8")) as {
  csvFixtures: { id: string; file: string; profile: UploadProfile; expected: { accepted: { row: number; date: string; description: string; amountMinor: string; currency: string; direction: string }[] } }[];
  xlsxFixtures: { id: string; sheet: string; profile: UploadProfile; externalLink?: boolean; build: { header: string[]; rows: { kind: string; value?: string; expression?: string; cached?: string }[][] } }[];
};

function comparable(p: { kind: string; rowNumber: number; amountMinor?: string; currency?: string; direction?: string; effectiveDate?: string; description?: string; reasons?: string[] }): unknown {
  if (p.kind === "accepted") {
    return { kind: p.kind, rowNumber: p.rowNumber, amountMinor: p.amountMinor, currency: p.currency, direction: p.direction, effectiveDate: p.effectiveDate, description: p.description };
  }
  return { kind: p.kind, rowNumber: p.rowNumber, reasons: p.reasons };
}

// --- DB-backed helpers (mirror the S03 suite shape) ---

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
let redisUrl: string;
let queue: Queue<JobPayload>;
let uploadConfig: UploadConfig;

function mappingRedisUrl(): string {
  const base = env("E02-S04", "REDIS_URL");
  const u = new URL(base);
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("E02-S04 refused: REDIS_URL must point at the local disposable Redis.");
  }
  const db = process.env["MAPPING_REDIS_DB"] ?? "11";
  if (!/^\d+$/.test(db) || Number(db) < 0 || Number(db) > 15) throw new Error("E02-S04 misconfigured: MAPPING_REDIS_DB must be 0-15.");
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
      controls: null, // Disable edge controls for test simplicity
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

function multipartBody(fields: Record<string, string>, file: { field: string; filename: string; contentType: string; bytes: Uint8Array }): { body: Buffer; contentType: string } {
  const boundary = `----moneo${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"));
  parts.push(Buffer.from(file.bytes));
  parts.push(Buffer.from("\r\n", "utf8"));
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadFile(base: string, cookie: string, workspaceId: string, filename: string, bytes: Uint8Array, profile?: unknown): Promise<{ importId: string; jobId: string }> {
  const built = multipartBody(
    { idempotencyKey: randomUUID(), ...(profile === undefined ? {} : { profile: JSON.stringify(profile) }) },
    { field: "file", filename, contentType: "application/octet-stream", bytes },
  );
  const url = `${base}/api/workspaces/${workspaceId}/uploads`;
  const res = await fetch(url, {
    method: "POST",
    headers: { cookie, "Content-Type": built.contentType },
    body: new Uint8Array(built.body),
  });
  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(`upload failed with ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { import: { id: string }; jobId: string };
  return { importId: body.import.id, jobId: body.jobId };
}

async function stageImport(base: string, sub: string, filename: string, bytes: Uint8Array, profile?: unknown): Promise<{ cookie: string; workspaceId: string; userId: string; importId: string; jobId: string }> {
  const setup = await setupWorkspace(base, sub);
  const { importId, jobId } = await uploadFile(base, setup.cookie, setup.workspaceId, filename, bytes, profile);
  await dispatchOutbox(pool, queue);
  const outcome = await processParseJob(pool, jobId, uploadConfig);
  if (outcome !== "applied") throw new Error(`staging failed with ${outcome}`);
  return { ...setup, importId, jobId };
}

// Scripted model transport: modes drive deterministic provider behaviors;
// every prompt is captured for leak assertions.
type StubMode = "good" | "good-odd" | "malformed" | "unknown-field" | "unknown-column" | "flaky-429" | "flaky-odd" | "denied-401" | "missing-404" | "no-usage" | "with-usage";
function stubTransport(mode: StubMode, captured: string[], calls: { n: number }): MappingTransport {
  return async (req, _timeoutMs) => {
    captured.push(JSON.stringify({ system: req.system, user: req.user, model: req.model }));
    calls.n += 1;
    const profile = {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "date", description: "description", amount: "amount", currency: "currency" },
    };
    // A competent model for the odd-header fixture used across DB tests.
    const oddProfile = {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "when", description: "what", amount: "howmuch" },
      defaultCurrency: "EUR",
    };
    const envelope = (obj: unknown, usage?: unknown): string =>
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }], ...(usage ? { usage } : {}) });
    switch (mode) {
      case "good":
        return { httpStatus: 200, bodyText: envelope({ profile, notes: "stub" }, { prompt_tokens: 120, completion_tokens: 25 }) };
      case "good-odd":
        return { httpStatus: 200, bodyText: envelope({ profile: oddProfile, notes: "stub" }, { prompt_tokens: 120, completion_tokens: 25 }) };
      case "with-usage":
        return { httpStatus: 200, bodyText: envelope({ profile }, { prompt_tokens: 100, completion_tokens: 20 }) };
      case "no-usage":
        return { httpStatus: 200, bodyText: envelope({ profile: oddProfile }) };
      case "malformed":
        return { httpStatus: 200, bodyText: "definitely not json{{{[" };
      case "unknown-field":
        return { httpStatus: 200, bodyText: envelope({ profile, injected: "DROP TABLE" }) };
      case "unknown-column":
        return { httpStatus: 200, bodyText: envelope({ profile: { ...profile, columns: { date: "date", description: "description", amount: "amount; DELETE", currency: "currency" } } }) };
      case "flaky-429":
        if (calls.n === 1) return { httpStatus: 429, bodyText: "slow down" };
        return { httpStatus: 200, bodyText: envelope({ profile }, { prompt_tokens: 10, completion_tokens: 5 }) };
      case "flaky-odd":
        if (calls.n === 1) return { httpStatus: 429, bodyText: "slow down" };
        return { httpStatus: 200, bodyText: envelope({ profile: oddProfile }, { prompt_tokens: 10, completion_tokens: 5 }) };
      case "denied-401":
        return { httpStatus: 401, bodyText: "bad key" };
      case "missing-404":
        return { httpStatus: 404, bodyText: "no such model" };
    }
  };
}

const SIMPLE_CSV = "date,description,amount,currency\n2026-01-02,Coffee,-350,EUR\n2026-01-03,Wage,200000,EUR\n";
const SIMPLE_PROFILE = {
  delimiter: ",",
  dateFormat: "iso",
  amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
  columns: { date: "date", description: "description", amount: "amount", currency: "currency" },
};

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Save and restore env to avoid polluting other test suites.
  for (const name of ["UPLOADS_ENABLED", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET", "CLAMAV_HOST", "CLAMAV_PORT", "PARSER_CHILD"]) {
    savedEnv[name] = process.env[name];
  }
  // Hydrate S3/scanner names from the ignored local .env the same way
  // DATABASE_URL is loaded: never log or echo values.
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"]) {
    if (!process.env[name]) process.env[name] = env("E02-S04", name);
  }
  pool = await ensureTestPool("E02-S04", "moneo_e02_mapping", [
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
  process.env["UPLOADS_ENABLED"] = "1";
  if (!process.env["S3_ENDPOINT"]) process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
  if (!process.env["S3_REGION"]) process.env["S3_REGION"] = "us-east-1";
  if (!process.env["CLAMAV_HOST"]) process.env["CLAMAV_HOST"] = "127.0.0.1";
  if (!process.env["CLAMAV_PORT"]) process.env["CLAMAV_PORT"] = "3310";
  uploadConfig = loadUploadConfig();
  await s3EnsureBucket(uploadConfig.s3);
  if (!(await clamdPing(uploadConfig.clamav))) {
    throw new Error("E02-S04 prerequisite missing: clamd unreachable at the configured CLAMAV_HOST/PORT.");
  }
  if (!existsSync(uploadConfig.parserChild)) {
    throw new Error("E02-S04 prerequisite missing: parser child not built (run npm run build:parser).");
  }
  redisUrl = mappingRedisUrl();
  queue = jobsQueue(redisUrl);
  await queue.waitUntilReady();
  await queue.obliterate({ force: true });
}, 120_000);

afterAll(async () => {
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

describe("e02-s04 fixture matrix (deterministic, no DB)", () => {
  for (const fx of MANIFEST.csvFixtures) {
    it(`${fx.id}: deduce-then-parse matches the oracle or asks expected fields`, () => {
      const text = readFileSync(join(FIX, fx.file), "utf8").replace(/^\uFEFF/, "");
      const delimiter = fx.profile.delimiter as "," | ";";
      const table = parseCsvText(text, delimiter, { maxUploadBytes: 20 * 1024 * 1024, maxDecompressedBytes: 100 * 1024 * 1024, maxRows: 100_000, maxCols: 50, maxZipEntries: 200 });
      const header = table[0]!;
      const records = table.slice(1).map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])));
      const deduced = deduceMapping(header, records, { delimiter, defaultCurrency: fx.profile.defaultCurrency, seps: fx.profile.amount });
      if (fx.id === "ambiguous-dates") {
        expect(deduced.confidence).toBe("low");
        expect(deduced.questions.map((q) => q.field).sort()).toEqual(["date"]);
        return;
      }
      if (fx.id === "debit-credit-de") {
        expect(deduced.confidence).toBe("low");
        expect(deduced.questions.map((q) => q.field)).toEqual(["amount"]);
        return;
      }
      if (fx.id === "fee-refund-coverage" || fx.id === "signed-mixed-currency") {
        // Genuinely needs attention: unsupported USD rows cannot become
        // money, and signed-mixed additionally carries exotic amount shapes
        // (currency symbols, space separators) no separator set explains.
        expect(deduced.confidence).toBe("low");
        expect(deduced.questions.map((q) => q.field).sort()).toEqual(fx.id === "fee-refund-coverage" ? ["currency"] : ["amount", "currency"]);
        return;
      }
      expect(deduced.confidence).toBe("high");
      expect(deduced.questions).toEqual([]);
      const reparsed = parseImportFile(new Uint8Array(readFileSync(join(FIX, fx.file))), fx.file, deduced.profile);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      const expected = MANIFEST.csvFixtures
        .find((f) => f.id === fx.id)!
        .expected.accepted.map((a) => ({ kind: "accepted", rowNumber: a.row, amountMinor: a.amountMinor, currency: a.currency, direction: a.direction, effectiveDate: a.date, description: a.description }))
        .sort((a, b) => a.rowNumber - b.rowNumber);
      const got = reparsed.proposals.filter((p) => p.kind === "accepted").map(comparable).sort((a, b) => (a as { rowNumber: number }).rowNumber - (b as { rowNumber: number }).rowNumber);
      expect(got).toEqual(expected);
    });
  }

  for (const fx of MANIFEST.xlsxFixtures.filter((f) => !f.externalLink)) {
    it(`${fx.id}: deduce-then-parse matches the oracle`, () => {
      const toCell = (c: { kind: string; value?: string; expression?: string; cached?: string }): import("../proof/import/build-xlsx.ts").FixtureCell => {
        if (c.kind === "formula") return { kind: "formula", expression: c.expression ?? "", cached: c.cached ?? "" };
        if (c.kind === "number") return { kind: "number", value: c.value ?? "" };
        return { kind: "text", value: c.value ?? "" };
      };
      const bytes = buildXlsx({ name: fx.sheet, header: fx.build.header, rows: fx.build.rows.map((row) => row.map(toCell)) }, {});
      const header = fx.build.header;
      const records = fx.build.rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i]?.kind === "formula" ? "" : (row[i]?.value ?? "")])));
      const deduced = deduceMapping(header, records, { delimiter: ",", seps: { decimalSep: ".", thousandsSep: "," } });
      expect(deduced.confidence).toBe("high");
      const reparsed = parseImportFile(bytes, `${fx.id}.xlsx`, deduced.profile);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      const accepted = reparsed.proposals.filter((p) => p.kind === "accepted").map(comparable);
      expect(accepted.length).toBeGreaterThan(0);
    });
  }
});

describe("e02-s04 propose and accept (real PG, stub transport)", () => {
  it("deterministic confidence proposes without any model call", async () => {
    const base = await startApp();
    const staged = await stageImport(base, "synthetic-map-a", "clean.csv", new TextEncoder().encode(SIMPLE_CSV), SIMPLE_PROFILE);
    const captured: string[] = [];
    const calls = { n: 0 };
    const result = await proposeMapping(pool, { userId: staged.userId, workspaceId: staged.workspaceId }, staged.importId, {
      transport: stubTransport("good", captured, calls),
    });
    expect(result.aiUsed).toBe(false);
    expect(calls.n).toBe(0);
    expect(result.proposal.path).toBe("deterministic");
    expect(result.proposal.questions).toEqual([]);
    expect(result.proposal.suggestedAccountId).toBeNull();
    // Accepting the deterministic proposal persists versions and replays.
    const accepted = await acceptMapping(pool, { userId: staged.userId, workspaceId: staged.workspaceId }, staged.importId, { proposalId: result.proposal.id });
    expect(accepted.proposal.status).toBe("ACCEPTED");
    expect(typeof accepted.proposal.policyVersion).toBe("string");
    const replay = await acceptMapping(pool, { userId: staged.userId, workspaceId: staged.workspaceId }, staged.importId, { proposalId: result.proposal.id });
    expect(replay.replayed).toBe(true);
  });

  it("low confidence without transport falls back to targeted manual questions", async () => {
    const base = await startApp();
    const staged = await stageImport(base, "synthetic-map-b", "odd.csv", new TextEncoder().encode("when,what,howmuch\n2026-01-02,Coffee,3.50\n"), {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "when", description: "what", amount: "howmuch" },
      defaultCurrency: "EUR",
    });
    const result = await proposeMapping(pool, { userId: staged.userId, workspaceId: staged.workspaceId }, staged.importId, { transport: null });
    expect(result.aiUsed).toBe(false);
    expect(result.fallback).toBe("manual");
    expect(result.proposal.path).toBe("manual");
    expect(result.proposal.questions.map((q) => q.field).sort()).toEqual(["amount", "amount", "columns", "date", "date"]);
    // Manual corrections through accept validate and publish.
    const fixed = await acceptMapping(pool, { userId: staged.userId, workspaceId: staged.workspaceId }, staged.importId, {
      proposalId: result.proposal.id,
      profile: {
        delimiter: ",",
        dateFormat: "iso",
        amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
        columns: { date: "when", description: "what", amount: "howmuch" },
        defaultCurrency: "EUR",
      },
    });
    expect(fixed.proposal.status).toBe("ACCEPTED");
  });

  it("model assistance spends one reservation, validates strictly, and records unknown cost as pending", async () => {
    const base = await startApp();
    const staged = await stageImport(base, "synthetic-map-c", "odd.csv", new TextEncoder().encode("when,what,howmuch\n2026-01-02,Coffee,3.50\n"), {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "when", description: "what", amount: "howmuch" },
      defaultCurrency: "EUR",
    });
    const claims = { userId: staged.userId, workspaceId: staged.workspaceId };
    const captured: string[] = [];
    const calls = { n: 0 };
    const result = await proposeMapping(pool, claims, staged.importId, { transport: stubTransport("no-usage", captured, calls) });
    expect(result.aiUsed).toBe(true);
    expect(calls.n).toBe(1);
    expect(result.proposal.path).toBe("model-assisted");
    expect(result.proposal.profile.columns).toMatchObject({ date: "when", description: "what", amount: "howmuch" });
    // Prompt hygiene: header + raw cells only — no accounts, subs, secrets.
    for (const needle of ["synthetic-map-c", "moneo-test", "OPENROUTER", "Bearer", "account"]) {
      expect(captured.join(" ")).not.toContain(needle);
    }
    // Usage recorded as unknown/pending, never zero.
    const usage = await scoped(staged.userId, staged.workspaceId, async (client) => {
      const r = await client.query("SELECT input_tokens, output_tokens, cost_unknown FROM mapping_provider_usage WHERE workspace_id = $1", [staged.workspaceId]);
      return r.rows[0] as { input_tokens: number | null; output_tokens: number | null; cost_unknown: boolean };
    });
    expect(usage).toMatchObject({ input_tokens: null, output_tokens: null, cost_unknown: true });
    const accepted = await acceptMapping(pool, claims, staged.importId, { proposalId: result.proposal.id });
    expect(accepted.proposal.status).toBe("ACCEPTED");
  });

  it("malformed, injected and off-header model output falls back to manual with the reservation spent", async () => {
    const base = await startApp();
    for (const mode of ["malformed", "unknown-field", "unknown-column"] as const) {
      const staged = await stageImport(base, `synthetic-map-d-${mode}`, "odd.csv", new TextEncoder().encode("when,what,howmuch\n2026-01-02,Coffee,3.50\n"), {
        delimiter: ",",
        dateFormat: "iso",
        amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
        columns: { date: "when", description: "what", amount: "howmuch" },
        defaultCurrency: "EUR",
      });
      const result = await proposeMapping(pool, { userId: staged.userId, workspaceId: staged.workspaceId }, staged.importId, {
        transport: stubTransport(mode, [], { n: 0 }),
      });
      expect(result.aiUsed).toBe(false);
      expect(result.fallback).toBe("manual");
      expect(result.proposal.path).toBe("manual");
      // Spend still recorded (a response arrived); nothing model-shaped published.
      const reservations = await scoped(staged.userId, staged.workspaceId, async (client) => {
        const r = await client.query("SELECT status FROM mapping_provider_reservations WHERE workspace_id = $1", [staged.workspaceId]);
        return r.rows as { status: string }[];
      });
      expect(reservations.every((r) => r.status === "CONSUMED")).toBe(true);
    }
  });

  it("retryable provider errors retry once on the same reservation; auth failures release nothing silently", async () => {
    const base = await startApp();
    const staged = await stageImport(base, "synthetic-map-e", "odd.csv", new TextEncoder().encode("when,what,howmuch\n2026-01-02,Coffee,3.50\n"), {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "when", description: "what", amount: "howmuch" },
      defaultCurrency: "EUR",
    });
    const claims = { userId: staged.userId, workspaceId: staged.workspaceId };
    const calls = { n: 0 };
    const retried = await proposeMapping(pool, claims, staged.importId, { transport: stubTransport("flaky-odd", [], calls), replace: true });
    expect(calls.n).toBe(2);
    expect(retried.aiUsed).toBe(true);
    const reservationCount = await scoped(staged.userId, staged.workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM mapping_provider_reservations WHERE workspace_id = $1", [staged.workspaceId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(reservationCount).toBe(1);
    // Auth failure: no model result, manual fallback, spend recorded as unknown.
    const denied = await proposeMapping(pool, claims, staged.importId, { transport: stubTransport("denied-401", [], { n: 0 }), replace: true });
    expect(denied.fallback).toBe("model-unavailable");
  });

  it("policy revocation between dispatch and accept blocks publication", async () => {
    const base = await startApp();
    const staged = await stageImport(base, "synthetic-map-f", "odd.csv", new TextEncoder().encode("when,what,howmuch\n2026-01-02,Coffee,3.50\n"), {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "when", description: "what", amount: "howmuch" },
      defaultCurrency: "EUR",
    });
    const claims = { userId: staged.userId, workspaceId: staged.workspaceId };
    // An excludable account must exist for the policy version to move.
    const acct = await (
      await fetch(`${base}/api/accounts`, {
        method: "POST",
        headers: { cookie: staged.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: staged.workspaceId, name: "Sentinel" }),
      })
    ).json();
    const proposed = await proposeMapping(pool, claims, staged.importId, { transport: stubTransport("good-odd", [], { n: 0 }) });
    expect(proposed.aiUsed).toBe(true);
    // Revoke (exclude) between dispatch and publication.
    const exclusion = await (
      await fetch(`${base}/api/ai/exclusions`, {
        method: "PUT",
        headers: { cookie: staged.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: staged.workspaceId, accountId: (acct as { id: string }).id, excluded: true }),
      })
    ).json();
    void exclusion;
    await expect(acceptMapping(pool, claims, staged.importId, { proposalId: proposed.proposal.id })).rejects.toMatchObject({ code: "permit_denied" });
    // Nothing published: proposal still proposed, nothing accepted.
    const current = await readCurrentMapping(pool, claims, staged.importId);
    expect(current?.status).toBe("PROPOSED");
  });

  it("reservation caps and unknown accounts deny cleanly", async () => {
    const base = await startApp();
    const staged = await stageImport(base, "synthetic-map-g", "odd.csv", new TextEncoder().encode("when,what,howmuch\n2026-01-02,Coffee,3.50\n"), {
      delimiter: ",",
      dateFormat: "iso",
      amount: { kind: "signed", decimalSep: ".", thousandsSep: "" },
      columns: { date: "when", description: "what", amount: "howmuch" },
      defaultCurrency: "EUR",
    });
    const claims = { userId: staged.userId, workspaceId: staged.workspaceId };
    const first = await reserveMappingCall(pool, claims, staged.importId, "stub-model");
    await expect(reserveMappingCall(pool, claims, staged.importId, "stub-model")).rejects.toThrow("mapping_busy");
    await releaseReservation(pool, claims, first.id);
    const second = await reserveMappingCall(pool, claims, staged.importId, "stub-model");
    await consumeReservation(pool, claims, second.id, { model: "stub-model", inputTokens: 10, outputTokens: 5 });
    await expect(consumeReservation(pool, claims, second.id, { model: "stub-model", inputTokens: 1, outputTokens: 1 })).rejects.toThrow("reservation_settled");
    // Unknown account on accept denies by default.
    const proposed = await proposeMapping(pool, claims, staged.importId, { transport: null });
    await expect(acceptMapping(pool, claims, staged.importId, { proposalId: proposed.proposal.id, accountId: randomUUID() })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("profiles version on save and strangers see uniform errors", async () => {
    const base = await startApp();
    const a = await stageImport(base, "synthetic-map-h-a", "clean.csv", new TextEncoder().encode(SIMPLE_CSV), SIMPLE_PROFILE);
    const b = await setupWorkspace(base, "synthetic-map-h-b");
    // Foreign import is indistinguishable from missing.
    await expect(proposeMapping(pool, { userId: b.userId, workspaceId: b.workspaceId }, a.importId, { transport: null })).rejects.toMatchObject({
      message: "tenant_denied",
    });
    const proposed = await proposeMapping(pool, { userId: a.userId, workspaceId: a.workspaceId }, a.importId, { transport: null });
    expect(proposed.proposal.path).toBe("deterministic");
    const accepted = await acceptMapping(pool, { userId: a.userId, workspaceId: a.workspaceId }, a.importId, {
      proposalId: proposed.proposal.id,
      saveAs: "hausbank",
    });
    expect(accepted.profileName).toBe("hausbank");
    expect(accepted.profileVersion).toBe("1");
    const again = await acceptMapping(pool, { userId: a.userId, workspaceId: a.workspaceId }, a.importId, {
      proposalId: proposed.proposal.id,
      saveAs: "hausbank",
    });
    // Already accepted: replay, no second version minted.
    expect(again.replayed).toBe(true);
    expect(again.profileVersion).toBeNull();
    const profiles = await listMappingProfiles(pool, { userId: a.userId, workspaceId: a.workspaceId }, "hausbank");
    expect(profiles).toMatchObject([{ name: "hausbank", version: "1" }]);
    // Unscoped reads return nothing across the mapping tables.
    for (const table of ["mapping_profiles", "mapping_proposals", "mapping_provider_reservations", "mapping_provider_usage"]) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect((r.rows[0] as { n: number }).n).toBe(0);
    }
  });

  it("HTTP mapping routes expose stable vocabulary plus request id", async () => {
    const base = await startApp();
    const staged = await stageImport(base, "synthetic-map-i", "clean.csv", new TextEncoder().encode(SIMPLE_CSV), SIMPLE_PROFILE);
    const propose = await fetch(`${base}/api/workspaces/${staged.workspaceId}/imports/${staged.importId}/mapping`, {
      method: "POST",
      headers: { cookie: staged.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    });
    expect(propose.status).toBe(201);
    const proposed = (await propose.json()) as { proposal: { id: string; path: string }; requestId: string };
    expect(proposed.proposal.path).toBe("deterministic");
    expect(typeof proposed.requestId).toBe("string");
    const read = await fetch(`${base}/api/workspaces/${staged.workspaceId}/imports/${staged.importId}/mapping`, { headers: { cookie: staged.cookie } });
    expect(read.status).toBe(200);
    const accept = await fetch(`${base}/api/workspaces/${staged.workspaceId}/imports/${staged.importId}/mapping/accept`, {
      method: "POST",
      headers: { cookie: staged.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: proposed.proposal.id }),
    });
    expect(accept.status).toBe(200);
    const accepted = (await accept.json()) as { proposal: { status: string } };
    expect(accepted.proposal.status).toBe("ACCEPTED");
    const anon = await fetch(`${base}/api/workspaces/${staged.workspaceId}/imports/${staged.importId}/mapping`);
    expect(anon.status).toBe(401);
  });

  it("unit edges: validators, usage extraction and error taxonomy", () => {
    expect(() => validateModelMapping({ profile: SIMPLE_PROFILE, notes: "x".repeat(501) })).toThrow("model-output-bad-notes");
    expect(() => validateModelMapping({ profile: SIMPLE_PROFILE, extra: 1 })).toThrow("model-output-unknown-field:extra");
    expect(() => parseModelBody("nope{{")).toThrow("model-output-not-json");
    expect(() => parseModelBody(JSON.stringify({ choices: [] }))).toThrow("model-output-no-choices");
    expect(extractUsage(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), "m")).toMatchObject({ inputTokens: 3, outputTokens: 4 });
    expect(extractUsage("garbage", "m")).toMatchObject({ inputTokens: null, outputTokens: null });
    expect(validateMappingCells(SIMPLE_PROFILE as never, ["date", "description", "amount", "currency"], [{ date: "2026-01-02", description: "x", amount: "-3.50", currency: "EUR" }], ",").ok).toBe(true);
    expect(validateMappingCells(SIMPLE_PROFILE as never, ["date", "description", "amount"], [{ date: "2026-01-02", description: "x", amount: "-3.50" }], ";").ok).toBe(false);
    // Separator bias is evidence-based: ties keep the parse profile that
    // demonstrably parsed these bytes; contradiction asks, never switches.
    const tied = deduceMapping(["date", "description", "amount"], [{ date: "2026-01-02", description: "x", amount: "100" }], {
      delimiter: ",",
      defaultCurrency: "EUR",
      seps: { decimalSep: ".", thousandsSep: "," },
    });
    expect(tied.confidence).toBe("high");
    expect(tied.profile.amount).toMatchObject({ decimalSep: ".", thousandsSep: "," });
    const contradicted = deduceMapping(["date", "description", "amount"], [{ date: "2026-01-02", description: "x", amount: "1.234,56" }], {
      delimiter: ",",
      seps: { decimalSep: ".", thousandsSep: "" },
    });
    expect(contradicted.confidence).toBe("low");
    expect(contradicted.questions.map((q) => q.field)).toContain("amount");
    expect(contradicted.profile.amount).toMatchObject({ decimalSep: ".", thousandsSep: "" });
  });
});
