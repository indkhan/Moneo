import { requireWorkspace } from "@/lib/auth";
import { availableToSpend, summarizeCashflow, type CashflowTransaction } from "@/lib/finance/calculations";
import { evaluatePlan } from "@/lib/finance/model";
import { getBalances } from "@/lib/finance/tools";
import { calendarDate } from "@/lib/finance/calendar";
import { requireAiScope } from "@/lib/settings";
import { z } from "zod";

async function requirePermission(artifactId: string, permission: string) {
  const { supabase, workspace, settings } = await requireWorkspace();
  if (permission === "spending" || permission === "cashflow") requireAiScope(settings, "transactions");
  else if (permission === "balances") requireAiScope(settings, "accounts");
  else if (permission === "forecast") requireAiScope(settings, "accounts", "transactions", "planning");
  else if (permission === "goals") requireAiScope(settings, "accounts", "planning");
  const { data, error } = await supabase.from("artifacts")
    .select("permissions, active_version_id").eq("id", artifactId).eq("workspace_id", workspace.id).single();
  if (error || !data?.active_version_id || !Array.isArray(data.permissions) || !data.permissions.includes(permission))
    throw new Error("Artifact permission denied");
  return { supabase, workspace };
}

export async function balancesForArtifact(artifactId: string) {
  const { workspace } = await requirePermission(artifactId, "balances");
  return { currency: workspace.display_currency, balances: await getBalances() };
}

export async function spendingForArtifact(artifactId: string, query: string, permission: "spending" | "cashflow" = "spending", month?: string) {
  const { supabase, workspace } = await requirePermission(artifactId, permission);
  const today = calendarDate(new Date(), workspace.timezone);
  const from = z.iso.date().parse(`${month ?? today.slice(0, 7)}-01`);
  if (from > today) throw new Error("Choose a current or past month");
  const nextMonth = new Date(`${from}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
  const to = monthEnd < today ? monthEnd : today;
  const transactions: { id: string; account_id: string; posted_on: string; description: string; amount_minor: string;
    currency_code: string; category_id: string | null; status: CashflowTransaction["status"];
    kind: CashflowTransaction["kind"]; review_reasons: string[] }[] = [];
  for (let offset = 0; ; offset += 1000) {
    let rows = supabase.from("effective_transactions")
      .select("id, account_id, posted_on, description, amount_minor::text, currency_code, category_id, status, kind, review_reasons")
      .eq("workspace_id", workspace.id).eq("status", "posted").neq("kind", "transfer")
      .gte("posted_on", from).lte("posted_on", to)
      .order("posted_on", { ascending: false }).order("id");
    if (query) rows = rows.ilike("description", `%${query.replace(/[%_]/g, "\\$&")}%`);
    const { data, error } = await rows.range(offset, offset + 999);
    if (error) throw error;
    transactions.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const summarize = (rows: typeof transactions) => {
  const total = summarizeCashflow(rows.map(row => ({
    amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code,
    status: row.status as CashflowTransaction["status"], kind: row.kind as CashflowTransaction["kind"],
    reviewReasons: row.review_reasons,
  })), workspace.display_currency);
  return total ? { incomeMinor: total.incomeMinor.toString(), spendingMinor: total.spendingMinor.toString(), netMinor: total.netMinor.toString(),
    excludedReviewRows: total.excludedReviewRows ?? 0, partial: total.partial ?? false }
    : { unavailable: "Some transactions require currency conversion" };
  };
  const accounts = new Map<string, typeof transactions>();
  for (const row of transactions) {
    if (!row.account_id) continue;
    const group = accounts.get(row.account_id) ?? [];
    group.push(row); accounts.set(row.account_id, group);
  }
  const summary = summarize(transactions);
  const byAccount = [...accounts].map(([id, rows]) => ({ id, ...summarize(rows) }));
  return { summary, byAccount, transactions: transactions.filter(row => !row.review_reasons?.length), currency: workspace.display_currency, from, to, timezone: workspace.timezone ?? "Europe/Berlin" };
}

export async function tripForArtifact(artifactId: string, costMinor: bigint) {
  const { workspace } = await requirePermission(artifactId, "forecast");
  const baseline = await evaluatePlan(30);
  const today = calendarDate(new Date(), workspace.timezone);
  const tripDate = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const account = baseline.input.accounts.find(item => item.currencyCode === workspace.display_currency && item.balanceMinor !== null);
  const withTrip = account ? availableToSpend({ ...baseline.input, scenarioEvents: [
    ...(baseline.input.scenarioEvents ?? []),
    { date: tripDate, accountId: account.id, expectedMinor: -costMinor,
      conservativeMinor: -costMinor, optimisticMinor: -costMinor },
  ] }) : null;
  return { baseline: baseline.available, withTrip, tripDate, currency: workspace.display_currency,
    unavailable: account ? null : "A dated balance in the display currency is required" };
}

export async function goalsForArtifact(artifactId: string) {
  const { supabase, workspace } = await requirePermission(artifactId, "goals");
  const [{ data: goals, error: goalsError }, { data: allocations, error: allocationsError }, balances] = await Promise.all([
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date, status, recorded_saved_minor::text, saved_as_of, planned_monthly_minor::text, contribution_starts_on")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
    supabase.from("goal_allocations").select("goal_id, account_id, amount_minor::text")
      .eq("workspace_id", workspace.id),
    getBalances(),
  ]);
  if (goalsError || allocationsError) throw goalsError ?? allocationsError;
  return { goals: goals ?? [], allocations: allocations ?? [], balances, currency: workspace.display_currency, timezone: workspace.timezone };
}
