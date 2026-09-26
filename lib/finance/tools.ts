import { z } from "zod";
import { summarizeCashflow } from "./calculations";
import { requireWorkspace } from "@/lib/auth";
import { evaluatePlan } from "./model";

const periodInput = z.object({ from: z.iso.date(), to: z.iso.date(), currencyCode: z.string().regex(/^[A-Z]{3}$/) });
const searchInput = z.object({ query: z.string().min(1).max(100) });

export async function listAccounts() {
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("accounts").select("id, name, type, currency_code")
    .eq("workspace_id", workspace.id).order("name");
  if (error) throw error;
  return data;
}

export async function getBalances() {
  const { supabase, workspace } = await requireWorkspace();
  const [{ data: accounts, error: accountsError }, { data: snapshots, error: snapshotsError }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code").eq("workspace_id", workspace.id),
    supabase.from("balance_snapshots").select("account_id, amount_minor, currency_code, as_of, provenance")
      .eq("workspace_id", workspace.id).order("as_of", { ascending: false }),
  ]);
  if (accountsError) throw accountsError;
  if (snapshotsError) throw snapshotsError;
  const latest = new Map<string, NonNullable<typeof snapshots>[number]>();
  for (const snapshot of snapshots ?? []) if (!latest.has(snapshot.account_id)) latest.set(snapshot.account_id, snapshot);
  return accounts?.map(account => ({ ...account, balance: latest.get(account.id) ?? null })) ?? [];
}

export async function cashflow(input: unknown) {
  const { from, to, currencyCode } = periodInput.parse(input);
  if (from > to) throw new Error("From date is after to date");
  const { supabase, workspace } = await requireWorkspace();
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("transactions")
      .select("amount_minor, currency_code, status, kind")
      .eq("workspace_id", workspace.id).gte("posted_on", from).lte("posted_on", to)
      .order("id")
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const total = summarizeCashflow(rows.map(row => ({
    amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code,
    status: row.status as "posted" | "pending", kind: row.kind as "ordinary" | "transfer" | "refund",
  })), currencyCode);
  return total ? {
    from, to, currencyCode, incomeMinor: total.incomeMinor.toString(),
    spendingMinor: total.spendingMinor.toString(), netMinor: total.netMinor.toString(),
    evidence: { transactionCount: rows.length, excludedPendingAndTransfers: true },
  } : { unavailable: "Some transactions require currency conversion", from, to, currencyCode };
}

export async function searchTransactions(input: unknown) {
  const { query } = searchInput.parse(input);
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("transactions")
    .select("id, posted_on, description, amount_minor, currency_code, status, kind")
    .eq("workspace_id", workspace.id).ilike("description", `%${query.replace(/[%_]/g, "\\$&")}%`)
    .order("posted_on", { ascending: false }).limit(20);
  if (error) throw error;
  return data;
}

export async function listGoals() {
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("goals")
    .select("id, name, target_minor, currency_code, target_date, status")
    .eq("workspace_id", workspace.id).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function evaluateForecast(input: unknown) {
  const args = z.object({ horizonDays: z.number().int().min(1).max(365).default(30), scenarioId: z.uuid().optional() }).parse(input);
  const { forecast, available, input: assumptions } = await evaluatePlan(args.horizonDays, args.scenarioId);
  if (forecast.status === "unavailable" || available.status === "unavailable")
    return { status: "unavailable", missingInputs: [...new Set([
      ...(forecast.status === "unavailable" ? forecast.missingInputs : []),
      ...(available.status === "unavailable" ? available.missingInputs : []),
    ])] };
  const last = forecast.days.at(-1)!;
  return { status: "available", currencyCode: assumptions.currencyCode, horizonDays: args.horizonDays,
    expectedMinor: last.expectedMinor.toString(), conservativeMinor: last.conservativeMinor.toString(),
    optimisticMinor: last.optimisticMinor.toString(), availableToSpendMinor: available.amountMinor.toString(),
    limitingDate: available.limitingDate, casesAreAssumptionsNotProbabilities: true };
}

export const financeToolSchemas = { periodInput, searchInput };
