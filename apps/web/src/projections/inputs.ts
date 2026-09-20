// E06-S01 projection input readers (shared by HTTP, and later by the S03
// engine, S04 UI/AI/artifact adapters). Reads never write; tenant scoping
// goes through withTenant plus explicit workspace predicates and FORCE RLS.

import type { Pool, PoolClient } from "pg";
import { classifyLeg } from "../calculations/cash.ts";
import { fingerprintFor, normalizeDescription } from "../recurring.ts";
import { buildWeeklyBaseline, type BaselineWeek } from "./baseline.ts";
import { TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";

export type ProjectionSettingsView = {
  workspaceId: string;
  horizonDays: number;
  baselineWeeks: number;
  safetyFloorMinor: string;
  savingsIncluded: boolean;
  version: string;
  updatedAt: string;
};

export const DEFAULT_SETTINGS: Omit<ProjectionSettingsView, "workspaceId" | "updatedAt"> = {
  horizonDays: 30,
  baselineWeeks: 8,
  safetyFloorMinor: "0",
  savingsIncluded: false,
  version: "0",
};

export type AssumptionView = {
  workspaceId: string;
  id: string;
  assumptionType: string;
  status: "ACTIVE" | "SUPERSEDED" | "ARCHIVED";
  validFrom: string;
  validTo: string | null;
  value: Record<string, unknown>;
  origin: string;
  confidence: string | null;
  supersedesId: string | null;
  version: string;
  createdAt: string;
};

function toAssumptionView(workspaceId: string, row: Record<string, unknown>): AssumptionView {
  return {
    workspaceId,
    id: String(row.id),
    assumptionType: String(row.assumption_type),
    status: row.status as AssumptionView["status"],
    validFrom: String(row.valid_from),
    validTo: row.valid_to === null ? null : String(row.valid_to),
    value: row.value as Record<string, unknown>,
    origin: String(row.origin),
    confidence: row.confidence === null ? null : String(row.confidence),
    supersedesId: row.supersedes_id === null ? null : String(row.supersedes_id),
    version: String(row.version),
    createdAt: String(row.created_at),
  };
}

export async function getProjectionSettings(client: PoolClient, workspaceId: string): Promise<ProjectionSettingsView> {
  const found = await client.query(
    "SELECT workspace_id, horizon_days, baseline_weeks, safety_floor_minor, savings_included, version, updated_at FROM projection_settings WHERE workspace_id = $1",
    [workspaceId],
  );
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { workspaceId, ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() };
  }
  return {
    workspaceId,
    horizonDays: Number(row.horizon_days),
    baselineWeeks: Number(row.baseline_weeks),
    safetyFloorMinor: String(row.safety_floor_minor),
    savingsIncluded: Boolean(row.savings_included),
    version: String(row.version),
    updatedAt: String(row.updated_at),
  };
}

export async function listAssumptions(
  client: PoolClient,
  workspaceId: string,
  status: "ACTIVE" | "SUPERSEDED" | "ARCHIVED" | "ALL" = "ACTIVE",
): Promise<AssumptionView[]> {
  const rows =
    status === "ALL"
      ? await client.query(
          "SELECT id, assumption_type, status, valid_from, valid_to, value, origin, confidence, supersedes_id, version, created_at FROM financial_assumptions WHERE workspace_id = $1 ORDER BY created_at, id",
          [workspaceId],
        )
      : await client.query(
          "SELECT id, assumption_type, status, valid_from, valid_to, value, origin, confidence, supersedes_id, version, created_at FROM financial_assumptions WHERE workspace_id = $1 AND status = $2 ORDER BY created_at, id",
          [workspaceId, status],
        );
  return rows.rows.map((row) => toAssumptionView(workspaceId, row as Record<string, unknown>));
}

export type BaselinePreview = {
  workspaceId: string;
  need: number;
  status: "ok" | "insufficient";
  have: number;
  medianMinor: string | null;
  weeks: { start: string; end: string; complete: boolean; spendMinor: string }[];
  incompleteReasons: { start: string; reason: "current-week" | "pending-review" | "open-import" }[];
  openImportCount: number;
  pendingReviewCount: number;
  bookedRows: number;
};

function isoDay(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/** Past ISO weeks (Monday..Sunday) fully before `today`, oldest first. */
export function pastIsoWeeks(today: string, count: number): { start: string; end: string }[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new TenantInvalid();
  if (!Number.isInteger(count) || count < 1 || count > 52) throw new TenantInvalid();
  const anchor = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime())) throw new TenantInvalid();
  // Monday of the current week, then step back to fully-past weeks.
  const dow = anchor.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = (dow + 6) % 7;
  const thisMonday = new Date(anchor.getTime() - mondayOffset * 86400000);
  const weeks: { start: string; end: string }[] = [];
  for (let i = count; i >= 1; i--) {
    const start = new Date(thisMonday.getTime() - i * 7 * 86400000);
    const end = new Date(start.getTime() + 6 * 86400000);
    weeks.push({ start: isoDay(start), end: isoDay(end) });
  }
  return weeks;
}

/**
 * Weekly variable-spend preview over booked OUTFLOW rows. Excludes transfer
 * legs (shared cash.ts classification over owned accounts), rows matching a
 * confirmed/dismissed recurring fingerprint, and non-OUTFLOW directions.
 * A past week is complete only with zero pending-review links in-week and
 * zero non-terminal imports workspace-wide in the trailing 30 days.
 */
export async function previewBaseline(
  pool: Pool,
  claims: TenantClaims,
  today: string,
): Promise<BaselinePreview> {
  return withTenant(pool, claims, async (client) => {
    const settings = await getProjectionSettings(client, claims.workspaceId);
    const need = settings.baselineWeeks;
    const weeks = pastIsoWeeks(today, need + 1);
    const earliest = weeks[0]!.start;

    const accounts = await client.query("SELECT id FROM accounts WHERE workspace_id = $1 AND archived = FALSE", [claims.workspaceId]);
    const owned = new Set<string>(accounts.rows.map((r: { id: string }) => String(r.id)));

    const booked = await client.query(
      `SELECT id, account_id, amount_minor, currency, direction, effective_date, description FROM transactions WHERE workspace_id = $1 AND effective_date >= $2 AND effective_date < $3
       UNION ALL
       SELECT id, account_id, amount_minor, currency, direction, effective_date, description FROM manual_transactions WHERE workspace_id = $1 AND effective_date >= $2 AND effective_date < $3`,
      [claims.workspaceId, earliest, today],
    );

    const overrides = await client.query(
      "SELECT fingerprint FROM recurring_overrides WHERE workspace_id = $1 AND status IN ('confirmed', 'dismissed')",
      [claims.workspaceId],
    );
    const recurringFps = new Set<string>(overrides.rows.map((r: { fingerprint: string }) => String(r.fingerprint)));

    const pending = await client.query(
      `SELECT t.effective_date AS d FROM source_links s JOIN transactions t ON t.workspace_id = s.workspace_id AND t.id = s.target_transaction_id
       WHERE s.workspace_id = $1 AND s.status = 'PENDING_REVIEW' AND t.effective_date >= $2 AND t.effective_date < $3`,
      [claims.workspaceId, earliest, today],
    );
    const pendingDays = new Set<string>((pending.rows as { d: unknown }[]).map((r) => String(r.d).slice(0, 10)));

    const openImports = await client.query(
      "SELECT COUNT(*)::int AS n FROM imports WHERE workspace_id = $1 AND status IN ('UPLOAD_REGISTERED', 'SCANNING', 'PARSING', 'STAGED') AND created_at >= now() - interval '30 days'",
      [claims.workspaceId],
    );
    const openImportCount = Number((openImports.rows[0] as { n: number }).n);
    const pendingReviewRows = await client.query(
      "SELECT COUNT(*)::int AS n FROM source_links WHERE workspace_id = $1 AND status = 'PENDING_REVIEW'",
      [claims.workspaceId],
    );
    const pendingReviewCount = Number((pendingReviewRows.rows[0] as { n: number }).n);

    const spendByWeek = new Map<string, bigint>();
    const bookedRows = (booked.rows as unknown[]).length;
    for (const row of booked.rows as {
      account_id: string;
      amount_minor: string;
      currency: string;
      direction: string;
      effective_date: unknown;
      description: string;
    }[]) {
      if (row.direction !== "OUTFLOW") continue;
      const day = String(row.effective_date).slice(0, 10);
      const leg = classifyLeg(
        {
          accountId: String(row.account_id),
          amountMinor: BigInt(String(row.amount_minor)),
          currency: String(row.currency),
          direction: "OUTFLOW",
          effectiveDate: day,
          description: row.description,
          source: "imported",
        },
        owned,
      );
      if (leg.classification !== "spend") continue;
      const fp = fingerprintFor(normalizeDescription(row.description), String(row.amount_minor), String(row.currency), "OUTFLOW");
      if (recurringFps.has(fp)) continue;
      const week = weeks.find((w) => day >= w.start && day <= w.end);
      if (!week) continue;
      spendByWeek.set(week.start, (spendByWeek.get(week.start) ?? 0n) + BigInt(String(row.amount_minor)));
    }

    const built: BaselineWeek[] = [];
    const outWeeks: BaselinePreview["weeks"] = [];
    const incompleteReasons: BaselinePreview["incompleteReasons"] = [];
    for (const week of weeks) {
      const reasons: BaselinePreview["incompleteReasons"] = [];
      if (week.end >= today) reasons.push({ start: week.start, reason: "current-week" });
      if (openImportCount > 0) reasons.push({ start: week.start, reason: "open-import" });
      let hasPending = false;
      for (const d of pendingDays) {
        if (d >= week.start && d <= week.end) {
          hasPending = true;
          break;
        }
      }
      if (hasPending) reasons.push({ start: week.start, reason: "pending-review" });
      const complete = reasons.length === 0;
      const spend = spendByWeek.get(week.start) ?? 0n;
      built.push({ start: week.start, complete, spendMinor: spend });
      outWeeks.push({ start: week.start, end: week.end, complete, spendMinor: spend.toString() });
      incompleteReasons.push(...reasons);
    }

    // No booked history at all is missing coverage, never a zero-spend
    // baseline: force insufficient even when every week is trivially
    // "complete". Genuine zero spend with booked rows present stays data.
    const result = bookedRows === 0
      ? { status: "insufficient" as const, have: 0, medianMinor: null as bigint | null }
      : buildWeeklyBaseline(built, need);
    return {
      workspaceId: claims.workspaceId,
      need,
      status: result.status,
      have: result.have,
      medianMinor: result.medianMinor === null ? null : result.medianMinor.toString(),
      weeks: outWeeks,
      incompleteReasons,
      openImportCount,
      pendingReviewCount,
      bookedRows,
    };
  });
}
