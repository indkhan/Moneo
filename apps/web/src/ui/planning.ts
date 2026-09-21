// E06-S04 server-rendered planning UI (zero client JS): projection settings
// and assumptions, goals with virtual allocations, daily case projections
// with Available to Spend, and flat what-if scenarios with comparison.
// All reads go through the shared S01/S02/S03/S04 domain modules (the same
// queries the API, chat tools and artifact SDK consume); forms POST with
// per-render idempotency keys and re-render conflicts with fresh retry.

import { randomUUID } from "node:crypto";
import { isUuid } from "../ids.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { formatMinor } from "../money.ts";
import { TxError } from "../commands/transactions.ts";
import {
  archiveAssumption,
  readAssumptions,
  readProjectionSettings,
  setAssumption,
  updateProjectionSettings,
} from "../commands/projection-inputs.ts";
import {
  allocate,
  archiveGoal,
  createGoal,
  getGoal,
  listGoals,
  release,
  updateGoal,
} from "../commands/goals.ts";
import { evaluateProjection } from "../projections/engine.ts";
import {
  addOverride,
  archiveScenario,
  compareScenarios,
  createScenario,
  getScenario,
  listScenarios,
  removeOverride,
} from "../projections/scenarios.ts";
import { listWorkspaces, sessionClaims, TenantDenied, TenantInvalid, type SessionResolver } from "../tenancy.ts";
import { readLimitedBody } from "../http-controls.ts";
import { errorPage, escapeHtml, page } from "./shell.ts";

export type PlanningUiConfig = { appBaseUrl: string };

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return readLimitedBody(req, 64 * 1024).then((body) => {
    try {
      return new URLSearchParams(body.toString("utf8"));
    } catch {
      throw new Error("body_invalid");
    }
  });
}

function sameOrigin(req: IncomingMessage, appBaseUrl: string): boolean {
  const allowed = new URL(appBaseUrl).origin;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (typeof origin === "string") return origin === allowed;
  if (typeof referer === "string") return referer === allowed || referer.startsWith(`${allowed}/`);
  return false;
}

function money(minor: string, currency: string): string {
  try {
    return `${formatMinor(BigInt(minor), currency)} ${escapeHtml(currency)}`;
  } catch {
    return `${escapeHtml(minor)} ${escapeHtml(currency)}`;
  }
}

function nav(workspaceId: string): string {
  const w = escapeHtml(workspaceId);
  return `<nav aria-label="Planning"><ul><li><a href="/w/${w}/planning">Planning inputs</a></li><li><a href="/w/${w}/goals">Goals</a></li><li><a href="/w/${w}/projection">Projection</a></li><li><a href="/w/${w}/scenarios">Scenarios</a></li></ul></nav>`;
}

function noticeFor(query: URLSearchParams): string {
  const notice = query.get("notice");
  if (!notice) return "";
  const messages: Record<string, string> = {
    saved: "Settings saved.",
    assumed: "Assumption recorded (history preserved; superseded rows stay visible).",
    archived: "Archived.",
    goal: "Goal saved.",
    allocated: "Reservation updated without creating cash.",
    scenario: "Scenario saved.",
    override: "Scenario override saved (booked data unchanged).",
    removed: "Override removed.",
  };
  const text = messages[notice] ?? "Saved.";
  return `<div class="notice" role="status"><p>${escapeHtml(text)}</p></div>`;
}

function conflictShell(workspaceId: string, back: string, heading: string, currentVersion: string | undefined, retryHref: string): string {
  return page({
    title: heading,
    requestId: "uncontrolled",
    authed: true,
    content: `<div class="alert" role="alert"><h2>${escapeHtml(heading)}</h2><p>Changed before your update (now version ${escapeHtml(currentVersion ?? "unknown")}). Nothing was changed.</p><p><a href="${retryHref}">Reopen ${escapeHtml(back)} for fresh values and retry</a></p></div>`,
  });
}

export async function handlePlanningRoutes(
  pool: Pool,
  resolveSession: SessionResolver,
  config: PlanningUiConfig,
  event: (code: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  requestId = "uncontrolled",
): Promise<boolean> {
  // ---- GET /w/:id/planning ----
  const planningMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/planning$/);
  if (planningMatch && method === "GET") {
    const workspaceId = planningMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view planning inputs.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:planning");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const me = await resolveSession(req);
      const spaces = await listWorkspaces(pool, me!.keycloakSub);
      const baseCurrency = spaces.find((w) => w.id === workspaceId)?.baseCurrency ?? "EUR";
      const settings = await readProjectionSettings(pool, resolved.claim, workspaceId);
      const assumptions = await readAssumptions(pool, resolved.claim, workspaceId, "ALL");
      const assumptionRows =
        assumptions.length === 0
          ? `<p>No assumptions yet. Explicit assumptions drive the forecast; missing history never becomes silent zero.</p>`
          : `<div style="overflow-x:auto"><table><caption>Financial assumptions</caption><thead><tr><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Valid</th><th scope="col">Value</th><th scope="col">Version</th><th scope="col">Action</th></tr></thead><tbody>${assumptions
              .map(
                (a) =>
                  `<tr><td>${escapeHtml(a.assumptionType)}</td><td>${escapeHtml(a.status)}</td><td>${escapeHtml(a.validFrom)} to ${escapeHtml(a.validTo ?? "open")}</td><td>${escapeHtml(JSON.stringify(a.value))}</td><td>${escapeHtml(a.version)}</td><td>${a.status === "ACTIVE" ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/planning/assumptions/archive"><input type="hidden" name="assumptionId" value="${escapeHtml(a.id)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(a.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">Archive</button></form>` : `<span>Kept for history</span>`}</td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      html(
        res,
        200,
        page({
          title: "Planning inputs",
          requestId,
          authed: true,
          content: `<a href="#main">Skip to content</a><h2>Planning inputs</h2>${nav(workspaceId)}${noticeFor(query)}<h3>Projection settings</h3><form method="post" action="/w/${escapeHtml(workspaceId)}/planning/settings"><input type="hidden" name="expectedVersion" value="${escapeHtml(settings.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Horizon days (1–730) <input name="horizonDays" inputmode="numeric" pattern="[0-9]*" required value="${escapeHtml(String(settings.horizonDays))}"></label> <label>Baseline weeks (1–52) <input name="baselineWeeks" inputmode="numeric" pattern="[0-9]*" required value="${escapeHtml(String(settings.baselineWeeks))}"></label> <label>Safety floor (${escapeHtml(baseCurrency)}, major units) <input name="safetyFloor" inputmode="decimal" required value="0.00"></label> <label><input type="checkbox" name="savingsIncluded" value="true"${settings.savingsIncluded ? " checked" : ""}> Include savings accounts as spendable</label> <button type="submit">Save settings</button></form><h3>Financial assumptions</h3>${assumptionRows}<h3>Add assumption</h3><form method="post" action="/w/${escapeHtml(workspaceId)}/planning/assumptions/add"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Kind <select name="kind"><option value="income">Monthly income</option><option value="variable">Weekly variable spend</option><option value="onetime">One-time expense</option></select></label> <label>Amount (major units) <input name="amount" inputmode="decimal" required></label> <label>Currency <input name="currency" maxlength="3" required value="${escapeHtml(baseCurrency)}"></label> <label>Day of month or date <input name="dayOrDate" required value="1"></label> <button type="submit">Add assumption</button></form>`,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/planning/settings ----
  const settingsMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/planning\/settings$/);
  if (settingsMatch && method === "POST") {
    const workspaceId = settingsMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/planning`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      const me = await resolveSession(req);
      const spaces = await listWorkspaces(pool, me!.keycloakSub);
      const baseCurrency = spaces.find((w) => w.id === workspaceId)?.baseCurrency ?? "EUR";
      const floorMajor = form?.get("safetyFloor") ?? "0";
      const { parseMinor } = await import("../money.ts");
      await updateProjectionSettings(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        expectedVersion: form?.get("expectedVersion") ?? "",
        horizonDays: Number(form?.get("horizonDays") ?? ""),
        baselineWeeks: Number(form?.get("baselineWeeks") ?? ""),
        safetyFloorMinor: parseMinor(floorMajor, baseCurrency).toString(),
        savingsIncluded: form?.get("savingsIncluded") === "true",
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:planning-settings");
      res.writeHead(303, { Location: `/w/${workspaceId}/planning?notice=saved` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event("ui_command_conflict:planning-settings");
        html(res, 409, conflictShell(workspaceId, "planning inputs", "Settings conflict", err.currentVersion, `/w/${workspaceId}/planning`));
        return true;
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:planning-settings");
        html(res, 400, errorPage({ status: 400, heading: "Save failed", message: "Check horizon 1–730, baseline weeks 1–52 and a decimal floor amount.", back: `/w/${workspaceId}/planning`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/planning/assumptions/add ----
  const assumeAddMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/planning\/assumptions\/add$/);
  if (assumeAddMatch && method === "POST") {
    const workspaceId = assumeAddMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/planning`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      const me = await resolveSession(req);
      const spaces = await listWorkspaces(pool, me!.keycloakSub);
      const baseCurrency = spaces.find((w) => w.id === workspaceId)?.baseCurrency ?? "EUR";
      const { parseMinor } = await import("../money.ts");
      const kind = form?.get("kind") ?? "";
      const amount = parseMinor(form?.get("amount") ?? "", form?.get("currency") || baseCurrency).toString();
      const currency = form?.get("currency") || baseCurrency;
      const dayOrDate = form?.get("dayOrDate") ?? "";
      let raw: Record<string, unknown>;
      if (kind === "income") {
        raw = { workspaceId, assumptionType: "EXPECTED_INCOME", validFrom: "2026-01-01", value: { amountMinor: amount, currency, cadence: "MONTHLY", dayOfMonth: Number(dayOrDate) }, idempotencyKey: form?.get("idempotencyKey") ?? "" };
      } else if (kind === "variable") {
        raw = { workspaceId, assumptionType: "EXPECTED_VARIABLE_SPEND", validFrom: "2026-01-01", value: { amountMinor: amount, currency }, idempotencyKey: form?.get("idempotencyKey") ?? "" };
      } else {
        raw = { workspaceId, assumptionType: "ONE_TIME_EXPECTED_EXPENSE", validFrom: "2026-01-01", value: { amountMinor: amount, currency, direction: "OUTFLOW", date: dayOrDate }, idempotencyKey: form?.get("idempotencyKey") ?? "" };
      }
      await setAssumption(pool, resolved.claim, resolved.claim.userId, raw);
      event("ui_command_ok:planning-assumption");
      res.writeHead(303, { Location: `/w/${workspaceId}/planning?notice=assumed` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event("ui_command_conflict:planning-assumption");
        html(res, 409, conflictShell(workspaceId, "planning inputs", "Assumption conflict", err.currentVersion, `/w/${workspaceId}/planning`));
        return true;
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:planning-assumption");
        html(res, 400, errorPage({ status: 400, heading: "Add failed", message: "Check the amount, currency and day/date, then retry.", back: `/w/${workspaceId}/planning`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/planning/assumptions/archive ----
  const assumeArchiveMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/planning\/assumptions\/archive$/);
  if (assumeArchiveMatch && method === "POST") {
    const workspaceId = assumeArchiveMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/planning`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      await archiveAssumption(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        assumptionId: form?.get("assumptionId") ?? "",
        expectedVersion: form?.get("expectedVersion") ?? "",
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:planning-archive");
      res.writeHead(303, { Location: `/w/${workspaceId}/planning?notice=archived` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event("ui_command_conflict:planning-archive");
        html(res, 409, conflictShell(workspaceId, "planning inputs", "Archive conflict", err.currentVersion, `/w/${workspaceId}/planning`));
        return true;
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:planning-archive");
        html(res, 400, errorPage({ status: 400, heading: "Archive failed", message: "The assumption changed or is already archived.", back: `/w/${workspaceId}/planning`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- GET /w/:id/goals ----
  const goalsMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/goals$/);
  if (goalsMatch && method === "GET") {
    const workspaceId = goalsMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view goals.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:goals");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const goals = await listGoals(pool, resolved.claim);
      const rows =
        goals.length === 0
          ? `<p>No goals yet. Reservations are virtual earmarks: they never create cash.</p>`
          : `<div style="overflow-x:auto"><table><caption>Savings goals</caption><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Target</th><th scope="col">Reserved</th><th scope="col">Status</th><th scope="col">Allocate</th><th scope="col">Release</th><th scope="col">Archive</th></tr></thead><tbody>${goals
              .map(
                (g) =>
                  `<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.goalType)}</td><td>${g.targetAmountMinor && g.currency ? money(g.targetAmountMinor, g.currency) : "none"}</td><td>${g.currency || g.targetAmountMinor ? money(g.reservedMinor, (g.currency ?? "EUR") as string) : escapeHtml(g.reservedMinor)}</td><td>${escapeHtml(g.status)}</td><td><form method="post" action="/w/${escapeHtml(workspaceId)}/goals/allocate"><input type="hidden" name="goalId" value="${escapeHtml(g.id)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Account <input name="accountId" required></label> <label>Amount <input name="amount" inputmode="decimal" required></label> <label>Currency <input name="currency" maxlength="3" required value="${escapeHtml(g.currency ?? "EUR")}"></label> <button type="submit">Allocate</button></form></td><td><form method="post" action="/w/${escapeHtml(workspaceId)}/goals/release"><input type="hidden" name="goalId" value="${escapeHtml(g.id)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Account <input name="accountId" required></label> <label>Amount <input name="amount" inputmode="decimal" required></label> <button type="submit">Release</button></form></td><td>${g.status === "ACTIVE" ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/goals/archive"><input type="hidden" name="goalId" value="${escapeHtml(g.id)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(g.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">Archive</button></form>` : `<span>Archived</span>`}</td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      html(
        res,
        200,
        page({
          title: "Goals",
          requestId,
          authed: true,
          content: `<a href="#main">Skip to content</a><h2>Goals</h2>${nav(workspaceId)}${noticeFor(query)}${rows}<h3>New goal</h3><form method="post" action="/w/${escapeHtml(workspaceId)}/goals/create"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Name <input name="name" required maxlength="200"></label> <label>Type <select name="goalType"><option value="SAVINGS_TARGET">Savings target</option><option value="EMERGENCY_FUND">Emergency fund</option><option value="PURCHASE">Purchase</option><option value="TRAVEL">Travel</option><option value="DEBT_REDUCTION">Debt reduction</option><option value="CUSTOM">Custom</option></select></label> <label>Target (major units, optional) <input name="targetAmount"></label> <label>Currency <input name="currency" maxlength="3" value="EUR"></label> <label>Target date <input name="targetDate" placeholder="YYYY-MM-DD"></label> <button type="submit">Create goal</button></form>`,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/goals/create ----
  const goalCreateMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/goals\/create$/);
  if (goalCreateMatch && method === "POST") {
    const workspaceId = goalCreateMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/goals`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      const me = await resolveSession(req);
      const spaces = await listWorkspaces(pool, me!.keycloakSub);
      const baseCurrency = spaces.find((w) => w.id === workspaceId)?.baseCurrency ?? "EUR";
      const { parseMinor } = await import("../money.ts");
      const targetRaw = (form?.get("targetAmount") ?? "").trim();
      await createGoal(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        name: form?.get("name") ?? "",
        goalType: form?.get("goalType") ?? "",
        ...(targetRaw ? { targetAmountMinor: parseMinor(targetRaw, form?.get("currency") || baseCurrency).toString(), currency: form?.get("currency") || baseCurrency } : {}),
        ...((form?.get("targetDate") ?? "").trim() ? { targetDate: (form?.get("targetDate") ?? "").trim() } : {}),
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:goals-create");
      res.writeHead(303, { Location: `/w/${workspaceId}/goals?notice=goal` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:goals-create");
        html(res, 400, errorPage({ status: 400, heading: "Create failed", message: "Check the name, target amount and date, then retry.", back: `/w/${workspaceId}/goals`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/goals/archive ----
  const goalArchiveMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/goals\/archive$/);
  if (goalArchiveMatch && method === "POST") {
    const workspaceId = goalArchiveMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/goals`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      await archiveGoal(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        goalId: form?.get("goalId") ?? "",
        expectedVersion: form?.get("expectedVersion") ?? "",
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:goals-archive");
      res.writeHead(303, { Location: `/w/${workspaceId}/goals?notice=archived` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event("ui_command_conflict:goals-archive");
        html(res, 409, conflictShell(workspaceId, "goals", "Goal conflict", err.currentVersion, `/w/${workspaceId}/goals`));
        return true;
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:goals-archive");
        html(res, 400, errorPage({ status: 400, heading: "Archive failed", message: "The goal changed or is already archived.", back: `/w/${workspaceId}/goals`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/goals/allocate|release ----
  const allocMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/goals\/(allocate|release)$/);
  if (allocMatch && method === "POST") {
    const workspaceId = allocMatch[1];
    const action = allocMatch[2];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/goals`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      const { parseMinor } = await import("../money.ts");
      const currency = form?.get("currency") || "EUR";
      const amountMinor = parseMinor(form?.get("amount") ?? "", currency).toString();
      if (action === "allocate") {
        await allocate(pool, resolved.claim, resolved.claim.userId, {
          workspaceId,
          goalId: form?.get("goalId") ?? "",
          accountId: form?.get("accountId") ?? "",
          amountMinor,
          currency,
          idempotencyKey: form?.get("idempotencyKey") ?? "",
        });
      } else {
        await release(pool, resolved.claim, resolved.claim.userId, {
          workspaceId,
          goalId: form?.get("goalId") ?? "",
          accountId: form?.get("accountId") ?? "",
          amountMinor,
          idempotencyKey: form?.get("idempotencyKey") ?? "",
        });
      }
      event(`ui_command_ok:goals-${action}`);
      res.writeHead(303, { Location: `/w/${workspaceId}/goals?notice=allocated` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event(`ui_command_conflict:goals-${action}`);
        html(res, 409, conflictShell(workspaceId, "goals", "Reservation conflict", err.currentVersion, `/w/${workspaceId}/goals`));
        return true;
      }
      if (err instanceof TxError) {
        event(`ui_command_denied:goals-${action}`);
        const detail = err.code === "overallocation" ? "Not enough unreserved cash in that account." : err.code === "currency_mismatch" ? "Allocation currency must match the account currency." : err.code === "goal_archived" ? "Archived goals accept no new allocations." : "Check the account, amount and currency.";
        html(res, err.code === "not_found" ? 404 : 400, errorPage({ status: err.code === "not_found" ? 404 : 400, heading: err.code === "not_found" ? "Not found" : "Reservation failed", message: detail, back: `/w/${workspaceId}/goals`, requestId, authed: true }));
        return true;
      }
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        event(`ui_command_denied:goals-${action}`);
        html(res, 400, errorPage({ status: 400, heading: "Reservation failed", message: "Check the account, amount and currency.", back: `/w/${workspaceId}/goals`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- GET /w/:id/projection ----
  const projectionMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/projection$/);
  if (projectionMatch && method === "GET") {
    const workspaceId = projectionMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view projections.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:projection");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const horizonDays = Math.min(120, Math.max(1, Number(query.get("horizonDays") ?? "") || 30));
      const spendingAccountId = query.get("spendingAccountId") || undefined;
      const result = await evaluateProjection(pool, resolved.claim, { horizonDays, spendingAccountId });
      const ats = result.ats;
      const atsCard =
        ats.status === "AVAILABLE"
          ? `<div class="notice" role="status" data-ats-status="AVAILABLE" data-ats-amount="${escapeHtml(ats.amountMinor)}"><p>Available to Spend (conservative case): ${money(ats.amountMinor, result.baseCurrency)}. Limiting day ${escapeHtml(ats.limitingDay ?? "")}${ats.limitingAccount ? `, account ${escapeHtml(ats.limitingAccount)}` : ""}. An estimate, not a promise.</p></div>`
          : ats.status === "SHORTFALL"
            ? `<div class="alert" role="alert" data-ats-status="SHORTFALL" data-ats-amount="0"><p>Available to Spend: 0 plus a shortfall of ${money(ats.shortfallMinor ?? "0", result.baseCurrency)} on ${escapeHtml(ats.shortfallDate ?? "")}.</p></div>`
            : `<div class="alert" role="alert" data-ats-status="UNAVAILABLE" data-ats-amount="0"><p>Available to Spend is unavailable: ${escapeHtml((ats.reasons ?? []).join(", "))}. Supply the missing inputs.</p></div>`;
      const totals = result.points.filter((p) => p.scope === "TOTAL" && p.caseName === "EXPECTED");
      const rows = totals
        .map((p) => {
          const cons = result.points.find((q) => q.caseName === "CONSERVATIVE" && q.scope === "TOTAL" && q.pointDate === p.pointDate);
          const opt = result.points.find((q) => q.caseName === "OPTIMISTIC" && q.scope === "TOTAL" && q.pointDate === p.pointDate);
          return `<tr><td>${escapeHtml(p.pointDate)}</td><td>${money(p.amountMinor, p.currencyCode)}</td><td>${cons ? money(cons.amountMinor, cons.currencyCode) : "n/a"}</td><td>${opt ? money(opt.amountMinor, opt.currencyCode) : "n/a"}</td></tr>`;
        })
        .join("");
      html(
        res,
        200,
        page({
          title: "Projection",
          requestId,
          authed: true,
          content: `<a href="#main">Skip to content</a><h2>Projection</h2>${nav(workspaceId)}${noticeFor(query)}${atsCard}<form method="get" action="/w/${escapeHtml(workspaceId)}/projection"><label>Horizon days (1–120) <input name="horizonDays" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(String(horizonDays))}"></label> <label>Spending account <input name="spendingAccountId" value="${escapeHtml(spendingAccountId ?? "")}"></label> <button type="submit">Recompute</button></form><p>Expected / Conservative / Optimistic are named assumption cases from the deterministic engine, not probabilities. Coverage: ${escapeHtml(JSON.stringify(result.coverage))}.</p><div style="overflow-x:auto"><table><caption>Daily total cash (conservative case drives Available to Spend)</caption><thead><tr><th scope="col">Date</th><th scope="col">Expected</th><th scope="col">Conservative</th><th scope="col">Optimistic</th></tr></thead><tbody>${rows}</tbody></table></div>`,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- GET /w/:id/scenarios ----
  const scenariosMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/scenarios$/);
  if (scenariosMatch && method === "GET") {
    const workspaceId = scenariosMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view scenarios.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:scenarios");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const scenarios = await listScenarios(pool, resolved.claim);
      const rows =
        scenarios.length === 0
          ? `<p>No scenarios yet. Scenarios store only hypothetical deltas; booked data never changes.</p>`
          : `<div style="overflow-x:auto"><table><caption>Flat scenarios</caption><thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Version</th><th scope="col">Open</th><th scope="col">Archive</th></tr></thead><tbody>${scenarios
              .map(
                (s) =>
                  `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.status)}</td><td>${escapeHtml(s.version)}</td><td><a href="/w/${escapeHtml(workspaceId)}/scenarios/${escapeHtml(s.id)}">Open</a></td><td>${s.status === "ACTIVE" ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/scenarios/archive"><input type="hidden" name="scenarioId" value="${escapeHtml(s.id)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(s.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">Archive</button></form>` : `<span>Archived</span>`}</td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      html(
        res,
        200,
        page({
          title: "Scenarios",
          requestId,
          authed: true,
          content: `<a href="#main">Skip to content</a><h2>Scenarios</h2>${nav(workspaceId)}${noticeFor(query)}${rows}<h3>New flat scenario</h3><form method="post" action="/w/${escapeHtml(workspaceId)}/scenarios/create"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Name <input name="name" required maxlength="200"></label> <button type="submit">Create scenario</button></form>`,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- GET /w/:id/scenarios/:sid ----
  const scenarioDetailMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/scenarios\/([A-Za-z0-9-]+)$/);
  if (scenarioDetailMatch && method === "GET") {
    const workspaceId = scenarioDetailMatch[1];
    const scenarioId = scenarioDetailMatch[2];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view scenarios.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:scenarios");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    if (!isUuid(scenarioId)) {
      html(res, 400, errorPage({ status: 400, heading: "Invalid request", message: "Unknown scenario.", back: `/w/${workspaceId}/scenarios`, requestId, authed: true }));
      return true;
    }
    try {
      const { scenario, overrides } = await getScenario(pool, resolved.claim, scenarioId);
      const horizonDays = Math.min(120, Math.max(1, Number(query.get("horizonDays") ?? "") || 60));
      const spendingAccountId = query.get("spendingAccountId") || undefined;
      const cmp = await compareScenarios(pool, resolved.claim, { workspaceId, scenarioId, horizonDays, spendingAccountId });
      const overrideRows =
        overrides.length === 0
          ? `<p>No overrides yet. Add a hypothetical input below; booked transactions stay unchanged.</p>`
          : `<div style="overflow-x:auto"><table><caption>Scenario overrides (deltas only)</caption><thead><tr><th scope="col">Type</th><th scope="col">Payload</th><th scope="col">Remove</th></tr></thead><tbody>${overrides
              .map(
                (o) =>
                  `<tr><td>${escapeHtml(o.overrideType)}</td><td>${escapeHtml(JSON.stringify(o.payload))}</td><td><form method="post" action="/w/${escapeHtml(workspaceId)}/scenarios/${escapeHtml(scenarioId)}/overrides/remove"><input type="hidden" name="overrideId" value="${escapeHtml(o.id)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">Remove</button></form></td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      const deltaRows =
        cmp.deltas.length === 0
          ? `<p>No differences from baseline over this horizon.</p>`
          : `<div style="overflow-x:auto"><table><caption>Scenario deltas vs baseline</caption><thead><tr><th scope="col">Date</th><th scope="col">Case</th><th scope="col">Scope</th><th scope="col">Delta</th></tr></thead><tbody>${cmp.deltas
              .slice(0, 200)
              .map((d) => `<tr><td>${escapeHtml(d.pointDate)}</td><td>${escapeHtml(d.caseName)}</td><td>${escapeHtml(d.scope)}</td><td>${money(d.deltaMinor, d.currency)}</td></tr>`)
              .join("")}</tbody></table></div>${cmp.deltas.length > 200 ? `<p>Showing 200 of ${cmp.deltas.length} differing days.</p>` : ""}`;
      const fmtAts = (ats: { status: string; amountMinor: string; shortfallMinor?: string; shortfallDate?: string; reasons?: string[] }) =>
        ats.status === "AVAILABLE" ? `Available ${money(ats.amountMinor, cmp.baseCurrency)}` : ats.status === "SHORTFALL" ? `0 plus shortfall ${money(ats.shortfallMinor ?? "0", cmp.baseCurrency)} on ${escapeHtml(ats.shortfallDate ?? "")}` : `Unavailable (${escapeHtml((ats.reasons ?? []).join(", "))})`;
      html(
        res,
        200,
        page({
          title: scenario.name,
          requestId,
          authed: true,
          content: `<a href="#main">Skip to content</a><h2>Scenario: ${escapeHtml(scenario.name)}</h2>${nav(workspaceId)}${noticeFor(query)}<p>Baseline ${escapeHtml(cmp.baselineInputHash.slice(0, 12))} vs scenario ${escapeHtml(cmp.scenarioInputHash.slice(0, 12))} from ${escapeHtml(cmp.horizonStart)} over ${escapeHtml(String(cmp.horizonDays))} days. Goal changes: ${escapeHtml(JSON.stringify(cmp.goalDisplay))}.</p><p>Baseline ATS: ${fmtAts(cmp.baselineAts)}. Scenario ATS: ${fmtAts(cmp.scenarioAts)}.</p><form method="get" action="/w/${escapeHtml(workspaceId)}/scenarios/${escapeHtml(scenarioId)}"><label>Horizon days (1–120) <input name="horizonDays" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(String(horizonDays))}"></label> <label>Spending account <input name="spendingAccountId" value="${escapeHtml(spendingAccountId ?? "")}"></label> <button type="submit">Recompare</button></form>${overrideRows}${deltaRows}<h3>Add override</h3><form method="post" action="/w/${escapeHtml(workspaceId)}/scenarios/${escapeHtml(scenarioId)}/overrides/add"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Type <select name="overrideType"><option value="ONE_TIME_EXPENSE">One-time expense</option><option value="ONE_TIME_INCOME">One-time income</option><option value="RECURRING_EXPENSE_CHANGE">Monthly expense change</option><option value="INCOME_CHANGE">Monthly income change</option></select></label> <label>Amount (major units) <input name="amount" inputmode="decimal" required></label> <label>Currency <input name="currency" maxlength="3" required value="${escapeHtml(cmp.baseCurrency)}"></label> <label>Date or day of month <input name="dayOrDate" required></label> <label>Account <input name="accountId"></label> <button type="submit">Add override</button></form><p><a href="/w/${escapeHtml(workspaceId)}/scenarios">Back to scenarios</a></p>`,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof TxError) {
        const status = err.code === "not_found" ? 404 : 400;
        html(res, status, errorPage({ status, heading: status === 404 ? "Not found" : "Cannot compare", message: status === 404 ? "No such scenario." : "Check the horizon and account, then retry.", back: `/w/${workspaceId}/scenarios`, requestId, authed: true }));
        return true;
      }
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/scenarios/create ----
  const scenarioCreateMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/scenarios\/create$/);
  if (scenarioCreateMatch && method === "POST") {
    const workspaceId = scenarioCreateMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/scenarios`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      const result = await createScenario(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        name: form?.get("name") ?? "",
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:scenarios-create");
      res.writeHead(303, { Location: `/w/${workspaceId}/scenarios/${result.view.id}?notice=scenario` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:scenarios-create");
        html(res, 400, errorPage({ status: 400, heading: "Create failed", message: "Check the scenario name and retry.", back: `/w/${workspaceId}/scenarios`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/scenarios/archive ----
  const scenarioArchiveMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/scenarios\/archive$/);
  if (scenarioArchiveMatch && method === "POST") {
    const workspaceId = scenarioArchiveMatch[1];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/scenarios`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      await archiveScenario(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        scenarioId: form?.get("scenarioId") ?? "",
        expectedVersion: form?.get("expectedVersion") ?? "",
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:scenarios-archive");
      res.writeHead(303, { Location: `/w/${workspaceId}/scenarios?notice=archived` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event("ui_command_conflict:scenarios-archive");
        html(res, 409, conflictShell(workspaceId, "scenarios", "Scenario conflict", err.currentVersion, `/w/${workspaceId}/scenarios`));
        return true;
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:scenarios-archive");
        html(res, 400, errorPage({ status: 400, heading: "Archive failed", message: "The scenario changed or is already archived.", back: `/w/${workspaceId}/scenarios`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/scenarios/:sid/overrides/add ----
  const overrideAddMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/scenarios\/([A-Za-z0-9-]+)\/overrides\/add$/);
  if (overrideAddMatch && method === "POST") {
    const workspaceId = overrideAddMatch[1];
    const scenarioId = overrideAddMatch[2];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/scenarios/${scenarioId}`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      const me = await resolveSession(req);
      const spaces = await listWorkspaces(pool, me!.keycloakSub);
      const baseCurrency = spaces.find((w) => w.id === workspaceId)?.baseCurrency ?? "EUR";
      const { parseMinor } = await import("../money.ts");
      const type = form?.get("overrideType") ?? "";
      const amount = parseMinor(form?.get("amount") ?? "", form?.get("currency") || baseCurrency).toString();
      const currency = form?.get("currency") || baseCurrency;
      const dayOrDate = form?.get("dayOrDate") ?? "";
      const accountId = (form?.get("accountId") ?? "").trim() || undefined;
      let overrideType: string;
      let payload: Record<string, unknown>;
      if (type === "ONE_TIME_INCOME") {
        overrideType = "ONE_TIME_INCOME";
        payload = { amountMinor: amount, currency, date: dayOrDate, ...(accountId ? { accountId } : {}) };
      } else if (type === "INCOME_CHANGE") {
        overrideType = "INCOME_CHANGE";
        payload = { amountMinor: amount, currency, dayOfMonth: Number(dayOrDate), ...(accountId ? { accountId } : {}) };
      } else if (type === "RECURRING_EXPENSE_CHANGE") {
        overrideType = "RECURRING_EXPENSE_CHANGE";
        payload = { amountMinor: amount, currency, dayOfMonth: Number(dayOrDate), direction: "OUTFLOW", ...(accountId ? { accountId } : {}) };
      } else {
        overrideType = "ONE_TIME_EXPENSE";
        payload = { amountMinor: amount, currency, date: dayOrDate, ...(accountId ? { accountId } : {}) };
      }
      await addOverride(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        scenarioId,
        overrideType: overrideType as "ONE_TIME_EXPENSE" | "ONE_TIME_INCOME" | "RECURRING_EXPENSE_CHANGE" | "INCOME_CHANGE",
        effectiveFrom: null,
        effectiveTo: null,
        payload,
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:scenario-override");
      res.writeHead(303, { Location: `/w/${workspaceId}/scenarios/${scenarioId}?notice=override` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:scenario-override");
        const status = err instanceof TxError && err.code === "not_found" ? 404 : 400;
        html(res, status, errorPage({ status, heading: status === 404 ? "Not found" : "Add failed", message: status === 404 ? "No such scenario." : "Check the amount, currency and day/date, then retry.", back: `/w/${workspaceId}/scenarios/${scenarioId}`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // ---- POST /w/:id/scenarios/:sid/overrides/remove ----
  const overrideRemoveMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/scenarios\/([A-Za-z0-9-]+)\/overrides\/remove$/);
  if (overrideRemoveMatch && method === "POST") {
    const workspaceId = overrideRemoveMatch[1];
    const scenarioId = overrideRemoveMatch[2];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/scenarios/${scenarioId}`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    try {
      await removeOverride(pool, resolved.claim, resolved.claim.userId, {
        workspaceId,
        scenarioId,
        overrideId: form?.get("overrideId") ?? "",
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      });
      event("ui_command_ok:scenario-override-remove");
      res.writeHead(303, { Location: `/w/${workspaceId}/scenarios/${scenarioId}?notice=removed` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event("ui_command_denied:scenario-override-remove");
        const status = err instanceof TxError && err.code === "not_found" ? 404 : 400;
        html(res, status, errorPage({ status, heading: status === 404 ? "Not found" : "Remove failed", message: status === 404 ? "No such override." : "Retry from the scenario page.", back: `/w/${workspaceId}/scenarios/${scenarioId}`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  return false;
}
