// E07-S02 trusted Home: server-rendered dashboard (zero client JavaScript)
// over the shared E03/E06 queries only. AI text never supplies a metric:
// every number comes from getFinancialSummary / getBalances / getCashflow /
// evaluateProjection / goals / the E07-S01 saved report. Shared queries own
// ALL arithmetic; this module only labels coverage honestly (unavailable /
// partial, never a false zero or a complete net worth) and gates findings
// (evidence-validated + current-policy recheck at render, max 3 expanded).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { listAccountViews } from "../commands/accounts.ts";
import { listGoals, type GoalView } from "../commands/goals.ts";
import { getPolicy, summarizeEligible, type PolicyState } from "../ai-policy.ts";
import { getBalances, getCashflow, getFinancialSummary, type FinancialSummary } from "../calculations/financial-summary.ts";
import { evaluateProjection, type ProjectionEvaluation } from "../projections/engine.ts";
import { readAnalysisDetail, validateFindings, type AnalysisDetailView, type FindingView } from "../deep-analysis.ts";
import { TenantDenied, sessionClaims, type SessionResolver } from "../tenancy.ts";
import { errorPage, escapeHtml, page } from "./shell.ts";

export type HomeUiConfig = { appBaseUrl: string };

// Touch targets meet the 44px minimum without client code: every primary
// action carries an inline min-height/min-width so the shared shell CSS can
// never shrink them below the floor.
const TAP = `style="min-height:44px;min-width:44px;display:inline-block;padding:.6rem 1rem;line-height:1.5"`;

function homeLink(workspaceId: string, section: string, label: string, extra = ""): string {
  return `<a href="/w/${escapeHtml(workspaceId)}/home/detail?section=${section}${extra}" ${TAP}>${escapeHtml(label)}</a>`;
}

export type HomeData = {
  accounts: { id: string; name: string }[];
  policy: PolicyState;
  eligibleAccountIds: string[];
  balances: { balances: { accountId: string; amount: string; currency: string }[]; coverage: "full" | "partial"; excludedAccounts: number; revision: string } | null;
  month: { summary: FinancialSummary; dateFrom: string; dateTo: string } | null;
  monthError: string | null;
  projection: { evaluation: ProjectionEvaluation } | null;
  projectionError: string | null;
  goals: GoalView[] | null;
  goalsError: string | null;
  cashflowPoints: number | null;
  analysis: AnalysisDetailView | null;
  gatedFindings: FindingView[];
};

export function currentMonthRange(now = new Date()): { dateFrom: string; dateTo: string } {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const last = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
  return { dateFrom: `${y}-${m}-01`, dateTo: `${y}-${m}-${String(last).padStart(2, "0")}` };
}

/** Findings gate at render time: evidence-validated + current-policy
 * recheck. Amount-bearing findings need evidence; any finding referencing
 * an account outside the currently eligible set (excluded/foreign) is
 * dropped — the excluded sentinel can never appear. Max 3 expanded. */
export function gateFindings(findings: FindingView[], eligibleAccountIds: Set<string>): FindingView[] {
  const drafts = findings.map((f) => ({
    kind: "spending" as const,
    title: f.title,
    body: f.body,
    amountMinor: f.amountMinor,
    currency: f.currency,
    evidence: f.evidence,
  }));
  const keptDrafts = validateFindings(drafts, eligibleAccountIds);
  const kept = new Set(keptDrafts);
  return findings.filter((f) => [...kept].some((d) => d.title === f.title && d.body === f.body)).slice(0, 3);
}

export async function loadHomeData(
  pool: Pool,
  claims: { userId: string; workspaceId: string },
  now = new Date(),
): Promise<HomeData> {
  const full = claims as Parameters<typeof getFinancialSummary>[1];
  const [accounts, policy, eligible, analysis] = await Promise.all([
    listAccountViews(pool, full),
    getPolicy(pool, full),
    summarizeEligible(pool, full),
    readAnalysisDetail(pool, full),
  ]);
  const excluded = new Set(policy.excludedAccountIds);
  const eligibleAccountIds = accounts.filter((a) => !excluded.has(a.id)).map((a) => a.id);

  let balances: HomeData["balances"] = null;
  try {
    balances = await getBalances(pool, full);
  } catch {
    balances = null;
  }

  const { dateFrom, dateTo } = currentMonthRange(now);
  let month: HomeData["month"] = null;
  let monthError: string | null = null;
  try {
    const summary = await getFinancialSummary(pool, full, full.workspaceId, { dateFrom, dateTo });
    month = { summary, dateFrom, dateTo };
  } catch {
    monthError = "unavailable";
  }

  let projection: HomeData["projection"] = null;
  let projectionError: string | null = null;
  try {
    const evaluation = await evaluateProjection(pool, full, {});
    projection = { evaluation };
  } catch {
    projectionError = "unavailable";
  }

  let goals: HomeData["goals"] = null;
  let goalsError: string | null = null;
  try {
    goals = await listGoals(pool, full);
  } catch {
    goalsError = "unavailable";
  }

  let cashflowPoints: number | null = null;
  try {
    const flow = await getCashflow(pool, full, { dateFrom, dateTo });
    cashflowPoints = flow.points.length;
  } catch {
    cashflowPoints = null;
  }

  void eligible;
  const gatedFindings = analysis ? gateFindings(analysis.findings, new Set(eligibleAccountIds)) : [];
  return { accounts, policy, eligibleAccountIds, balances, month, monthError, projection, projectionError, goals, goalsError, cashflowPoints, analysis, gatedFindings };
}

function minorLabel(amountMinor: string | null, currency: string | null): string {
  if (amountMinor === null) return "—";
  return `${amountMinor} minor${currency ? ` ${currency}` : ""}`;
}

function sectionBalances(workspaceId: string, data: HomeData): string {
  const names = new Map(data.accounts.map((a) => [a.id, a.name]));
  if (!data.balances || data.balances.balances.length === 0) {
    return `<section aria-labelledby="home-balances"><h2 id="home-balances">Balances</h2><p><strong>Balances unavailable</strong> — no balance snapshots yet. No total is claimed.</p><p>${homeLink(workspaceId, "balances", "Balance details")}</p></section>`;
  }
  const byCurrency = new Map<string, bigint>();
  for (const b of data.balances.balances) {
    // Displayed amounts are exact minor-unit decimal strings (never floats).
    byCurrency.set(b.currency, (byCurrency.get(b.currency) ?? 0n) + BigInt(b.amount));
  }
  const currencies = [...byCurrency.keys()].sort();
  const complete = data.balances.coverage === "full" && currencies.length === 1;
  const headline =
    complete
      ? `<p><strong>Net worth: ${byCurrency.get(currencies[0]!)!.toString(10)} minor ${escapeHtml(currencies[0]!)}.</strong> Full coverage across ${escapeHtml(String(data.balances.balances.length))} known accounts.</p>`
      : `<p><strong>Known balances (partial net worth — not complete).</strong> ${data.balances.excludedAccounts > 0 ? `${escapeHtml(String(data.balances.excludedAccounts))} account(s) excluded from AI are hidden; ` : ""}${
          currencies.length > 1 ? "multiple currencies cannot be summed into one total; " : ""
        }per-account figures below.</p>`;
  const rows = data.balances.balances
    .map((b) => `<tr><td>${escapeHtml(names.get(b.accountId) ?? b.accountId)}</td><td>${escapeHtml(b.amount)} minor ${escapeHtml(b.currency)}</td></tr>`)
    .join("");
  return `<section aria-labelledby="home-balances"><h2 id="home-balances">Balances</h2>${headline}<table><caption>Known account balances</caption><thead><tr><th scope="col">Account</th><th scope="col">Balance</th></tr></thead><tbody>${rows}</tbody></table><p>${homeLink(workspaceId, "balances", "Balance details")}</p></section>`;
}

function sectionSpend(workspaceId: string, data: HomeData): string {
  const range = data.month ? `${data.month.dateFrom} to ${data.month.dateTo}` : "this month";
  if (!data.month) {
    return `<section aria-labelledby="home-spend"><h2 id="home-spend">This month</h2><p><strong>Income and spend unavailable</strong> (${escapeHtml(data.monthError ?? "unavailable")}). Missing spend baseline is never reported as zero.</p><p>${homeLink(workspaceId, "spend", "Income and spend details")}</p></section>`;
  }
  const s = data.month.summary;
  const coverageNote =
    s.base.coverage === "full"
      ? "complete"
      : s.base.coverage === "partial"
        ? `partial (${escapeHtml(s.base.unvaluedCount)} unvalued transaction(s) excluded — not counted as zero)`
        : "unavailable";
  return `<section aria-labelledby="home-spend"><h2 id="home-spend">This month (${escapeHtml(range)})</h2><p>Income <strong>${escapeHtml(s.base.incomeMinor)} minor ${escapeHtml(s.baseCurrency)}</strong> · Spend <strong>${escapeHtml(s.base.spendMinor)} minor ${escapeHtml(s.baseCurrency)}</strong> · Coverage: ${coverageNote}.${
    data.cashflowPoints !== null ? ` ${escapeHtml(String(data.cashflowPoints))} daily cashflow point(s).` : ""
  }</p><p>${homeLink(workspaceId, "spend", "Income and spend details")}</p></section>`;
}

function sectionProjection(workspaceId: string, data: HomeData): string {
  if (!data.projection) {
    return `<section aria-labelledby="home-ats"><h2 id="home-ats">Available to Spend</h2><p><strong>Available to Spend: UNAVAILABLE</strong> — ${escapeHtml(data.projectionError ?? "projection could not be evaluated")}. No forward cushion is claimed.</p><p>${homeLink(workspaceId, "projection", "Projection details")}</p></section>`;
  }
  const ats = data.projection.evaluation.ats;
  const head =
    ats.status === "AVAILABLE"
      ? `<p><strong>Available to Spend: ${escapeHtml(ats.amountMinor)} minor ${escapeHtml(data.projection.evaluation.baseCurrency)} (conservative).</strong></p>`
      : ats.status === "SHORTFALL"
        ? `<p><strong>Available to Spend: SHORTFALL of ${escapeHtml(ats.shortfallMinor ?? "?")} minor ${escapeHtml(data.projection.evaluation.baseCurrency)}${ats.shortfallDate ? ` by ${escapeHtml(ats.shortfallDate)}` : ""}.</strong></p>`
        : `<p><strong>Available to Spend: UNAVAILABLE</strong> — ${(ats.reasons ?? []).map((r) => escapeHtml(r)).join(", ") || "missing inputs"}. No forward cushion is claimed.</p>`;
  return `<section aria-labelledby="home-ats"><h2 id="home-ats">Available to Spend</h2>${head}<p>${homeLink(workspaceId, "projection", "Projection details")}</p></section>`;
}

function sectionGoals(workspaceId: string, data: HomeData): string {
  if (!data.goals) {
    return `<section aria-labelledby="home-goals"><h2 id="home-goals">Goals</h2><p><strong>Goals unavailable</strong> (${escapeHtml(data.goalsError ?? "unavailable")}).</p><p>${homeLink(workspaceId, "goals", "Goal details")}</p></section>`;
  }
  if (data.goals.length === 0) {
    return `<section aria-labelledby="home-goals"><h2 id="home-goals">Goals</h2><p>No active goals yet.</p><p>${homeLink(workspaceId, "goals", "Goal details")}</p></section>`;
  }
  const rows = data.goals
    .slice(0, 10)
    .map((g) => {
      const remaining = g.targetAmountMinor !== null ? (BigInt(g.targetAmountMinor) - BigInt(g.reservedMinor)).toString(10) : null;
      return `<tr><td>${escapeHtml(g.name)}</td><td>${g.targetAmountMinor === null ? "no target" : `${escapeHtml(g.reservedMinor)} of ${escapeHtml(g.targetAmountMinor)} minor ${escapeHtml(g.currency ?? "")} reserved (${escapeHtml(remaining!)} remaining)`}</td></tr>`;
    })
    .join("");
  return `<section aria-labelledby="home-goals"><h2 id="home-goals">Goals (${escapeHtml(String(data.goals.length))})</h2><table><caption>Goal summary</caption><thead><tr><th scope="col">Goal</th><th scope="col">Progress</th></tr></thead><tbody>${rows}</tbody></table><p>${homeLink(workspaceId, "goals", "Goal details")}</p></section>`;
}

function sectionAnalysis(workspaceId: string, data: HomeData): string {
  const analysis = data.analysis;
  if (!analysis) {
    return `<section aria-labelledby="home-analysis"><h2 id="home-analysis">Deep Analysis</h2><p>No Deep Analysis yet. Accept an import to start the initial analysis.</p><p><a href="/w/${escapeHtml(workspaceId)}/analysis" ${TAP}>Open Deep Analysis</a></p></section>`;
  }
  const statusLine = `<p>Status: <strong>${escapeHtml(analysis.status)}</strong> · stage ${escapeHtml(analysis.progressStage)} · ${escapeHtml(String(analysis.dispatchesUsed))} dispatches · ${escapeHtml(String(analysis.toolCallsUsed))} evidence calls.${analysis.errorCode ? ` Error: ${escapeHtml(analysis.errorCode)}.` : ""}</p>`;
  const controls =
    analysis.status === "RUNNING" || analysis.status === "QUEUED"
      ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/analysis/stop"><button type="submit" ${TAP}>Stop analysis</button></form>`
      : analysis.status === "FAILED_FINAL" || analysis.status === "CANCELLED"
        ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/analysis/retry"><button type="submit" ${TAP}>Retry analysis</button></form>`
        : ``;
  const findings =
    data.gatedFindings.length === 0
      ? `<p>No validated findings yet${analysis.findings.length > 0 ? " (saved findings did not pass evidence/policy validation and are withheld)" : ""}.</p>`
      : `<ol>${data.gatedFindings
          .map(
            (f) =>
              `<li><strong>${escapeHtml(f.title)}</strong> — ${escapeHtml(f.body)}${f.amountMinor !== null ? ` (${escapeHtml(f.amountMinor)}${f.currency ? ` ${escapeHtml(f.currency)}` : ""})` : ""} <a href="/w/${escapeHtml(workspaceId)}/home/detail?section=findings&amp;finding=${escapeHtml(f.id)}" ${TAP}>Evidence</a></li>`,
          )
          .join("")}</ol>`;
  const warnings =
    analysis.coverageWarnings.length > 0
      ? `<div class="alert" role="alert"><h2>Coverage warnings</h2><ul>${analysis.coverageWarnings.map((w) => `<li>${escapeHtml(w.kind)}</li>`).join("")}</ul></div>`
      : ``;
  return `<section aria-labelledby="home-analysis"><h2 id="home-analysis">Deep Analysis</h2>${statusLine}${warnings}${findings}${controls}<p><a href="/w/${escapeHtml(workspaceId)}/analysis" ${TAP}>Open Deep Analysis</a></p></section>`;
}

export function renderHomeContent(workspaceId: string, data: HomeData): string {
  return `<h2>Home</h2>
<form method="get" action="/w/${escapeHtml(workspaceId)}/home"><button type="submit" ${TAP}>Refresh</button></form>
${sectionBalances(workspaceId, data)}
${sectionSpend(workspaceId, data)}
${sectionProjection(workspaceId, data)}
${sectionGoals(workspaceId, data)}
${sectionAnalysis(workspaceId, data)}
<p><a href="/w/${escapeHtml(workspaceId)}" ${TAP}>Back to workspace</a></p>`;
}

function detailRows(rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p>${escapeHtml(empty)}</p>`;
  return `<table><tbody>${rows
    .slice(0, 50)
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table><p>Showing ${escapeHtml(String(Math.min(rows.length, 50)))} of ${escapeHtml(String(rows.length))} rows (cap 50).</p>`;
}

export function renderHomeDetailContent(workspaceId: string, section: string, data: HomeData, findingId?: string): string | null {
  const back = `<p><a href="/w/${escapeHtml(workspaceId)}/home" ${TAP}>Back to Home</a></p>`;
  if (section === "balances") {
    const names = new Map(data.accounts.map((a) => [a.id, a.name]));
    const rows = (data.balances?.balances ?? []).map((b) => [
      escapeHtml(names.get(b.accountId) ?? b.accountId),
      escapeHtml(`${b.amount} minor ${b.currency}`),
      escapeHtml(`revision ${data.balances!.revision}; coverage ${data.balances!.coverage}; excluded accounts ${data.balances!.excludedAccounts}`),
    ]);
    if (!data.balances) return `<h2>Balance details</h2><p><strong>Balances unavailable</strong> — source snapshots could not be read. No total is claimed.</p>${back}`;
    return `<h2>Balance details</h2><p>Source: latest balance snapshot per known account; currency shown per account (no cross-currency sum); AI-excluded accounts are hidden from this table.</p>${detailRows(rows, "No snapshots.")}${back}`;
  }
  if (section === "spend") {
    if (!data.month) return `<h2>Income and spend details</h2><p><strong>Unavailable</strong> — the spend baseline could not be computed. Nothing is reported as zero.</p>${back}`;
    const s = data.month.summary;
    const rows = [
      [escapeHtml("Source dates"), escapeHtml(`${data.month.dateFrom} to ${data.month.dateTo}`)],
      [escapeHtml("Base currency / FX"), escapeHtml(`${s.baseCurrency}; FX gaps mark coverage partial, never zero`)],
      [escapeHtml("Income (minor)"), escapeHtml(s.base.incomeMinor)],
      [escapeHtml("Spend (minor)"), escapeHtml(s.base.spendMinor)],
      [escapeHtml("Cash (minor)"), escapeHtml(s.base.cashMinor)],
      [escapeHtml("Coverage"), escapeHtml(`${s.base.coverage}; ${s.base.unvaluedCount} unvalued`)],
      [escapeHtml("Calculation"), escapeHtml(`v${s.calculationVersion} inputs ${s.inputsHash.slice(0, 16)} results ${s.resultsHash.slice(0, 16)}`)],
      ...s.native.slice(0, 43).map((n) => [escapeHtml(`Native ${n.currency}`), escapeHtml(`income ${n.incomeMinor} spend ${n.spendMinor} cash ${n.cashMinor}`)]),
    ];
    return `<h2>Income and spend details</h2><p>Shared-query provenance: every figure is server-computed; AI text supplies no metric.</p>${detailRows(rows, "No rows.")}${back}`;
  }
  if (section === "goals") {
    if (!data.goals) return `<h2>Goal details</h2><p><strong>Goals unavailable.</strong></p>${back}`;
    const rows = data.goals.slice(0, 50).map((g) => [
      escapeHtml(g.name),
      escapeHtml(g.targetAmountMinor === null ? "no target" : `${g.reservedMinor} of ${g.targetAmountMinor} minor ${g.currency ?? ""} reserved`),
      escapeHtml(`reservation v${g.version}; target date ${g.targetDate ?? "none"}`),
    ]);
    return `<h2>Goal details</h2><p>Reservations are virtual allocations of spendable cash; they create no money.</p>${detailRows(rows, "No goals.")}${back}`;
  }
  if (section === "projection") {
    if (!data.projection) return `<h2>Projection details</h2><p><strong>UNAVAILABLE</strong> — ${escapeHtml(data.projectionError ?? "no evaluation")}. Assumption: no forward cushion is claimed without inputs.</p>${back}`;
    const ev = data.projection.evaluation;
    const ats = ev.ats;
    const rows = [
      [escapeHtml("Horizon"), escapeHtml(`${ev.horizonStart} + ${ev.horizonDays} days`)],
      [escapeHtml("Base currency"), escapeHtml(ev.baseCurrency)],
      [escapeHtml("Status"), escapeHtml(ats.status)],
      [escapeHtml("Amount (minor)"), escapeHtml(ats.amountMinor)],
      ...(ats.status === "SHORTFALL" ? [[escapeHtml("Shortfall"), escapeHtml(`${ats.shortfallMinor ?? "?"} by ${ats.shortfallDate ?? "?"}`)]] : []),
      ...(ats.status === "UNAVAILABLE" ? [[escapeHtml("Reasons"), escapeHtml((ats.reasons ?? []).join(", ") || "missing inputs")]] : []),
      [escapeHtml("Limiting"), escapeHtml(`${ats.limitingDay ?? "—"} / ${ats.limitingAccount ?? "—"}`)],
      [escapeHtml("Input hash"), escapeHtml(ev.inputHash.slice(0, 32))],
      [escapeHtml("Assumption"), escapeHtml("conservative case; reservations and recurring commitments applied before spendable cash")],
      ...ev.points.slice(0, 41).map((p) => [escapeHtml(`${p.caseName} ${p.pointDate}`), escapeHtml(`${p.amountMinor} minor ${p.currencyCode} (${p.scope})`)]),
    ];
    return `<h2>Projection details</h2><p>Conservative Available to Spend with shortfall reasons; at most 50 rows shown.</p>${detailRows(rows, "No points.")}${back}`;
  }
  if (section === "findings") {
    const found = data.gatedFindings.find((f) => f.id === findingId);
    if (!findingId || !found) {
      const rows = data.gatedFindings.map((f) => [
        escapeHtml(f.title),
        escapeHtml(minorLabel(f.amountMinor, f.currency)),
        `<a href="/w/${escapeHtml(workspaceId)}/home/detail?section=findings&amp;finding=${escapeHtml(f.id)}" ${TAP}>Evidence</a>`,
      ]);
      return `<h2>Finding details</h2><p>Only evidence-validated findings under the current AI policy are listed (max 3).</p>${detailRows(rows, "No validated findings.")}${back}`;
    }
    const rows = found.evidence.slice(0, 50).map((ref) => [escapeHtml(ref), escapeHtml("saved evidence reference; amounts server-computed")]);
    return `<h2>Finding evidence</h2><p><strong>${escapeHtml(found.title)}</strong> — ${escapeHtml(found.body)} (${escapeHtml(minorLabel(found.amountMinor, found.currency))}).</p>${detailRows(rows, "No evidence refs.")}${back}`;
  }
  if (section === "analysis") {
    const a = data.analysis;
    if (!a) return `<h2>Analysis details</h2><p>No Deep Analysis yet.</p>${back}`;
    return `<h2>Analysis details</h2><p>Status ${escapeHtml(a.status)} · stage ${escapeHtml(a.progressStage)} · dispatches ${escapeHtml(String(a.dispatchesUsed))} · evidence calls ${escapeHtml(String(a.toolCallsUsed))} · tokens ${escapeHtml(String(a.tokensReserved))} · cost ${escapeHtml(String(a.costReservedMinor))}.${a.cutoffAt ? ` Evidence cutoff ${escapeHtml(a.cutoffAt)}.` : ""}${a.errorCode ? ` Error ${escapeHtml(a.errorCode)}.` : ""}</p>${back}`;
  }
  return null;
}

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

export async function handleHomeRoutes(
  pool: Pool,
  resolveSession: SessionResolver,
  _config: HomeUiConfig,
  event: (code: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  requestId = "uncontrolled",
): Promise<boolean> {
  const homeMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/home$/);
  if (homeMatch && method === "GET") {
    const workspaceId = homeMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view Home.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:workspace");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const data = await loadHomeData(pool, resolved.claim);
      html(res, 200, page({ title: "Home", requestId, authed: true, content: renderHomeContent(workspaceId, data) }));
    } catch (err) {
      if (err instanceof TenantDenied) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      // Trusted failure state, never a blank dashboard: the shell renders
      // with an explicit error, links intact, refresh available.
      html(
        res,
        503,
        page({
          title: "Home",
          requestId,
          authed: true,
          content: `<h2>Home</h2><div class="alert" role="alert"><h2>Home temporarily unavailable</h2><p>Trusted metrics could not be loaded. No figures are shown rather than stale ones.</p><p><a href="/w/${escapeHtml(workspaceId)}/home" ${TAP}>Retry (refresh)</a> · <a href="/w/${escapeHtml(workspaceId)}" ${TAP}>Back to workspace</a></p></div>`,
        }),
      );
    }
    return true;
  }

  const detailMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/home\/detail$/);
  if (detailMatch && method === "GET") {
    const workspaceId = detailMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view Home details.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:workspace");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const section = query.get("section") ?? "";
    if (!["balances", "spend", "goals", "projection", "findings", "analysis"].includes(section)) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such detail section.", back: `/w/${workspaceId}/home`, requestId, authed: true }));
      return true;
    }
    try {
      const data = await loadHomeData(pool, resolved.claim);
      const content = renderHomeDetailContent(workspaceId, section, data, query.get("finding") ?? undefined);
      if (content === null) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such detail section.", back: `/w/${workspaceId}/home`, requestId, authed: true }));
        return true;
      }
      html(res, 200, page({ title: "Home detail", requestId, authed: true, content }));
    } catch (err) {
      if (err instanceof TenantDenied) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      html(res, 503, errorPage({ status: 503, heading: "Details unavailable", message: "Detail rows could not be loaded.", back: `/w/${workspaceId}/home`, requestId, authed: true }));
    }
    return true;
  }

  return false;
}
