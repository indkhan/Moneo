// E07-S02 trusted Home: server-rendered dashboard (zero client JavaScript)
// over the shared E03/E06 queries only. AI text never supplies a metric:
// every number comes from getFinancialSummary / getBalances / getCashflow /
// evaluateProjection / goals / the E07-S01 saved report. Shared queries own
// ALL arithmetic; this module only labels coverage honestly (unavailable /
// partial, never a false zero or a complete net worth) and gates findings
// (evidence-validated + current-policy recheck at render, max 3 expanded).

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { listAccountViews } from "../commands/accounts.ts";
import { listGoals, type GoalView } from "../commands/goals.ts";
import {
  defaultPinnedOrder,
  listPinnableArtifacts,
  moveTile,
  pinTile,
  readHomeLayout,
  resizeTile,
  resolveHomeTiles,
  unpinTile,
  type HomeTileResolution,
  type PinnedArtifactDefault,
} from "../commands/home-layout.ts";
import { TxError } from "../commands/transactions.ts";
import { readLimitedBody } from "../http-controls.ts";
import { getPolicy, type PolicyState } from "../ai-policy.ts";
import { getBalances, getCashflow, getFinancialSummary, type FinancialSummary } from "../calculations/financial-summary.ts";
import { evaluateProjection, type ProjectionEvaluation } from "../projections/engine.ts";
import { readAnalysisDetail, validateFindings, type AnalysisDetailView, type FindingView } from "../deep-analysis.ts";
import { TenantDenied, sessionClaims, type SessionResolver } from "../tenancy.ts";
import { errorPage, escapeHtml, page, workspaceNav } from "./shell.ts";

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
  layout: { version: string; userEdited: boolean } | null;
  layoutError: string | null;
  tiles: HomeTileResolution[];
  defaults: PinnedArtifactDefault[];
  pinnable: { artifactId: string; name: string }[];
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
  const kept = new Set(validateFindings(drafts, eligibleAccountIds));
  return findings.filter((_, i) => kept.has(drafts[i]!)).slice(0, 3);
}

export async function loadHomeData(
  pool: Pool,
  claims: { userId: string; workspaceId: string },
  now = new Date(),
): Promise<HomeData> {
  const full = claims as Parameters<typeof getFinancialSummary>[1];
  const [accounts, policy, analysis] = await Promise.all([
    listAccountViews(pool, full),
    getPolicy(pool, full),
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

  const gatedFindings = analysis ? gateFindings(analysis.findings, new Set(eligibleAccountIds)) : [];

  // E07-S03 pinned artifacts: read-only load. A missing layout row is
  // version "1" with no tiles and nothing is written here, so analysis
  // personalization can never overwrite a saved order — and a saved order
  // (userEdited) is never replaced by the deterministic default.
  let layout: HomeData["layout"] = null;
  let layoutError: string | null = null;
  let tiles: HomeTileResolution[] = [];
  let defaults: PinnedArtifactDefault[] = [];
  let pinnable: { artifactId: string; name: string }[] = [];
  try {
    const resolved = await resolveHomeTiles(pool, full);
    layout = { version: resolved.layout.version, userEdited: resolved.layout.userEdited };
    tiles = resolved.tiles;
    if (resolved.layout.tiles.length === 0 && !resolved.layout.userEdited) {
      defaults = await defaultPinnedOrder(pool, full);
    }
    pinnable = await listPinnableArtifacts(pool, full);
  } catch {
    layoutError = "unavailable";
  }
  return { accounts, policy, eligibleAccountIds, balances, month, monthError, projection, projectionError, goals, goalsError, cashflowPoints, analysis, gatedFindings, layout, layoutError, tiles, defaults, pinnable };
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

const TILE_WIDTH: Record<string, string> = { small: "240px", wide: "480px", large: "720px" };

function layoutForm(workspaceId: string, fields: string, label: string): string {
  return `<form method="post" action="/w/${escapeHtml(workspaceId)}/home/layout">${fields}<button type="submit" ${TAP}>${escapeHtml(label)}</button></form>`;
}

function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

/** E07-S03 pinned artifacts: saved order wins; a fresh workspace shows the
 *  deterministic default (newest ready first) without writing anything.
 *  Tiles never execute artifact code here — Open resolves the CURRENT
 *  active version with fresh SDK grants in the editor; Compact opens the
 *  sandboxed preview. Unavailable pins render as removable, never as code. */
function sectionArtifacts(workspaceId: string, data: HomeData, customize: boolean): string {
  const head = `<section aria-labelledby="home-artifacts"><h2 id="home-artifacts">Pinned artifacts</h2>`;
  if (data.layoutError || !data.layout) {
    return `${head}<p><strong>Pinned artifacts unavailable</strong> (${escapeHtml(data.layoutError ?? "unavailable")}). Saved pins are intact; retry Refresh.</p></section>`;
  }
  const versionLine = `<p>Layout version ${escapeHtml(data.layout.version)}${data.layout.userEdited ? " · customized order" : ""}.</p>`;
  const customizeToggle = customize
    ? `<p><a href="/w/${escapeHtml(workspaceId)}/home" ${TAP}>Done customizing</a></p>`
    : `<p><a href="/w/${escapeHtml(workspaceId)}/home?customize=1" ${TAP}>Customize</a></p>`;

  if (data.tiles.length === 0) {
    const empty = data.layout.userEdited
      ? `<p>No pinned artifacts yet. Customize to pin ready artifacts.</p>`
      : data.defaults.length === 0
        ? `<p>No ready artifacts yet. Publish an artifact, then pin it here.</p>`
        : `<p>Suggested order (newest ready first) — nothing saved yet. Customize to pin your own order.</p><ol style="max-width:100%">${data.defaults
            .map(
              (d) =>
                `<li style="max-width:100%;overflow-wrap:anywhere"><strong>${escapeHtml("(default)")}</strong> <a href="/w/${escapeHtml(workspaceId)}/artifacts/${escapeHtml(d.artifactId)}?tab=preview" ${TAP}>Open</a></li>`,
            )
            .join("")}</ol>`;
    const pinForm =
      customize && data.pinnable.length > 0
        ? `<h3>Pin an artifact</h3><p>Only ready, owned, non-archived artifacts can be pinned (max 12 tiles, no duplicates).</p>${layoutForm(
            workspaceId,
            `${hiddenField("action", "pin")}${hiddenField("expectedVersion", data.layout.version)}${hiddenField("idempotencyKey", randomUUID())}<label>Artifact <select name="artifactId" ${TAP}>${data.pinnable.map((p) => `<option value="${escapeHtml(p.artifactId)}">${escapeHtml(p.name)}</option>`).join("")}</select></label> <label>Size <select name="size" ${TAP}><option value="small">small</option><option value="wide">wide</option><option value="large">large</option></select></label>`,
            "Pin artifact",
          )}`
        : customize
          ? `<p>No more pinnable artifacts (only ready, owned, non-archived artifacts can be pinned).</p>`
          : ``;
    return `${head}${versionLine}${empty}${customize ? `<h3>Customize mode</h3><p>Reorder and resize with native controls — no drag library, keyboard-only.</p>${pinForm}` : ""}${customizeToggle}</section>`;
  }

  const items = data.tiles
    .map((tile) => {
      const width = TILE_WIDTH[tile.size] ?? "240px";
      if (tile.status === "unavailable") {
        const reason = tile.reason === "deleted" ? "deleted or moved" : tile.reason === "archived" ? "archived" : "has no ready version";
        const label = tile.name ?? "Pinned artifact";
        const remove = customize
          ? layoutForm(
              workspaceId,
              `${hiddenField("action", "unpin")}${hiddenField("artifactId", tile.artifactId)}${hiddenField("expectedVersion", data.layout!.version)}${hiddenField("idempotencyKey", randomUUID())}`,
              "Remove",
            )
          : ``;
        return `<li style="max-width:100%;overflow-wrap:anywhere"><strong>${escapeHtml(label)}</strong> — unavailable (${escapeHtml(reason)}). Nothing runs here; remove the pin or republish the artifact.${remove}</li>`;
      }
      const open = `<a href="/w/${escapeHtml(workspaceId)}/artifacts/${escapeHtml(tile.artifactId)}?tab=preview" ${TAP}>Open</a>`;
      const compact = `<a href="/w/${escapeHtml(workspaceId)}/artifacts/${escapeHtml(tile.artifactId)}/versions/${escapeHtml(tile.activeVersionId!)}/compact" ${TAP}>Compact preview</a>`;
      if (!customize) {
        return `<li style="max-width:100%;overflow-wrap:anywhere"><strong>${escapeHtml(tile.name!)}</strong> (${escapeHtml(tile.size)}) ${open} · ${compact}</li>`;
      }
      const up =
        tile.position > 0
          ? layoutForm(
              workspaceId,
              `${hiddenField("action", "move")}${hiddenField("artifactId", tile.artifactId)}${hiddenField("toPosition", String(tile.position - 1))}${hiddenField("expectedVersion", data.layout!.version)}${hiddenField("idempotencyKey", randomUUID())}`,
              "Move up",
            )
          : ``;
      const down =
        tile.position < data.tiles.length - 1
          ? layoutForm(
              workspaceId,
              `${hiddenField("action", "move")}${hiddenField("artifactId", tile.artifactId)}${hiddenField("toPosition", String(tile.position + 1))}${hiddenField("expectedVersion", data.layout!.version)}${hiddenField("idempotencyKey", randomUUID())}`,
              "Move down",
            )
          : ``;
      const sizeOptions = (["small", "wide", "large"] as const)
        .map((s) => `<option value="${s}"${s === tile.size ? " selected" : ""}>${s}</option>`)
        .join("");
      const sizeForm = layoutForm(
        workspaceId,
        `${hiddenField("action", "size")}${hiddenField("artifactId", tile.artifactId)}${hiddenField("expectedVersion", data.layout!.version)}${hiddenField("idempotencyKey", randomUUID())}<label>Size <select name="size" ${TAP}>${sizeOptions}</select></label>`,
        "Apply size",
      );
      const unpin = layoutForm(
        workspaceId,
        `${hiddenField("action", "unpin")}${hiddenField("artifactId", tile.artifactId)}${hiddenField("expectedVersion", data.layout!.version)}${hiddenField("idempotencyKey", randomUUID())}`,
        "Unpin",
      );
      return `<li style="max-width:${escapeHtml(width)};overflow-wrap:anywhere"><strong>${escapeHtml(tile.name!)}</strong> (${escapeHtml(tile.size)}) ${open} · ${compact}${up}${down}${sizeForm}${unpin}</li>`;
    })
    .join("");
  const pinForm =
    customize && data.pinnable.length > 0
      ? `<h3>Pin an artifact</h3>${layoutForm(
          workspaceId,
          `${hiddenField("action", "pin")}${hiddenField("expectedVersion", data.layout.version)}${hiddenField("idempotencyKey", randomUUID())}<label>Artifact <select name="artifactId" ${TAP}>${data.pinnable.map((p) => `<option value="${escapeHtml(p.artifactId)}">${escapeHtml(p.name)}</option>`).join("")}</select></label> <label>Size <select name="size" ${TAP}><option value="small">small</option><option value="wide">wide</option><option value="large">large</option></select></label>`,
          "Pin artifact",
        )}`
      : ``;
  return `${head}${versionLine}<ol style="max-width:100%">${items}</ol>${customize ? `<h3>Customize mode</h3><p>Saved order — newest pins go last; Move up/down reorders one step. Keyboard: Tab through native controls in tile order.</p>${pinForm}` : ""}${customizeToggle}</section>`;
}

export function renderHomeContent(workspaceId: string, data: HomeData, customize = false): string {
  return `<h2>Home</h2>${workspaceNav(workspaceId)}
<form method="get" action="/w/${escapeHtml(workspaceId)}/home">${customize ? `<input type="hidden" name="customize" value="1">` : ""}<button type="submit" ${TAP}>Refresh</button></form>
${sectionArtifacts(workspaceId, data, customize)}
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
      const customize = query.get("customize") === "1";
      html(res, 200, page({ title: "Home", requestId, authed: true, content: renderHomeContent(workspaceId, data, customize) }));
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

  // E07-S03 layout commands: native-form CAS writes. Success redirects
  // (staying in Customize mode); a version conflict re-renders 409 with the
  // fresh decimal-string version and a prefilled retry form so the second
  // tab's intent is preserved, not silently dropped.
  const layoutMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/home\/layout$/);
  if (layoutMatch && method === "POST") {
    const workspaceId = layoutMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to customize Home.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:workspace");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    if (!homeSameOrigin(req, _config.appBaseUrl)) {
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/home`, requestId, authed: true }));
      return true;
    }
    const claim = resolved.claim;
    let form: URLSearchParams;
    try {
      form = await readLimitedBody(req, 64 * 1024).then((body) => new URLSearchParams(body.toString("utf8")));
    } catch {
      html(res, 400, errorPage({ status: 400, heading: "Layout change failed", message: "Unreadable form body.", back: `/w/${workspaceId}/home?customize=1`, requestId, authed: true }));
      return true;
    }
    const action = form.get("action") ?? "";
    const idempotencyKey = form.get("idempotencyKey") || randomUUID();
    const expectedVersion = form.get("expectedVersion") ?? "";
    const artifactId = form.get("artifactId") ?? "";
    // Per-action payloads: validators reject unknown keys, so each action
    // carries exactly its own fields.
    const raw: Record<string, unknown> =
      action === "pin"
        ? { workspaceId, artifactId, size: form.get("size") ?? undefined, expectedVersion, idempotencyKey }
        : action === "move"
          ? { workspaceId, artifactId, toPosition: form.get("toPosition") ?? "", expectedVersion, idempotencyKey }
          : action === "size"
            ? { workspaceId, artifactId, size: form.get("size") ?? "", expectedVersion, idempotencyKey }
            : { workspaceId, artifactId, expectedVersion, idempotencyKey };
    const back = `/w/${workspaceId}/home?customize=1`;
    try {
      if (action === "pin") await pinTile(pool, claim, claim.userId, raw);
      else if (action === "unpin") await unpinTile(pool, claim, claim.userId, raw);
      else if (action === "move") await moveTile(pool, claim, claim.userId, raw);
      else if (action === "size") await resizeTile(pool, claim, claim.userId, raw);
      else {
        html(res, 400, errorPage({ status: 400, heading: "Layout change failed", message: "Unknown layout action.", back, requestId, authed: true }));
        return true;
      }
      res.writeHead(303, { Location: back });
      res.end();
    } catch (err) {
      if (err instanceof TenantDenied) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      if (err instanceof TxError && err.code === "version_mismatch") {
        // Lost update, not silent overwrite: show the fresh version with a
        // prefilled retry carrying a NEW idempotency key. Retrying from
        // fresh preserves both tabs' intents.
        const retryFields =
          `${hiddenField("action", action)}${hiddenField("expectedVersion", err.currentVersion ?? "1")}${hiddenField("idempotencyKey", randomUUID())}` +
          (typeof raw.artifactId === "string" && raw.artifactId ? hiddenField("artifactId", raw.artifactId) : "") +
          (action === "size" && typeof raw.size === "string" ? hiddenField("size", raw.size) : "") +
          (action === "move" && typeof raw.toPosition === "string" ? hiddenField("toPosition", raw.toPosition) : "") +
          (action === "pin" && typeof raw.size === "string" ? hiddenField("size", raw.size) : "");
        html(
          res,
          409,
          page({
            title: "Home",
            requestId,
            authed: true,
            content: `<h2>Home</h2><div class="alert" role="alert"><h2>Layout changed elsewhere (version ${escapeHtml(err.currentVersion ?? "?")})</h2><p>Another tab saved first. Your change was not applied and nothing was overwritten. Review the current order, then retry.</p><form method="post" action="/w/${escapeHtml(workspaceId)}/home/layout">${retryFields}<button type="submit" ${TAP}>Retry with version ${escapeHtml(err.currentVersion ?? "?")}</button></form><p><a href="${escapeHtml(back)}" ${TAP}>Back to Home (Customize)</a></p></div>`,
          }),
        );
        return true;
      }
      if (err instanceof TxError && err.code === "not_found") {
        html(res, 404, errorPage({ status: 404, heading: "Pin not found", message: "The artifact or pin does not exist here.", back, requestId, authed: true }));
        return true;
      }
      if (err instanceof TxError && (err.code === "limit_exceeded" || err.code === "unsupported_operation" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        const detail = (err.detail as { reason?: string } | undefined)?.reason;
        const message =
          detail === "already_pinned"
            ? "That artifact is already pinned (no duplicate pins)."
            : err.code === "limit_exceeded"
              ? "Home holds at most 12 tiles."
              : detail === "version_not_ready"
                ? "Only ready, owned, non-archived artifacts can be pinned."
                : "That layout change conflicts with the saved state. Reload and retry.";
        html(res, 409, errorPage({ status: 409, heading: "Layout conflict", message, back, requestId, authed: true }));
        return true;
      }
      html(res, 400, errorPage({ status: 400, heading: "Layout change failed", message: "Check the values and retry.", back, requestId, authed: true }));
    }
    return true;
  }

  return false;
}

function homeSameOrigin(req: IncomingMessage, appBaseUrl: string): boolean {
  // Same convention as the UI shell (routes.ts): same-origin fetch metadata
  // wins; otherwise the posted Origin/Referer must match the app origin or
  // the request's own Host (loopback test servers bind ephemeral ports).
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  const allowed = new URL(appBaseUrl).origin;
  const requestOrigins = typeof req.headers.host === "string" ? [`http://${req.headers.host}`, `https://${req.headers.host}`] : [];
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (typeof origin === "string") return origin === allowed || requestOrigins.includes(origin);
  if (typeof referer === "string") return [allowed, ...requestOrigins].some((candidate) => referer === candidate || referer.startsWith(`${candidate}/`));
  return false;
}
