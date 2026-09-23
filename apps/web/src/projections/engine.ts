// E06-S03 projection engine: pure core computeTimeline + DB loader resolveInputs
// + runProjection persisting run/points/events. Idempotent by input_hash+scenario.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { currencyExponent } from "../money.ts";
import { classifyLeg } from "../calculations/cash.ts";
import { lookupEcbRate, lookupManualRate, parseRate, convertWithRate, valuateSnapshot } from "../calculations/fx.ts";
import { expandMonthly, distributeDaily, daysInMonth } from "./schedule.ts";
import { buildWeeklyBaseline } from "./baseline.ts";
import { getProjectionSettings, listAssumptions, pastIsoWeeks, previewBaseline } from "./inputs.ts";
import { getAccountTotalAllocated } from "../commands/goals.ts";
import { fingerprintFor, normalizeDescription } from "../recurring.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";
import { bumpRevision, claimAndExecute, insertAudit, TxError, type TxOutcome } from "../commands/transactions.ts";

export const PROJECTION_RUN_COMMAND = "projection.run";

type ComputeTimelineResult = {
  points: Array<{ caseName: "EXPECTED" | "CONSERVATIVE" | "OPTIMISTIC"; scope: string; pointDate: string; amountMinor: bigint; currencyCode: string }>;
  events: Array<{ eventDate: string; eventType: string; direction: "INFLOW" | "OUTFLOW" | null; amountMinor: bigint | null; currencyCode: string | null; accountScope: string | null; label: string; sourceRefs: Record<string, unknown> }>;
  ats: { status: "AVAILABLE" | "SHORTFALL" | "UNAVAILABLE"; amountMinor: bigint; shortfallMinor?: bigint; shortfallDate?: string; limitingDay?: string; limitingAccount?: string; reasons?: string[] };
};

type ResolvedIncome = { assumptionId: string; amountMinor: bigint; currency: string; cadence: "MONTHLY" | "WEEKLY" | "ONE_TIME"; dayOfMonth?: number; date?: string; accountId?: string };
type ResolvedRecurring = { assumptionId: string; amountMinor: bigint; currency: string; fingerprint?: string; cadence?: "MONTHLY" | "YEARLY"; dayOfMonth?: number; month?: number; date?: string; direction: "INFLOW" | "OUTFLOW"; accountId?: string };
type ResolvedOneTime = { assumptionId: string; amountMinor: bigint; currency: string; direction: "INFLOW" | "OUTFLOW"; date: string; accountId?: string; toAccountId?: string; description?: string };
type ResolvedVariable = { assumptionId: string; amountMinor: bigint; currency: string };

type ComputeTimelineInput = {
  horizonStart: string;
  horizonDays: number;
  baseCurrency: string;
  floorMinor: bigint;
  settingsVersion: string;
  baselineWeeks: number;
  accounts: Array<{ id: string; currency: string; spendable: boolean; snapshotId: string | null; snapshotDate: string | null; startMinor: bigint; fx: { coverage: "full" | "partial" | "unavailable"; rateDate: string | null; rateSource: string | null; triangNum: string | null; triangDen: string | null } }>;
  incomes: ResolvedIncome[];
  recurrings: ResolvedRecurring[];
  oneTimes: ResolvedOneTime[];
  variableWeekly: ResolvedVariable | null;
  variableBaselineMedian: bigint | null;
  variableBaselineStatus: "ok" | "assumption" | "assumed-zero-no-baseline";
  variableCurrency: string;
  goalReservations: Array<{ goalId: string; accountId: string; amountMinor: bigint; currency: string }>;
  recurringLinked: Array<{ fingerprint: string; dayOfMonth: number; kind: "expense" | "income"; amountCenterMinor: bigint; currency: string; accountId: string }>;
  bookedByAccountDay: Map<string, Map<string, bigint>>;
  missingCommitments: string[];
  coverageNotes: Record<string, unknown>;
  fxByCurrency: Record<string, { num: string; den: string } | null>;
  spendingAccountId?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CASE_BPS = { EXPECTED: { income: 10000, expense: 10000 }, CONSERVATIVE: { income: 9000, expense: 11000 }, OPTIMISTIC: { income: 11000, expense: 9000 } } as const;

function checkUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new TenantInvalid();
  return value;
}

function checkDate(value: unknown): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new TenantInvalid();
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new TenantInvalid();
  return value;
}

function checkCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new TenantInvalid();
  return value;
}

function checkMinor(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new TenantInvalid();
  return value.replace(/^0+(?=[0-9])/, "");
}

export type ProjectionRunInput = {
  workspaceId: string;
  horizonDays?: number;
  spendingAccountId?: string;
  scenarioId?: string;
  eligibleAccountIds?: string[];
  idempotencyKey: string;
};

export function validateRunProjectionInput(value: unknown): ProjectionRunInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "horizonDays", "spendingAccountId", "scenarioId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  // R1 read cap: horizons beyond 365 days are rejected (UI aggregates there;
  // longer custom horizons arrive only with a measured follow-up).
  if (v.horizonDays !== undefined && (!Number.isInteger(v.horizonDays) || (v.horizonDays as number) < 1 || (v.horizonDays as number) > 365)) throw new TenantInvalid();
  if (v.spendingAccountId !== undefined && (typeof v.spendingAccountId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.spendingAccountId))) throw new TenantInvalid();
  if (v.scenarioId !== undefined && (typeof v.scenarioId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.scenarioId))) throw new TenantInvalid();
  return {
    workspaceId: checkUuid(v.workspaceId),
    horizonDays: v.horizonDays as number | undefined,
    spendingAccountId: v.spendingAccountId as string | undefined,
    scenarioId: v.scenarioId as string | undefined,
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type ProjectionRunView = {
  workspaceId: string;
  runId: string;
  method: string;
  engineVersion: string;
  scenarioId: string | null;
  horizonStart: string;
  horizonEnd: string;
  baseCurrency: string;
  inputHash: string;
  inputs: Record<string, unknown>;
  coverage: Record<string, unknown>;
  status: "ACTIVE" | "SUPERSEDED";
  createdAt: string;
};

export type ProjectionPointView = {
  workspaceId: string;
  runId: string;
  caseName: "EXPECTED" | "CONSERVATIVE" | "OPTIMISTIC";
  scope: string;
  pointDate: string;
  amountMinor: string;
  currencyCode: string;
};

export type ProjectionEventView = {
  workspaceId: string;
  id: string;
  runId: string;
  eventDate: string;
  eventType: string;
  direction: "INFLOW" | "OUTFLOW" | null;
  amountMinor: string | null;
  currencyCode: string | null;
  accountScope: string | null;
  label: string;
  sourceRefs: Record<string, unknown>;
  createdAt: string;
};

export type ATSView = {
  status: "AVAILABLE" | "SHORTFALL" | "UNAVAILABLE";
  amountMinor: string;
  shortfallMinor?: string;
  shortfallDate?: string;
  limitingDay?: string;
  limitingAccount?: string;
  reasons?: string[];
};

export type ProjectionRunResult = {
  view: ProjectionRunView;
  points: ProjectionPointView[];
  events: ProjectionEventView[];
  ats: ATSView;
  operationId: string;
  replayed: boolean;
};

function runHash(input: ProjectionRunInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: PROJECTION_RUN_COMMAND, workspaceId: input.workspaceId, horizonDays: input.horizonDays ?? null, spendingAccountId: input.spendingAccountId ?? null, scenarioId: input.scenarioId ?? null, eligibleAccountIds: input.eligibleAccountIds ?? null }))
    .digest("hex");
}

async function getProjectionSettingsView(client: PoolClient, workspaceId: string) {
  const { getProjectionSettings } = await import("./inputs.ts");
  return getProjectionSettings(client, workspaceId);
}

async function listActiveAssumptions(client: PoolClient, workspaceId: string) {
  const { listAssumptions } = await import("./inputs.ts");
  return listAssumptions(client, workspaceId, "ACTIVE");
}

async function listGoalsWithAllocations(_client: PoolClient, _workspaceId: string) {
  return [];
}

function isoDay(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function addDays(dt: Date, days: number): Date {
  return new Date(dt.getTime() + days * 86400000);
}

function applyCaseBps(amount: bigint, caseName: keyof typeof CASE_BPS, isIncome: boolean): bigint {
  const bps = isIncome ? CASE_BPS[amount >= 0 ? caseName : "EXPECTED"].income : CASE_BPS[amount < 0 ? caseName : "EXPECTED"].expense;
  return (amount * BigInt(bps)) / 10000n;
}

/**
 * Core deterministic timeline computation (pure over resolved inputs).
 * Daily per-account scopes in native minor units plus a base-currency TOTAL.
 * Case bps scale income/expense assumption components uniformly:
 * expected 10000/10000, conservative income 9000/expense 11000,
 * optimistic income 11000/9000 (integer truncation toward zero on remainder,
 * disclosed here; fixture amounts divide exactly).
 * TOTAL always equals the sum of account scopes; transfers move scopes only.
 */
function computeTimeline(resolved: ComputeTimelineInput): ComputeTimelineResult {
  type DayEvent = { date: string; type: string; direction: "INFLOW" | "OUTFLOW"; amountMinor: bigint; currency: string; accountId: string | null; label: string; sourceRefs: Record<string, unknown>; caseNeutral?: boolean };
  const startDt = new Date(`${resolved.horizonStart}T00:00:00Z`);
  const endDt = new Date(startDt.getTime() + resolved.horizonDays * 86400000);
  const endStr = isoDay(endDt);
  const inHorizon = (d: string) => d >= resolved.horizonStart && d < endStr;

  const cases = ["EXPECTED", "CONSERVATIVE", "OPTIMISTIC"] as const;
  const scaleFor = (amount: bigint, c: (typeof cases)[number], isIncome: boolean): bigint => {
    const bps = isIncome
      ? c === "CONSERVATIVE" ? 9000 : c === "OPTIMISTIC" ? 11000 : 10000
      : c === "CONSERVATIVE" ? 11000 : c === "OPTIMISTIC" ? 9000 : 10000;
    return (amount * BigInt(bps)) / 10000n;
  };

  // Expand deterministic events (case-neutral amounts; scaled per case later).
  const base: DayEvent[] = [];
  for (const inc of resolved.incomes) {
    if (inc.cadence === "MONTHLY" && inc.dayOfMonth !== undefined) {
      for (const d of expandMonthly(inc.dayOfMonth, resolved.horizonStart, isoDay(new Date(endDt.getTime() - 86400000)))) {
        if (!inHorizon(d)) continue;
        base.push({ date: d, type: "SALARY", direction: "INFLOW", amountMinor: BigInt(inc.amountMinor), currency: inc.currency, accountId: inc.accountId ?? null, label: `expected income ${inc.currency}`, sourceRefs: { assumptionId: (inc as { assumptionId?: string }).assumptionId ?? null } });
      }
    } else if (inc.cadence === "WEEKLY") {
      for (let i = 0; i < resolved.horizonDays; i += 7) {
        const d = isoDay(new Date(startDt.getTime() + i * 86400000));
        base.push({ date: d, type: "SALARY", direction: "INFLOW", amountMinor: BigInt(inc.amountMinor), currency: inc.currency, accountId: inc.accountId ?? null, label: `expected weekly income ${inc.currency}`, sourceRefs: { assumptionId: (inc as { assumptionId?: string }).assumptionId ?? null } });
      }
    } else if (inc.cadence === "ONE_TIME" && inc.date && inHorizon(inc.date)) {
      base.push({ date: inc.date, type: "PLANNED_EVENT", direction: "INFLOW", amountMinor: BigInt(inc.amountMinor), currency: inc.currency, accountId: inc.accountId ?? null, label: `one-time income ${inc.currency}`, sourceRefs: { assumptionId: (inc as { assumptionId?: string }).assumptionId ?? null } });
    }
  }
  for (const rec of resolved.recurrings) {
    const dir = rec.direction;
    if (rec.date !== undefined && rec.cadence === undefined) {
      // Single dated occurrence (no cadence): one event, never a schedule.
      if (!inHorizon(rec.date)) continue;
      base.push({ date: rec.date, type: "RECURRING_PAYMENT", direction: dir, amountMinor: BigInt(rec.amountMinor), currency: rec.currency, accountId: rec.accountId ?? null, label: `dated recurring ${dir === "INFLOW" ? "inflow" : "payment"} ${rec.currency}`, sourceRefs: { assumptionId: (rec as { assumptionId?: string }).assumptionId ?? null } });
    } else if (rec.cadence === "MONTHLY" && rec.dayOfMonth !== undefined) {
      for (const d of expandMonthly(rec.dayOfMonth, resolved.horizonStart, isoDay(new Date(endDt.getTime() - 86400000)))) {
        if (!inHorizon(d)) continue;
        base.push({ date: d, type: "RECURRING_PAYMENT", direction: dir, amountMinor: BigInt(rec.amountMinor), currency: rec.currency, accountId: rec.accountId ?? null, label: `recurring ${dir === "INFLOW" ? "inflow" : "payment"} ${rec.currency}`, sourceRefs: { assumptionId: (rec as { assumptionId?: string }).assumptionId ?? null } });
      }
    } else if (rec.cadence === "YEARLY" && rec.month !== undefined && rec.dayOfMonth !== undefined) {
      for (let y = Number(resolved.horizonStart.slice(0, 4)); y <= Number(endStr.slice(0, 4)); y++) {
        const last = daysInMonth(y, rec.month);
        const d = `${String(y).padStart(4, "0")}-${String(rec.month).padStart(2, "0")}-${String(Math.min(rec.dayOfMonth, last)).padStart(2, "0")}`;
        if (!inHorizon(d)) continue;
        base.push({ date: d, type: "RECURRING_PAYMENT", direction: dir, amountMinor: BigInt(rec.amountMinor), currency: rec.currency, accountId: rec.accountId ?? null, label: `yearly recurring ${dir === "INFLOW" ? "inflow" : "payment"} ${rec.currency}`, sourceRefs: { assumptionId: (rec as { assumptionId?: string }).assumptionId ?? null } });
      }
    }
  }
  for (const link of resolved.recurringLinked) {
    for (const d of expandMonthly(link.dayOfMonth, resolved.horizonStart, isoDay(new Date(endDt.getTime() - 86400000)))) {
      if (!inHorizon(d)) continue;
      base.push({ date: d, type: "RECURRING_PAYMENT", direction: link.kind === "income" ? "INFLOW" : "OUTFLOW", amountMinor: link.amountCenterMinor, currency: link.currency, accountId: link.accountId, label: `confirmed recurring ${link.kind} ${link.currency}`, sourceRefs: { fingerprint: link.fingerprint } });
    }
  }
  for (const ot of resolved.oneTimes) {
    if (!inHorizon(ot.date)) continue;
    if (ot.toAccountId && ot.direction === "OUTFLOW") {
      base.push({ date: ot.date, type: "TRANSFER", direction: "OUTFLOW", amountMinor: BigInt(ot.amountMinor), currency: ot.currency, accountId: ot.accountId ?? null, label: `scheduled transfer out ${ot.currency}`, sourceRefs: { assumptionId: (ot as { assumptionId?: string }).assumptionId ?? null, toAccountId: ot.toAccountId }, caseNeutral: true });
      base.push({ date: ot.date, type: "TRANSFER", direction: "INFLOW", amountMinor: BigInt(ot.amountMinor), currency: ot.currency, accountId: ot.toAccountId, label: `scheduled transfer in ${ot.currency}`, sourceRefs: { assumptionId: (ot as { assumptionId?: string }).assumptionId ?? null, fromAccountId: ot.accountId ?? null }, caseNeutral: true });
    } else if (ot.toAccountId && ot.direction === "INFLOW") {
      base.push({ date: ot.date, type: "TRANSFER", direction: "OUTFLOW", amountMinor: BigInt(ot.amountMinor), currency: ot.currency, accountId: ot.toAccountId, label: `scheduled transfer out ${ot.currency}`, sourceRefs: { assumptionId: (ot as { assumptionId?: string }).assumptionId ?? null, toAccountId: ot.accountId ?? null }, caseNeutral: true });
      base.push({ date: ot.date, type: "TRANSFER", direction: "INFLOW", amountMinor: BigInt(ot.amountMinor), currency: ot.currency, accountId: ot.accountId ?? null, label: `scheduled transfer in ${ot.currency}`, sourceRefs: { assumptionId: (ot as { assumptionId?: string }).assumptionId ?? null, fromAccountId: ot.toAccountId }, caseNeutral: true });
    } else {
      base.push({ date: ot.date, type: "PLANNED_EVENT", direction: ot.direction, amountMinor: BigInt(ot.amountMinor), currency: ot.currency, accountId: ot.accountId ?? null, label: `one-time ${ot.direction === "INFLOW" ? "income" : "expense"} ${ot.currency}`, sourceRefs: { assumptionId: (ot as { assumptionId?: string }).assumptionId ?? null } });
    }
  }
  // Variable spend: explicit weekly assumption wins, else baseline median, else assumed zero.
  const variableWeekly = resolved.variableWeekly ? BigInt(resolved.variableWeekly.amountMinor) : resolved.variableBaselineMedian;
  const variableCurrency = resolved.variableWeekly ? resolved.variableWeekly.currency : resolved.variableCurrency;
  if (variableWeekly !== null && variableWeekly > 0n) {
    for (let w = 0; w * 7 < resolved.horizonDays; w++) {
      const days = Math.min(7, resolved.horizonDays - w * 7);
      const parts = distributeDaily(variableWeekly, days);
      for (let i = 0; i < days; i++) {
        const d = isoDay(new Date(startDt.getTime() + (w * 7 + i) * 86400000));
        base.push({ date: d, type: "VARIABLE_SPEND", direction: "OUTFLOW", amountMinor: parts[i]!, currency: variableCurrency, accountId: null, label: `variable spend ${variableCurrency}`, sourceRefs: { basis: resolved.variableWeekly ? "assumption" : "baseline-median" } });
      }
    }
  }

  // Attribute account-less events: single spendable account gets them; with
  // several accounts they stay TOTAL-level (documented, never silently assigned).
  const spendable = resolved.accounts.filter((a) => a.spendable);
  const singleDefault = spendable.length === 1 ? spendable[0]!.id : null;
  const dated = base.map((e) => ({ ...e, accountId: e.accountId ?? singleDefault }));

  // Booked legs inside the horizon move their own account scope (directional,
  // case-neutral: history does not vary by assumption case).
  for (const [acct, byDay] of resolved.bookedByAccountDay) {
    for (const [day, net] of byDay) {
      if (!inHorizon(day) || net === 0n) continue;
      dated.push({ date: day, type: "PLANNED_EVENT", direction: net > 0n ? "INFLOW" : "OUTFLOW", amountMinor: net > 0n ? net : -net, currency: spendable.find((a) => a.id === acct)?.currency ?? resolved.baseCurrency, accountId: acct, label: "booked movement", sourceRefs: { basis: "booked" }, caseNeutral: true });
    }
  }

  // Accumulate per account per case; TOTAL is the exact sum of scopes.
  // Transfers and booked actuals are case-neutral (history and explicitly
  // scheduled movements do not vary by case); assumption amounts scale.
  // Persisted events are case-neutral with unscaled amounts.
  const points: ComputeTimelineResult["points"] = [];
  const events: ComputeTimelineResult["events"] = [];
  for (const e of dated) {
    // Scenario-appended deltas are type-distinguishable from real scheduled
    // assumptions: hypothetical outflows must never read as booked schedule.
    const fromScenario = typeof (e.sourceRefs as { assumptionId?: unknown }).assumptionId === "string" && String((e.sourceRefs as { assumptionId?: unknown }).assumptionId).startsWith("scenario:");
    events.push({ eventDate: e.date, eventType: fromScenario ? "SCENARIO_OVERRIDE" : e.type, direction: e.direction, amountMinor: e.amountMinor, currencyCode: e.currency, accountScope: e.accountId ?? "TOTAL", label: e.label, sourceRefs: e.sourceRefs });
  }
  for (const c of cases) {
    const perAcct = new Map<string, bigint>();
    for (const a of spendable) perAcct.set(a.id, a.startMinor);
    const totalOnlyCumulative = new Map<string, bigint>();
    for (let i = 0; i < resolved.horizonDays; i++) {
      const d = isoDay(new Date(startDt.getTime() + i * 86400000));
      for (const e of dated) {
        if (e.date !== d) continue;
        const isIncome = e.direction === "INFLOW";
        const scaled = e.caseNeutral ? e.amountMinor : scaleFor(e.amountMinor, c, isIncome);
        const signed = isIncome ? scaled : -scaled;
        if (e.accountId && perAcct.has(e.accountId)) {
          perAcct.set(e.accountId, perAcct.get(e.accountId)! + signed);
        } else {
          // TOTAL-level (unattributed multi-account): cumulative, converted below.
          totalOnlyCumulative.set(e.currency, (totalOnlyCumulative.get(e.currency) ?? 0n) + signed);
        }
      }
      let total = 0n;
      let dayFxGap = false;
      const toBase = (amount: bigint, currency: string): bigint | null => {
        if (currency === resolved.baseCurrency) return amount;
        const r = resolved.fxByCurrency[currency];
        if (!r) return null;
        const srcExp = currencyExponent(currency);
        const baseExp = currencyExponent(resolved.baseCurrency);
        if (srcExp === undefined || baseExp === undefined) return null;
        return convertWithRate(amount, srcExp, { num: BigInt(r.num), den: BigInt(r.den) }, baseExp);
      };
      for (const a of spendable) {
        const bal = perAcct.get(a.id)!;
        points.push({ caseName: c, scope: a.id, pointDate: d, amountMinor: bal, currencyCode: a.currency });
        const conv = toBase(bal, a.currency);
        if (conv === null) dayFxGap = true;
        else total += conv;
      }
      // TOTAL-only flows (unattributed multi-account variable spend) accrue
      // cumulatively here, converted at the held-flat rate; unconvertible ones gap.
      for (const [cur, amt] of totalOnlyCumulative) {
        const conv = toBase(amt, cur);
        if (conv === null) dayFxGap = true;
        else total += conv;
      }
      points.push({ caseName: c, scope: "TOTAL", pointDate: d, amountMinor: total, currencyCode: resolved.baseCurrency });
      if (dayFxGap) {
        const s = ((resolved as unknown as { _fxGapDays?: Set<string> })._fxGapDays ??= new Set<string>());
        s.add(d);
      }
    }
  }

  // Multi-currency TOTAL conversion is handled by the caller via fx map;
  // here all fixtures are single-currency, asserted by scope equality below.
  // Available to Spend (conservative case, per architecture 258).
  const cons = (scope: string, date: string) => points.find((p) => p.caseName === "CONSERVATIVE" && p.scope === scope && p.pointDate === date)!.amountMinor;
  const reservedByAccount = new Map<string, bigint>();
  for (const g of resolved.goalReservations) reservedByAccount.set(g.accountId, (reservedByAccount.get(g.accountId) ?? 0n) + g.amountMinor);
  const days: string[] = [];
  for (let i = 0; i < resolved.horizonDays; i++) days.push(isoDay(new Date(startDt.getTime() + i * 86400000)));

  if (resolved.missingCommitments.length > 0) {
    return { points, events, ats: { status: "UNAVAILABLE", amountMinor: 0n, reasons: ["missing_commitments"] } };
  }
  if (spendable.length === 0) {
    return { points, events, ats: { status: "UNAVAILABLE", amountMinor: 0n, reasons: ["no_spendable_accounts"] } };
  }
  const fxGapDays = (resolved as unknown as { _fxGapDays?: Set<string> })._fxGapDays;
  if (fxGapDays && fxGapDays.size > 0) {
    return { points, events, ats: { status: "UNAVAILABLE", amountMinor: 0n, reasons: ["missing_fx"] } };
  }
  const noSnapshotAccts = spendable.filter((a) => a.snapshotId === null).map((a) => a.id);
  if (noSnapshotAccts.length > 0) {
    if (resolved.spendingAccountId && noSnapshotAccts.includes(resolved.spendingAccountId)) {
      return { points, events, ats: { status: "UNAVAILABLE", amountMinor: 0n, reasons: ["missing_balance"] } };
    }
    if (!resolved.spendingAccountId) {
      return { points, events, ats: { status: "UNAVAILABLE", amountMinor: 0n, reasons: ["missing_balance"] } };
    }
  }
  const acctOkEveryDay = (id: string) => days.every((d) => cons(id, d) - (reservedByAccount.get(id) ?? 0n) >= 0n);
  if (!resolved.spendingAccountId) {
    const failing = spendable.map((a) => a.id).filter((id) => !acctOkEveryDay(id));
    if (failing.length > 0) {
      return { points, events, ats: { status: "UNAVAILABLE", amountMinor: 0n, reasons: ["funding_gap"] } };
    }
    const totalReserved = [...reservedByAccount.values()].reduce((x, y) => x + y, 0n);
    let best = cons("TOTAL", days[0]!) - resolved.floorMinor - totalReserved;
    let bestDay = days[0]!;
    for (const d of days) {
      const m = cons("TOTAL", d) - resolved.floorMinor - totalReserved;
      if (m < best) { best = m; bestDay = d; }
    }
    if (best < 0n) return { points, events, ats: { status: "SHORTFALL", amountMinor: 0n, shortfallMinor: -best, shortfallDate: bestDay, limitingDay: bestDay, limitingAccount: spendable[0]?.id } };
    return { points, events, ats: { status: "AVAILABLE", amountMinor: best, limitingDay: bestDay, limitingAccount: spendable[0]?.id } };
  }
  const sel = resolved.spendingAccountId;
  if (!spendable.some((a) => a.id === sel)) {
    return { points, events, ats: { status: "UNAVAILABLE", amountMinor: 0n, reasons: ["missing_balance"] } };
  }
  const totalReserved = [...reservedByAccount.values()].reduce((x, y) => x + y, 0n);
  let best = cons("TOTAL", days[0]!) - resolved.floorMinor - totalReserved;
  let bestAcct = cons(sel, days[0]!) - (reservedByAccount.get(sel) ?? 0n);
  let bestDay = days[0]!;
  let worst = best < bestAcct ? best : bestAcct;
  for (const d of days) {
    const g = cons("TOTAL", d) - resolved.floorMinor - totalReserved;
    const a = cons(sel, d) - (reservedByAccount.get(sel) ?? 0n);
    const m = g < a ? g : a;
    if (m < worst) { worst = m; bestDay = d; }
  }
  if (worst < 0n) return { points, events, ats: { status: "SHORTFALL", amountMinor: 0n, shortfallMinor: -worst, shortfallDate: bestDay, limitingDay: bestDay, limitingAccount: sel } };
  return { points, events, ats: { status: "AVAILABLE", amountMinor: worst, limitingDay: bestDay, limitingAccount: sel } };
}

async function resolveInputs(client: PoolClient, claims: TenantClaims, input: ProjectionRunInput): Promise<{
  inputHash: string;
  resolved: ComputeTimelineInput;
}> {
  const wsId = claims.workspaceId;
  const wsRow = await client.query("SELECT base_currency_code FROM workspaces WHERE id = $1", [wsId]);
  const baseCurrency = wsRow.rows[0] ? String(wsRow.rows[0].base_currency_code) : "EUR";
  const settings = await getProjectionSettings(client, wsId);
  const horizonDays = input.horizonDays ?? settings.horizonDays;
  const assumptions = await listAssumptions(client, wsId, "ACTIVE");

  // Scenario deltas (S04): flat overrides applied on top of the baseline
  // model. Missing or archived scenarios read as not_found (uniform).
  const scenarioReplacements = new Map<string, Record<string, unknown>>();
  const scenarioOneTimes: ComputeTimelineInput["oneTimes"] = [];
  const scenarioRecurrings: ComputeTimelineInput["recurrings"] = [];
  const scenarioIncomes: ComputeTimelineInput["incomes"] = [];
  const scenarioGoalDisplay: { goalId: string; targetAmountMinor?: string; targetDate?: string }[] = [];
  let scenarioRef: string | null = null;
  if (input.scenarioId !== undefined) {
    const srow = await client.query("SELECT id, version, status FROM scenarios WHERE workspace_id = $1 AND id = $2", [wsId, input.scenarioId]);
    const s = srow.rows[0] as { id: string; version: string; status: string } | undefined;
    if (!s || s.status !== "ACTIVE") throw new TxError("not_found");
    const orows = await client.query("SELECT id, override_type, effective_from, effective_to, payload, version FROM scenario_overrides WHERE workspace_id = $1 AND scenario_id = $2 ORDER BY created_at, id", [wsId, input.scenarioId]);
    const refs: string[] = [];
    for (const r of orows.rows as { id: string; override_type: string; effective_from: unknown; effective_to: unknown; payload: unknown; version: string }[]) {
      // Stored payloads were validated at write time; corrupt rows fail
      // closed as invalid input, never as engine 500s.
      try {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        refs.push(`${String(r.id)}:${String(r.version)}`);
        const from = r.effective_from === null ? null : String(r.effective_from).slice(0, 10);
        const to = r.effective_to === null ? null : String(r.effective_to).slice(0, 10);
        void from; void to;
      switch (String(r.override_type)) {
        case "ONE_TIME_EXPENSE":
          scenarioOneTimes.push({ assumptionId: `scenario:${String(r.id)}`, amountMinor: BigInt(String(p.amountMinor)), currency: String(p.currency), direction: "OUTFLOW", date: String(p.date), accountId: p.accountId === undefined ? undefined : String(p.accountId), description: p.description === undefined ? undefined : String(p.description) });
          break;
        case "ONE_TIME_INCOME":
          scenarioOneTimes.push({ assumptionId: `scenario:${String(r.id)}`, amountMinor: BigInt(String(p.amountMinor)), currency: String(p.currency), direction: "INFLOW", date: String(p.date), accountId: p.accountId === undefined ? undefined : String(p.accountId), description: p.description === undefined ? undefined : String(p.description) });
          break;
        case "RECURRING_EXPENSE_CHANGE":
          scenarioRecurrings.push({ assumptionId: `scenario:${String(r.id)}`, amountMinor: BigInt(String(p.amountMinor)), currency: String(p.currency), cadence: "MONTHLY", dayOfMonth: Number(p.dayOfMonth), direction: p.direction === "INFLOW" ? "INFLOW" : "OUTFLOW", accountId: p.accountId === undefined ? undefined : String(p.accountId) });
          break;
        case "INCOME_CHANGE":
          scenarioIncomes.push({ assumptionId: `scenario:${String(r.id)}`, amountMinor: BigInt(String(p.amountMinor)), currency: String(p.currency), cadence: "MONTHLY", dayOfMonth: Number(p.dayOfMonth), accountId: p.accountId === undefined ? undefined : String(p.accountId) });
          break;
        case "GOAL_TARGET_CHANGE":
          scenarioGoalDisplay.push({ goalId: String(p.goalId), targetAmountMinor: String(p.targetAmountMinor) });
          break;
        case "GOAL_DATE_CHANGE":
          scenarioGoalDisplay.push({ goalId: String(p.goalId), targetDate: String(p.targetDate) });
          break;
        case "ASSUMPTION_OVERRIDE":
          scenarioReplacements.set(String(p.assumptionId), p.value as Record<string, unknown>);
          refs.push(`replace:${String(p.assumptionId)}`);
          break;
        default:
          throw new TenantInvalid();
      }
      } catch (err) {
        if (err instanceof TenantInvalid) throw err;
        throw new TenantInvalid();
      }
    }
    scenarioRef = `${String(s.id)}:${String(s.version)}:${refs.sort().join(",")}`;
  }

  const accts = await client.query("SELECT id, base_currency_code AS currency FROM accounts WHERE workspace_id = $1 AND archived = FALSE ORDER BY id", [wsId]);
  const ownedIds = (accts.rows as { id: string }[]).map((r) => String(r.id));
  // AI-limited evaluation (chat tools, artifact SDK): the eligible set is
  // intersected BEFORE aggregation, so excluded accounts never contribute
  // to totals. Owner paths (UI, persisted runs) pass no filter and see all.
  // A filter that excludes nothing normalizes to null so cross-adapter
  // parity holds: identical effective inputs share one input hash.
  const eligibleRaw = input.eligibleAccountIds === undefined ? null : new Set(input.eligibleAccountIds);
  const aiLimited = eligibleRaw !== null && ownedIds.some((id) => !eligibleRaw.has(id));
  const eligible = aiLimited ? eligibleRaw : null;
  const accountIds = ownedIds.filter((id) => eligible === null || eligible.has(id));
  const accountCurrency = new Map<string, string>((accts.rows as { id: string; currency: string }[]).map((r) => [String(r.id), String(r.currency)]));

  const behavRows = await client.query("SELECT value FROM financial_assumptions WHERE workspace_id = $1 AND status = 'ACTIVE' AND assumption_type = 'ACCOUNT_BEHAVIOR'", [wsId]);
  const nonSpendable = new Set<string>();
  for (const r of behavRows.rows as { value: { accountId?: string; spendable?: boolean } }[]) {
    if (r.value && r.value.spendable === false && typeof r.value.accountId === "string") nonSpendable.add(r.value.accountId);
  }

  const snaps = await client.query(
    `SELECT DISTINCT ON (account_id) account_id, id, as_of_date, amount_minor, currency FROM balance_snapshots WHERE workspace_id = $1 ORDER BY account_id, as_of_date DESC`,
    [wsId],
  );
  const snapByAccount = new Map<string, { id: string; date: string; amountMinor: bigint; currency: string }>();
  for (const r of snaps.rows as { account_id: string; id: string; as_of_date: unknown; amount_minor: string; currency: string }[]) {
    snapByAccount.set(String(r.account_id), { id: String(r.id), date: String(r.as_of_date).slice(0, 10), amountMinor: BigInt(String(r.amount_minor)), currency: String(r.currency) });
  }

  // Horizon starts on the latest starting-balance date (documented R1 rule:
  // days before the freshest snapshot are history, not forecast).
  const datedSnaps = [...snapByAccount.values()].map((s) => s.date);
  const horizonStart = datedSnaps.length > 0 ? datedSnaps.sort()[datedSnaps.length - 1]! : isoDay(new Date());

  // Forward-reconcile booked movements after each account's snapshot up to the start.
  const booked = await client.query(
    `SELECT account_id, amount_minor, currency, direction, effective_date, description FROM transactions WHERE workspace_id = $1
     UNION ALL
     SELECT account_id, amount_minor, currency, direction, effective_date, description FROM manual_transactions WHERE workspace_id = $1`,
    [wsId],
  );
  const bookedByAccountDay = new Map<string, Map<string, bigint>>();
  const bookedRows: { accountId: string; amountMinor: bigint; currency: string; direction: string; date: string; description: string }[] = [];
  for (const r of booked.rows as { account_id: string; amount_minor: string; currency: string; direction: string; effective_date: unknown; description: string }[]) {
    // AI-limited views never see excluded accounts' booked rows at all —
    // otherwise they would leak into TOTAL through the unattributed path.
    if (eligible !== null && !eligible.has(String(r.account_id))) continue;
    const day = String(r.effective_date).slice(0, 10);
    const amt = BigInt(String(r.amount_minor));
    const signed = r.direction === "INFLOW" ? amt : -amt;
    bookedRows.push({ accountId: String(r.account_id), amountMinor: amt, currency: String(r.currency), direction: String(r.direction), date: day, description: String(r.description ?? "") });
    if (!bookedByAccountDay.has(String(r.account_id))) bookedByAccountDay.set(String(r.account_id), new Map());
    const m = bookedByAccountDay.get(String(r.account_id))!;
    m.set(day, (m.get(day) ?? 0n) + signed);
  }

  // FX: resolve one held-flat rate per foreign currency at horizon start.
  const ecbRows = await client.query("SELECT rate_date, target_currency, rate FROM fx_rates_ecb WHERE workspace_id = $1 ORDER BY rate_date DESC", [wsId]);
  const ecbRates = new Map<string, Map<string, string>>();
  for (const r of ecbRows.rows as { rate_date: unknown; target_currency: string; rate: string }[]) {
    const d = String(r.rate_date).slice(0, 10);
    if (!ecbRates.has(d)) ecbRates.set(d, new Map());
    ecbRates.get(d)!.set(String(r.target_currency), String(r.rate));
  }
  const manualRows = await client.query("SELECT rate_date, base_currency, target_currency, rate FROM fx_rates_manual WHERE workspace_id = $1 ORDER BY rate_date DESC", [wsId]);
  const manualRates = new Map<string, Map<string, Map<string, string>>>();
  for (const r of manualRows.rows as { rate_date: unknown; base_currency: string; target_currency: string; rate: string }[]) {
    const d = String(r.rate_date).slice(0, 10);
    if (!manualRates.has(d)) manualRates.set(d, new Map());
    if (!manualRates.get(d)!.has(String(r.base_currency))) manualRates.get(d)!.set(String(r.base_currency), new Map());
    manualRates.get(d)!.get(String(r.base_currency))!.set(String(r.target_currency), String(r.rate));
  }

  // Goals + reservations (ACTIVE goals only: archiving releases headroom).
  const goalRows = await client.query("SELECT id, version FROM goals WHERE workspace_id = $1 AND status = 'ACTIVE'", [wsId]);
  const allocRows = await client.query("SELECT a.goal_id, a.account_id, a.amount_minor, a.currency_code, a.version FROM goal_allocations a JOIN goals g ON g.workspace_id = a.workspace_id AND g.id = a.goal_id WHERE a.workspace_id = $1 AND g.status = 'ACTIVE'", [wsId]);
  const goalReservations = (allocRows.rows as { goal_id: string; account_id: string; amount_minor: string; currency_code: string }[]).map((r) => ({
    goalId: String(r.goal_id), accountId: String(r.account_id), amountMinor: BigInt(String(r.amount_minor)), currency: String(r.currency_code),
  })).filter((g) => eligible === null || eligible.has(g.accountId));

  // Confirmed recurring linkage for fingerprint-only assumptions.
  const overrides = await client.query("SELECT fingerprint, kind, day_of_month FROM recurring_overrides WHERE workspace_id = $1 AND status = 'confirmed'", [wsId]);
  const confirmedByFp = new Map<string, { kind: "expense" | "income"; dayOfMonth: number }>();
  for (const r of overrides.rows as { fingerprint: string; kind: string; day_of_month: number }[]) {
    confirmedByFp.set(String(r.fingerprint), { kind: r.kind === "income" ? "income" : "expense", dayOfMonth: Number(r.day_of_month) });
  }

  // Partition assumptions (scenario ASSUMPTION_OVERRIDE swaps a row's value).
  const incomes: ComputeTimelineInput["incomes"] = [];
  const recurrings: ComputeTimelineInput["recurrings"] = [];
  const oneTimes: ComputeTimelineInput["oneTimes"] = [];
  let variableWeekly: ComputeTimelineInput["variableWeekly"] = null;
  const missingCommitments: string[] = [];
  for (const a of assumptions) {
    const v = (scenarioReplacements.get(a.id) ?? a.value) as Record<string, unknown>;
    if (a.assumptionType === "EXPECTED_INCOME") {
      incomes.push({ assumptionId: a.id, amountMinor: BigInt(String(v.amountMinor)), currency: String(v.currency), cadence: String(v.cadence) as "MONTHLY" | "WEEKLY" | "ONE_TIME", dayOfMonth: v.dayOfMonth === undefined ? undefined : Number(v.dayOfMonth), date: v.date === undefined ? undefined : String(v.date), accountId: v.accountId === undefined ? undefined : String(v.accountId) });
    } else if (a.assumptionType === "EXPECTED_RECURRING_AMOUNT") {
      if (v.cadence === "MONTHLY" || v.cadence === "YEARLY") {
        recurrings.push({ assumptionId: a.id, amountMinor: BigInt(String(v.amountMinor)), currency: String(v.currency), fingerprint: v.fingerprint === undefined ? undefined : String(v.fingerprint), cadence: v.cadence, dayOfMonth: v.dayOfMonth === undefined ? undefined : Number(v.dayOfMonth), month: v.month === undefined ? undefined : Number(v.month), date: v.date === undefined ? undefined : String(v.date), direction: v.direction === "INFLOW" ? "INFLOW" : "OUTFLOW", accountId: v.accountId === undefined ? undefined : String(v.accountId) });
      } else if (typeof v.fingerprint === "string" && confirmedByFp.has(v.fingerprint)) {
        // Linked scheduling resolved in computeTimeline via recurringLinked below.
      } else if (typeof v.fingerprint === "string") {
        missingCommitments.push(a.id);
      } else {
        missingCommitments.push(a.id);
      }
    } else if (a.assumptionType === "ONE_TIME_EXPECTED_EXPENSE") {
      oneTimes.push({ assumptionId: a.id, amountMinor: BigInt(String(v.amountMinor)), currency: String(v.currency), direction: String(v.direction) as "INFLOW" | "OUTFLOW", date: String(v.date), accountId: v.accountId === undefined ? undefined : String(v.accountId), toAccountId: v.toAccountId === undefined ? undefined : String(v.toAccountId), description: v.description === undefined ? undefined : String(v.description) });
    } else if (a.assumptionType === "EXPECTED_VARIABLE_SPEND") {
      variableWeekly = { assumptionId: a.id, amountMinor: BigInt(String(v.amountMinor)), currency: String(v.currency) };
    }
  }
  // Scenario deltas append after baseline partition (same shapes, same rules).
  for (const e of scenarioIncomes) incomes.push(e);
  for (const e of scenarioRecurrings) recurrings.push(e);
  for (const e of scenarioOneTimes) oneTimes.push(e);
  // AI-limited views: any scheduled input naming an excluded account cannot
  // be safely recomputed on eligible inputs, so the run is unavailable
  // rather than a fabricated partial substitute (§538).
  if (eligible !== null) {
    const namesExcluded = (...ids: (string | undefined)[]) => ids.some((id) => id !== undefined && !eligible.has(id));
    for (const e of incomes) if (namesExcluded(e.accountId)) { missingCommitments.push(`excluded:${e.assumptionId}`); }
    for (const e of recurrings) if (namesExcluded(e.accountId)) { missingCommitments.push(`excluded:${e.assumptionId}`); }
    for (const e of oneTimes) if (namesExcluded(e.accountId, e.toAccountId)) { missingCommitments.push(`excluded:${e.assumptionId}`); }
  }

  // Linked recurring schedules (fingerprint -> confirmed override + amount center).
  // A fingerprint claimed by both an explicit schedule and a confirmed
  // override uses the explicit schedule only (never double-counted).
  const scheduledFps = new Set(
    recurrings.filter((r) => typeof r.fingerprint === "string").map((r) => r.fingerprint as string),
  );
  const recurringLinked: ComputeTimelineInput["recurringLinked"] = [];
  for (const a of assumptions) {
    if (a.assumptionType !== "EXPECTED_RECURRING_AMOUNT") continue;
    const v = a.value as Record<string, unknown>;
    if (v.cadence !== undefined || typeof v.fingerprint !== "string") continue;
    if (scheduledFps.has(v.fingerprint)) continue;
    const ov = confirmedByFp.get(v.fingerprint);
    if (!ov) continue;
    const matched = bookedRows.filter((b) => fingerprintFor(normalizeDescription(b.description), b.amountMinor.toString(), b.currency, b.direction) === v.fingerprint);
    const amounts = matched.map((b) => b.amountMinor).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const center = amounts.length % 2 === 1 ? amounts[Math.floor(amounts.length / 2)]! : amounts.length === 0 ? BigInt(String(v.amountMinor)) : (amounts[amounts.length / 2 - 1]! + amounts[amounts.length / 2]!) / 2n;
    const acctCount = new Map<string, number>();
    for (const b of matched) acctCount.set(b.accountId, (acctCount.get(b.accountId) ?? 0) + 1);
    let modal: string | null = null;
    let modalN = 0;
    for (const [id, n] of acctCount) if (n > modalN) { modalN = n; modal = id; }
    recurringLinked.push({ fingerprint: v.fingerprint, dayOfMonth: ov.dayOfMonth, kind: ov.kind, amountCenterMinor: center, currency: String(v.currency), accountId: modal ?? accountIds[0] ?? "" });
  }

  // Variable baseline median when no explicit assumption. Reuses the shared
  // S01 baseline module; completeness mirrors the preview reader (past weeks
  // only, pending-review weeks and open-import windows never complete).
  let variableBaselineMedian: bigint | null = null;
  let variableBaselineStatus: ComputeTimelineInput["variableBaselineStatus"] = "assumed-zero-no-baseline";
  let variableCurrency = baseCurrency;
  if (!variableWeekly) {
    const owned = new Set(accountIds);
    const fps = new Set(confirmedByFp.keys());
    const spendByWeek = new Map<string, bigint>();
    const weekOf = (day: string): string | null => {
      const dt = new Date(`${day}T00:00:00Z`);
      const dow = (dt.getUTCDay() + 6) % 7;
      const mon = new Date(dt.getTime() - dow * 86400000);
      return mon.toISOString().slice(0, 10);
    };
    for (const b of bookedRows) {
      if (b.direction !== "OUTFLOW" || b.date >= horizonStart) continue;
      const leg = classifyLeg({ accountId: b.accountId, amountMinor: b.amountMinor, currency: b.currency, direction: "OUTFLOW", effectiveDate: b.date, description: b.description, source: "imported" }, owned);
      if (leg.classification !== "spend") continue;
      if (fps.has(fingerprintFor(normalizeDescription(b.description), b.amountMinor.toString(), b.currency, "OUTFLOW"))) continue;
      const w = weekOf(b.date);
      if (!w) continue;
      spendByWeek.set(w, (spendByWeek.get(w) ?? 0n) + b.amountMinor);
    }
    const pendingDays = new Set<string>(
      (await client.query(
        `SELECT t.effective_date AS d FROM source_links s JOIN transactions t ON t.workspace_id = s.workspace_id AND t.id = s.target_transaction_id WHERE s.workspace_id = $1 AND s.status = 'PENDING_REVIEW'`,
        [wsId],
      )).rows.map((r: { d: unknown }) => String(r.d).slice(0, 10)),
    );
    const openImports = await client.query(
      "SELECT COUNT(*)::int AS n FROM imports WHERE workspace_id = $1 AND status IN ('UPLOAD_REGISTERED', 'SCANNING', 'PARSING', 'STAGED') AND created_at >= now() - interval '30 days'",
      [wsId],
    );
    const hasOpenImports = Number((openImports.rows[0] as { n: number }).n) > 0;
    const weekStarts = pastIsoWeeks(horizonStart, Math.min(settings.baselineWeeks + 1, 52));
    const baselineWeeks = weekStarts.map(({ start, end }) => {
      let complete = end < horizonStart;
      if (complete && hasOpenImports) complete = false;
      if (complete) for (const d of pendingDays) {
        if (d >= start && d <= end) { complete = false; break; }
      }
      return { start, complete, spendMinor: spendByWeek.get(start) ?? 0n };
    });
    const built = buildWeeklyBaseline(baselineWeeks, settings.baselineWeeks);
    if (built.status === "ok" && built.medianMinor !== null) {
      variableBaselineMedian = built.medianMinor;
      variableBaselineStatus = "ok";
      variableCurrency = baseCurrency;
    }
  } else {
    variableBaselineStatus = "assumption";
  }

  // Per-account starts with forward reconciliation + FX valuation.
  const accounts: ComputeTimelineInput["accounts"] = [];
  const coverageNotes: Record<string, unknown> = {
    holds: "not-applicable/no-feed (R1 has no pending-hold feed)",
    variableSpend: variableWeekly ? "assumption" : variableBaselineStatus,
    missingCommitments,
    scenarioGoalDisplay,
    ...(aiLimited ? { aiCoverage: "partial (account exclusions apply to this AI-limited view)" } : {}),
  };
  let fxPartial = false;
  for (const id of accountIds) {
    const currency = accountCurrency.get(id)!;
    const snap = snapByAccount.get(id) ?? null;
    let startMinor = 0n;
    if (snap) {
      startMinor = snap.amountMinor;
      const fwd = bookedByAccountDay.get(id);
      if (fwd) for (const [day, net] of fwd) if (day > snap.date && day < horizonStart) startMinor += net;
    }
    type FxState = { coverage: "full" | "partial" | "unavailable"; rateDate: string | null; rateSource: string | null; triangNum: string | null; triangDen: string | null };
    let fx: FxState = { coverage: "full", rateDate: horizonStart, rateSource: "identity", triangNum: null, triangDen: null };
    if (currency !== baseCurrency) {
      const valued = valuateSnapshot({ snapshotId: snap?.id ?? id, accountId: id, asOfDate: horizonStart, amountMinor: startMinor, currency, baseCurrency }, ecbRates, manualRates, 7);
      if (valued.coverage === "unavailable") {
        fx = { coverage: "unavailable", rateDate: null, rateSource: null, triangNum: null, triangDen: null };
        fxPartial = true;
      } else {
        // Re-derive the held-flat triangulation ratio from the same leg rates.
        const legX = currency === "EUR" ? { rate: "1", rateDate: horizonStart } : lookupEcbRate(ecbRates, currency, horizonStart, 7);
        const legB = baseCurrency === "EUR" ? { rate: "1", rateDate: horizonStart } : lookupEcbRate(ecbRates, baseCurrency, horizonStart, 7);
        const manual = lookupManualRate(manualRates, currency, baseCurrency, horizonStart);
        if (manual) {
          const r = parseRate(manual.rate);
          fx = { coverage: "full", rateDate: manual.rateDate, rateSource: "manual", triangNum: r.num.toString(), triangDen: r.den.toString() };
          startMinor = convertWithRate(startMinor, currencyExponent(currency)!, r, currencyExponent(baseCurrency)!);
        } else if (legX && legB) {
          const rx = parseRate(legX.rate);
          const rb = parseRate(legB.rate);
          const num = rb.num * rx.den;
          const den = rx.num * rb.den;
          fx = { coverage: valued.coverage, rateDate: valued.rateDate, rateSource: "ecb", triangNum: num.toString(), triangDen: den.toString() };
          startMinor = valued.valuedAmountMinor;
        } else {
          fx = { coverage: "unavailable", rateDate: null, rateSource: null, triangNum: null, triangDen: null };
          fxPartial = true;
        }
      }
    }
    accounts.push({ id, currency, spendable: !nonSpendable.has(id), snapshotId: snap?.id ?? null, snapshotDate: snap?.date ?? null, startMinor, fx });
  }
  if (fxPartial) coverageNotes.fx = "partial (unvalued accounts excluded from TOTAL)";
  void getAccountTotalAllocated;

  // Held-flat conversion ratios for every non-base currency in play
  // (accounts, variable spend, assumptions). Missing ratio => FX gap.
  const fxByCurrency: Record<string, { num: string; den: string } | null> = {};
  {
    const needed = new Set<string>();
    for (const a of accounts) if (a.currency !== baseCurrency) needed.add(a.currency);
    if (variableWeekly && variableWeekly.currency !== baseCurrency) needed.add(variableWeekly.currency);
    for (const r of recurrings) if (r.currency !== baseCurrency) needed.add(r.currency);
    for (const o of oneTimes) if (o.currency !== baseCurrency) needed.add(o.currency);
    for (const i of incomes) if (i.currency !== baseCurrency) needed.add(i.currency);
    for (const cur of needed) {
      const manual = lookupManualRate(manualRates, cur, baseCurrency, horizonStart);
      if (manual) {
        const r = parseRate(manual.rate);
        fxByCurrency[cur] = { num: r.num.toString(), den: r.den.toString() };
        continue;
      }
      const legX = cur === "EUR" ? { rate: "1", rateDate: horizonStart } : lookupEcbRate(ecbRates, cur, horizonStart, 7);
      const legB = baseCurrency === "EUR" ? { rate: "1", rateDate: horizonStart } : lookupEcbRate(ecbRates, baseCurrency, horizonStart, 7);
      if (legX && legB) {
        const rx = parseRate(legX.rate);
        const rb = parseRate(legB.rate);
        fxByCurrency[cur] = { num: (rb.num * rx.den).toString(), den: (rx.num * rb.den).toString() };
      } else {
        fxByCurrency[cur] = null;
      }
    }
  }

  const bookedFingerprint = createHash("sha256")
    .update(bookedRows.map((b) => `${b.accountId}:${b.amountMinor.toString()}:${b.currency}:${b.direction}:${b.date}:${b.description}`).sort().join("|"))
    .digest("hex");
  const canonical = {
    settingsVersion: settings.version, horizonDays, baseCurrency, spendingAccountId: input.spendingAccountId ?? null, scenarioId: input.scenarioId ?? null,
    scenarioRef,
    eligibleAccountIds: eligible === null ? null : [...eligible].sort(),
    assumptions: assumptions.map((a) => `${a.id}:${a.version}`).sort(),
    goals: goalRows.rows.map((r: { id: string }) => String(r.id)).sort(),
    allocations: (allocRows.rows as { goal_id: string; account_id: string; amount_minor: string }[]).map((r) => `${String(r.goal_id)}:${String(r.account_id)}:${String(r.amount_minor)}`).sort(),
    snapshots: [...snapByAccount.entries()].map(([k, s]) => `${k}:${s.id}:${s.date}:${s.amountMinor.toString()}`).sort(),
    booked: `${bookedRows.length}:${bookedFingerprint}`,
    fx: Object.entries(fxByCurrency).map(([k, v]) => `${k}:${v ? `${v.num}/${v.den}` : "missing"}`).sort(),
    overrides: [...confirmedByFp.entries()].map(([k, v]) => `${k}:${v.kind}:${v.dayOfMonth}`).sort(),
  };
  const inputHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return {
    inputHash,
    resolved: {
      horizonStart, horizonDays, baseCurrency,
      floorMinor: BigInt(settings.safetyFloorMinor),
      settingsVersion: settings.version, baselineWeeks: settings.baselineWeeks,
      accounts, incomes, recurrings, oneTimes, variableWeekly, variableBaselineMedian, variableBaselineStatus, variableCurrency,
      goalReservations, recurringLinked, bookedByAccountDay, missingCommitments, coverageNotes, fxByCurrency,
      spendingAccountId: input.spendingAccountId,
    },
  };
}

async function runProjectionTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ProjectionRunInput): Promise<TxOutcome<ProjectionRunView>> {
  return claimAndExecute(client, claims, actorId, PROJECTION_RUN_COMMAND, input.idempotencyKey, runHash(input), async (client, operationId) => {
    const { inputHash, resolved } = await resolveInputs(client, claims, input);
    
    // Check for existing run with same input_hash
    const existing = await client.query(
      "SELECT * FROM projection_runs WHERE workspace_id = $1 AND input_hash = $2 AND (scenario_id = $3 OR (scenario_id IS NULL AND $3 IS NULL))",
      [claims.workspaceId, inputHash, input.scenarioId ?? null],
    );
if (existing.rows.length > 0) {
      const run = existing.rows[0] as Record<string, unknown>;
      // Load existing points and events
      const points = await client.query("SELECT * FROM projection_points WHERE workspace_id = $1 AND run_id = $2", [claims.workspaceId, String(run.id)]);
      const events = await client.query("SELECT * FROM projection_events WHERE workspace_id = $1 AND run_id = $2", [claims.workspaceId, String(run.id)]);
      const view: ProjectionRunView = {
        workspaceId: claims.workspaceId,
        runId: String(run.id),
        method: String(run.method),
        engineVersion: String(run.engine_version),
        scenarioId: run.scenario_id === null ? null : String(run.scenario_id),
        horizonStart: String(run.horizon_start),
        horizonEnd: String(run.horizon_end),
        baseCurrency: String(run.base_currency),
        inputHash: String(run.input_hash),
        inputs: run.inputs as Record<string, unknown>,
        coverage: run.coverage as Record<string, unknown>,
        status: String(run.status) as "ACTIVE" | "SUPERSEDED",
        createdAt: String(run.created_at),
      };
const result: ProjectionRunResult = {
      view,
      points: points.rows.map((r: Record<string, unknown>) => ({
        workspaceId: claims.workspaceId,
        runId: String(r.run_id),
        caseName: String(r.case_name) as "EXPECTED" | "CONSERVATIVE" | "OPTIMISTIC",
        scope: String(r.scope),
        pointDate: String(r.point_date),
        amountMinor: String(r.amount_minor),
        currencyCode: String(r.currency_code),
      })),
      events: events.rows.map((r: Record<string, unknown>) => ({
        workspaceId: claims.workspaceId,
        id: String(r.id),
        runId: String(r.run_id),
        eventDate: String(r.event_date),
        eventType: String(r.event_type),
        direction: r.direction === null ? null : String(r.direction) as "INFLOW" | "OUTFLOW",
        amountMinor: r.amount_minor === null ? null : String(r.amount_minor),
        currencyCode: r.currency_code === null ? null : String(r.currency_code),
        accountScope: r.account_scope === null ? null : String(r.account_scope),
        label: String(r.label),
        sourceRefs: r.source_refs as Record<string, unknown>,
        createdAt: String(r.created_at),
      })),
      ats: ((run.inputs as { ats?: ATSView }).ats ?? { status: "UNAVAILABLE", amountMinor: "0", reasons: ["missing_evidence"] }) as ATSView,
      operationId: String(run.id),
      replayed: true,
    };
    return result;
    }

    // Compute timeline
    const { points, events, ats } = computeTimeline(resolved);

    // Compute ATS view (string form for persistence + response).
    let atsView: ATSView;
    if (ats.status === "AVAILABLE") {
      atsView = { status: "AVAILABLE", amountMinor: ats.amountMinor.toString(), limitingDay: ats.limitingDay, limitingAccount: ats.limitingAccount };
    } else if (ats.status === "SHORTFALL") {
      atsView = { status: "SHORTFALL", amountMinor: "0", shortfallMinor: ats.shortfallMinor?.toString(), shortfallDate: ats.shortfallDate, limitingDay: ats.limitingDay, limitingAccount: ats.limitingAccount };
    } else {
      atsView = { status: "UNAVAILABLE", amountMinor: "0", reasons: ats.reasons };
    }

    const horizonStartStr = resolved.horizonStart;
    const horizonEndStr = isoDay(new Date(new Date(`${resolved.horizonStart}T00:00:00Z`).getTime() + resolved.horizonDays * 86400000));
    const inputsJson = {
      settingsVersion: resolved.settingsVersion,
      horizonDays: resolved.horizonDays,
      baseCurrency: resolved.baseCurrency,
      floorMinor: resolved.floorMinor.toString(),
      spendingAccountId: resolved.spendingAccountId ?? null,
      scenarioId: input.scenarioId ?? null,
      caseBps: { expected: { income: 10000, expense: 10000 }, conservative: { income: 9000, expense: 11000 }, optimistic: { income: 11000, expense: 9000 } },
      ats: atsView,
    };
    const coverageJson = { ...resolved.coverageNotes, accounts: resolved.accounts.map((a) => ({ accountId: a.id, currency: a.currency, snapshotId: a.snapshotId, snapshotDate: a.snapshotDate, fx: a.fx })) };

    // Persist run (savepoint-guarded: a concurrent identical run may win the
    // UNIQUE(workspace, input_hash, scenario) race; the loser converges by
    // re-reading the winner instead of 500ing).
    const runId = (await import("../ids.ts")).uuidv7();
    await client.query("SAVEPOINT projection_run_insert");
    try {
      await client.query(
        `INSERT INTO projection_runs (workspace_id, id, method, engine_version, scenario_id, horizon_start, horizon_end, base_currency, input_hash, inputs, coverage, status)
         VALUES ($1, $2, 'SCENARIO_CASES', 'e06-r1.0', $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')`,
        [claims.workspaceId, runId, input.scenarioId ?? null, horizonStartStr, horizonEndStr, resolved.baseCurrency, inputHash, JSON.stringify(inputsJson), JSON.stringify(coverageJson)],
      );
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT projection_run_insert");
      const winner = await client.query(
        "SELECT * FROM projection_runs WHERE workspace_id = $1 AND input_hash = $2 AND (scenario_id = $3 OR (scenario_id IS NULL AND $3 IS NULL))",
        [claims.workspaceId, inputHash, input.scenarioId ?? null],
      );
      const wrow = winner.rows[0] as Record<string, unknown> | undefined;
      if (!wrow) throw err;
      const wview: ProjectionRunView = {
        workspaceId: claims.workspaceId,
        runId: String(wrow.id),
        method: String(wrow.method),
        engineVersion: String(wrow.engine_version),
        scenarioId: wrow.scenario_id === null ? null : String(wrow.scenario_id),
        horizonStart: String(wrow.horizon_start),
        horizonEnd: String(wrow.horizon_end),
        baseCurrency: String(wrow.base_currency),
        inputHash: String(wrow.input_hash),
        inputs: wrow.inputs as Record<string, unknown>,
        coverage: wrow.coverage as Record<string, unknown>,
        status: String(wrow.status) as "ACTIVE" | "SUPERSEDED",
        createdAt: String(wrow.created_at),
      };
      await insertAudit(client, claims, actorId, "projection_run", String(wrow.id), "replay", null, { runId: String(wrow.id), inputHash }, operationId);
      await bumpRevision(client, claims.workspaceId);
      return { view: wview, points: [], events: [], ats: ((wrow.inputs as { ats?: ATSView }).ats ?? { status: "UNAVAILABLE", amountMinor: "0", reasons: ["missing_evidence"] }) as ATSView, operationId, replayed: true };
    }

    // Persist points
    for (const pt of points) {
      await client.query(
        `INSERT INTO projection_points (workspace_id, run_id, case_name, scope, point_date, amount_minor, currency_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [claims.workspaceId, runId, pt.caseName, pt.scope, pt.pointDate, pt.amountMinor.toString(), pt.currencyCode],
      );
    }

    // Persist events
    for (const ev of events) {
      const evId = (await import("../ids.ts")).uuidv7();
      await client.query(
        `INSERT INTO projection_events (workspace_id, id, run_id, event_date, event_type, direction, amount_minor, currency_code, account_scope, label, source_refs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [claims.workspaceId, evId, runId, ev.eventDate, ev.eventType, ev.direction, ev.amountMinor?.toString() ?? null, ev.currencyCode, ev.accountScope, ev.label, JSON.stringify(ev.sourceRefs)],
      );
    }

    const runView: ProjectionRunView = {
      workspaceId: claims.workspaceId,
      runId,
      method: "SCENARIO_CASES",
      engineVersion: "e06-r1.0",
      scenarioId: input.scenarioId ?? null,
      horizonStart: horizonStartStr,
      horizonEnd: horizonEndStr,
      baseCurrency: resolved.baseCurrency,
      inputHash,
      inputs: inputsJson,
      coverage: coverageJson,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    };

    const pointViews: ProjectionPointView[] = points.map((pt) => ({
      workspaceId: claims.workspaceId,
      runId,
      caseName: pt.caseName,
      scope: pt.scope,
      pointDate: pt.pointDate,
      amountMinor: pt.amountMinor.toString(),
      currencyCode: pt.currencyCode,
    }));

    const eventIds: string[] = [];
    for (const ev of events) {
      const { uuidv7 } = await import("../ids.ts");
      eventIds.push(uuidv7());
    }
    const eventViews: ProjectionEventView[] = events.map((ev, i) => ({
      workspaceId: claims.workspaceId,
      id: eventIds[i],
      runId,
      eventDate: ev.eventDate,
      eventType: ev.eventType,
      direction: ev.direction,
      amountMinor: ev.amountMinor?.toString() ?? null,
      currencyCode: ev.currencyCode,
      accountScope: ev.accountScope,
      label: ev.label,
      sourceRefs: ev.sourceRefs,
      createdAt: new Date().toISOString(),
    }));

    await insertAudit(client, claims, actorId, "projection_run", runId, "create", null, { runId, inputHash }, operationId);
    await bumpRevision(client, claims.workspaceId);

    return { view: runView, points: pointViews, events: eventViews, ats: atsView, operationId, replayed: false };
  });
}

export async function runProjection(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<ProjectionRunResult> {
  const input = validateRunProjectionInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => runProjectionTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion, outcome.detail);
  
  // Fetch full result data from database
  const runView = outcome.result as ProjectionRunView;
  const runId = runView.runId;
  
  // Fetch full result data from the database inside tenant context
  // (FORCE RLS filters unscoped reads to zero rows).
  const full = await withTenant(pool, claims, async (client) => {
    const runRow = await client.query("SELECT inputs FROM projection_runs WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, runView.runId]);
    const points = await client.query("SELECT * FROM projection_points WHERE workspace_id = $1 AND run_id = $2 ORDER BY case_name, scope, point_date", [claims.workspaceId, runView.runId]);
    const events = await client.query("SELECT * FROM projection_events WHERE workspace_id = $1 AND run_id = $2 ORDER BY event_date", [claims.workspaceId, runView.runId]);
    return { inputs: (runRow.rows[0]?.inputs ?? {}) as Record<string, unknown>, points: points.rows, events: events.rows };
  });
  const points = { rows: full.points };
  const events = { rows: full.events };
  
  const pointViews: ProjectionPointView[] = points.rows.map((r: Record<string, unknown>) => ({
    workspaceId: claims.workspaceId,
    runId: String(r.run_id),
    caseName: String(r.case_name) as "EXPECTED" | "CONSERVATIVE" | "OPTIMISTIC",
    scope: String(r.scope),
    pointDate: String(r.point_date),
    amountMinor: String(r.amount_minor),
    currencyCode: String(r.currency_code),
  }));
  
  const eventViews: ProjectionEventView[] = [];
  for (const r of events.rows) {
    eventViews.push({
      workspaceId: claims.workspaceId,
      id: String(r.id),
      runId: String(r.run_id),
      eventDate: String(r.event_date),
      eventType: String(r.event_type),
      direction: r.direction === null ? null : String(r.direction) as "INFLOW" | "OUTFLOW",
      amountMinor: r.amount_minor === null ? null : String(r.amount_minor),
      currencyCode: r.currency_code === null ? null : String(r.currency_code),
      accountScope: r.account_scope === null ? null : String(r.account_scope),
      label: String(r.label),
      sourceRefs: r.source_refs as Record<string, unknown>,
      createdAt: String(r.created_at),
    });
  }
  const atsView = { status: "UNAVAILABLE" as const, amountMinor: "0", reasons: ["not_implemented"] };

  const storedAts = (runView.inputs as { ats?: ATSView }).ats;
  const ats: ATSView = storedAts && typeof storedAts.status === "string" ? storedAts : atsView;

  return {
    view: runView,
    points: pointViews,
    events: eventViews,
    ats,
    operationId: outcome.operationId,
    replayed: outcome.replayed,
  };
}

export type ProjectionEvaluation = {
  inputHash: string;
  coverage: Record<string, unknown>;
  horizonStart: string;
  horizonDays: number;
  baseCurrency: string;
  points: ProjectionPointView[];
  events: ProjectionEventView[];
  ats: ATSView;
};

const SDK_MAX_POINTS = 500;

/**
 * Artifact SDK projection read: the shared read-only evaluation with a
 * bounded point window. Grant, freshness, quota and permission checks live
 * with the caller (tenancy RPC gate + worker caps); this function only
 * validates shapes and truncates. Throws TenantInvalid on malformed args.
 */
export async function runSdkProjection(
  pool: Pool,
  claim: TenantClaims,
  args: unknown,
): Promise<{ horizonStart: string; horizonDays: number; baseCurrency: string; inputHash: string; coverage: Record<string, unknown>; ats: ATSView; points: { caseName: string; scope: string; pointDate: string; amountMinor: string; currencyCode: string }[]; truncated: boolean }> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new TenantInvalid();
  const v = args as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["horizonDays", "spendingAccountId", "scenarioId"].includes(key)) throw new TenantInvalid();
  }
  if (v.horizonDays !== undefined && (!Number.isInteger(v.horizonDays) || (v.horizonDays as number) < 1 || (v.horizonDays as number) > 120)) throw new TenantInvalid();
  if (v.spendingAccountId !== undefined && (typeof v.spendingAccountId !== "string" || !isUuid(v.spendingAccountId))) throw new TenantInvalid();
  if (v.scenarioId !== undefined && (typeof v.scenarioId !== "string" || !isUuid(v.scenarioId))) throw new TenantInvalid();
  // Artifact SDK reads use the AI data policy like chat tools: excluded
  // accounts are intersected out before aggregation (never full totals).
  const eligibleAccountIds: string[] = await withTenant(pool, claim, async (client) => {
    const known = await client.query("SELECT id FROM accounts WHERE workspace_id = $1 AND archived = false", [claim.workspaceId]);
    const excluded = await client.query("SELECT account_id AS id FROM ai_exclusions WHERE workspace_id = $1", [claim.workspaceId]);
    const excludedIds = new Set((excluded.rows as { id: string }[]).map((r) => String(r.id)));
    return (known.rows as { id: string }[]).map((r) => String(r.id)).filter((id) => !excludedIds.has(id)).sort();
  });
  if (typeof v.spendingAccountId === "string" && !eligibleAccountIds.includes(v.spendingAccountId)) {
    const err = new Error("denied") as Error & { code?: string };
    (err as { code?: string }).code = "denied";
    throw err;
  }
  const evaluated = await evaluateProjection(pool, claim, {
    horizonDays: v.horizonDays as number | undefined,
    spendingAccountId: v.spendingAccountId as string | undefined,
    scenarioId: v.scenarioId as string | undefined,
    eligibleAccountIds,
  });
  const points = evaluated.points.slice(0, SDK_MAX_POINTS);
  return {
    horizonStart: evaluated.horizonStart,
    horizonDays: evaluated.horizonDays,
    baseCurrency: evaluated.baseCurrency,
    inputHash: evaluated.inputHash,
    coverage: evaluated.coverage,
    ats: evaluated.ats,
    points: points.map((p) => ({ caseName: p.caseName, scope: p.scope, pointDate: p.pointDate, amountMinor: p.amountMinor, currencyCode: p.currencyCode })),
    truncated: evaluated.points.length > SDK_MAX_POINTS,
  };
}

/**
 * Read-only shared evaluation consumed by chat tools, artifact SDK reads,
 * scenario comparison and saved-scenario reopen. Same resolve+compute as
 * persisted runs, but writes nothing: no journal row, no run row, no audit.
 * Callers needing evidence persistence use runProjection instead.
 */
export async function evaluateProjection(
  pool: Pool,
  claims: TenantClaims,
  opts: { horizonDays?: number; spendingAccountId?: string; scenarioId?: string; eligibleAccountIds?: string[] },
): Promise<ProjectionEvaluation> {
  if (opts.horizonDays !== undefined && (!Number.isInteger(opts.horizonDays) || opts.horizonDays < 1 || opts.horizonDays > 365)) throw new TenantInvalid();
  if (opts.spendingAccountId !== undefined && (typeof opts.spendingAccountId !== "string" || !isUuid(opts.spendingAccountId))) throw new TenantInvalid();
  if (opts.scenarioId !== undefined && (typeof opts.scenarioId !== "string" || !isUuid(opts.scenarioId))) throw new TenantInvalid();
  if (opts.eligibleAccountIds !== undefined) {
    if (!Array.isArray(opts.eligibleAccountIds) || opts.eligibleAccountIds.some((id) => typeof id !== "string" || !isUuid(id))) throw new TenantInvalid();
  }
  return withTenant(pool, claims, async (client) => {
    const { inputHash, resolved } = await resolveInputs(client, claims, {
      workspaceId: claims.workspaceId,
      horizonDays: opts.horizonDays,
      spendingAccountId: opts.spendingAccountId,
      scenarioId: opts.scenarioId,
      eligibleAccountIds: opts.eligibleAccountIds === undefined ? undefined : [...opts.eligibleAccountIds].sort(),
      idempotencyKey: "00000000-0000-0000-0000-000000000000",
    });
    const { points, events, ats } = computeTimeline(resolved);
    const atsView: ATSView =
      ats.status === "AVAILABLE"
        ? { status: "AVAILABLE", amountMinor: ats.amountMinor.toString(), limitingDay: ats.limitingDay, limitingAccount: ats.limitingAccount }
        : ats.status === "SHORTFALL"
          ? { status: "SHORTFALL", amountMinor: "0", shortfallMinor: ats.shortfallMinor?.toString(), shortfallDate: ats.shortfallDate, limitingDay: ats.limitingDay, limitingAccount: ats.limitingAccount }
          : { status: "UNAVAILABLE", amountMinor: "0", reasons: ats.reasons };
    return {
      inputHash,
      coverage: { ...resolved.coverageNotes, accounts: resolved.accounts.map((a) => ({ accountId: a.id, currency: a.currency, snapshotId: a.snapshotId, snapshotDate: a.snapshotDate, fx: a.fx })) },
      horizonStart: resolved.horizonStart,
      horizonDays: resolved.horizonDays,
      baseCurrency: resolved.baseCurrency,
      points: points.map((pt) => ({
        workspaceId: claims.workspaceId,
        runId: "evaluation",
        caseName: pt.caseName,
        scope: pt.scope,
        pointDate: pt.pointDate,
        amountMinor: pt.amountMinor.toString(),
        currencyCode: pt.currencyCode,
      })),
      events: events.map((ev) => ({
        workspaceId: claims.workspaceId,
        id: "evaluation",
        runId: "evaluation",
        eventDate: ev.eventDate,
        eventType: ev.eventType,
        direction: ev.direction,
        amountMinor: ev.amountMinor?.toString() ?? null,
        currencyCode: ev.currencyCode,
        accountScope: ev.accountScope,
        label: ev.label,
        sourceRefs: ev.sourceRefs,
        createdAt: new Date().toISOString(),
      })),
      ats: atsView,
    };
  });
}

type GetProjectionRunResult = {
  run: { workspaceId: string; runId: string; method: string; engineVersion: string; scenarioId: string | null; horizonStart: string; horizonEnd: string; baseCurrency: string; inputHash: string; inputs: Record<string, unknown>; coverage: Record<string, unknown>; status: string; createdAt: string };
  points: { workspaceId: string; runId: string; caseName: string; scope: string; pointDate: string; amountMinor: string; currencyCode: string }[];
  events: { workspaceId: string; id: string; runId: string; eventDate: string; eventType: string; direction: "INFLOW" | "OUTFLOW" | null; amountMinor: string | null; currencyCode: string | null; accountScope: string | null; label: string; sourceRefs: Record<string, unknown>; createdAt: string }[];
  ats: { status: "AVAILABLE" | "SHORTFALL" | "UNAVAILABLE"; amountMinor: string; shortfallMinor?: string; shortfallDate?: string; limitingDay?: string; limitingAccount?: string; reasons?: string[] };
};

export async function getProjectionRun(pool: Pool, claims: TenantClaims, runId: string): Promise<GetProjectionRunResult> {
  return withTenant(pool, claims, async (client) => {
    const run = await client.query("SELECT * FROM projection_runs WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, runId]);
    const runRow = run.rows[0] as Record<string, unknown> | undefined;
    if (!runRow) throw new TxError("not_found");
    const points = await client.query("SELECT * FROM projection_points WHERE workspace_id = $1 AND run_id = $2 ORDER BY case_name, scope, point_date", [claims.workspaceId, runId]);
    const events = await client.query("SELECT * FROM projection_events WHERE workspace_id = $1 AND run_id = $2 ORDER BY event_date", [claims.workspaceId, runId]);
    const runInfo = {
      workspaceId: claims.workspaceId,
      runId: String(runRow.id),
      method: String(runRow.method),
      engineVersion: String(runRow.engine_version),
      scenarioId: runRow.scenario_id === null ? null : String(runRow.scenario_id),
      horizonStart: String(runRow.horizon_start),
      horizonEnd: String(runRow.horizon_end),
      baseCurrency: String(runRow.base_currency),
      inputHash: String(runRow.input_hash),
      inputs: runRow.inputs as Record<string, unknown>,
      coverage: runRow.coverage as Record<string, unknown>,
      status: String(runRow.status),
      createdAt: String(runRow.created_at),
    };
    const pointList = points.rows.map((r: Record<string, unknown>) => ({
      workspaceId: claims.workspaceId,
      runId: String(r.run_id),
      caseName: String(r.case_name) as "EXPECTED" | "CONSERVATIVE" | "OPTIMISTIC",
      scope: String(r.scope),
      pointDate: String(r.point_date),
      amountMinor: String(r.amount_minor),
      currencyCode: String(r.currency_code),
    }));
    const eventList = events.rows.map((r: Record<string, unknown>) => ({
      workspaceId: claims.workspaceId,
      id: String(r.id),
      runId: String(r.run_id),
      eventDate: String(r.event_date),
      eventType: String(r.event_type),
      direction: r.direction === null ? null : String(r.direction) as "INFLOW" | "OUTFLOW",
      amountMinor: r.amount_minor === null ? null : String(r.amount_minor),
      currencyCode: r.currency_code === null ? null : String(r.currency_code),
      accountScope: r.account_scope === null ? null : String(r.account_scope),
      label: String(r.label),
      sourceRefs: r.source_refs as Record<string, unknown>,
      createdAt: String(r.created_at),
    }));
    const atsObj: { status: "AVAILABLE" | "SHORTFALL" | "UNAVAILABLE"; amountMinor: string; shortfallMinor?: string; shortfallDate?: string; limitingDay?: string; limitingAccount?: string; reasons?: string[] } = ((runRow.inputs as { ats?: { status: "AVAILABLE" | "SHORTFALL" | "UNAVAILABLE"; amountMinor: string; shortfallMinor?: string; shortfallDate?: string; limitingDay?: string; limitingAccount?: string; reasons?: string[] } }).ats ?? { status: "UNAVAILABLE", amountMinor: "0", reasons: ["missing_evidence"] });
    return { run: runInfo, points: pointList, events: eventList, ats: atsObj };
  });
}