import { requireWorkspace } from "@/lib/auth";
import { availableToSpend } from "@/lib/finance/calculations";
import { evaluatePlan } from "@/lib/finance/model";
import { cashflow, getBalances } from "@/lib/finance/tools";

async function requirePermission(artifactId: string, permission: string) {
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("artifacts")
    .select("permissions, active_version_id").eq("id", artifactId).eq("workspace_id", workspace.id).single();
  if (error || !data?.active_version_id || !Array.isArray(data.permissions) || !data.permissions.includes(permission))
    throw new Error("Artifact permission denied");
  return { supabase, workspace };
}

export async function spendingForArtifact(artifactId: string, query: string) {
  const { supabase, workspace } = await requirePermission(artifactId, "spending");
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  const summary = await cashflow({ from, to, currencyCode: workspace.display_currency });
  let rows = supabase.from("transactions")
    .select("id, posted_on, description, amount_minor, currency_code, category_id")
    .eq("workspace_id", workspace.id).eq("status", "posted").eq("kind", "ordinary")
    .gte("posted_on", from).lte("posted_on", to).order("posted_on", { ascending: false }).limit(50);
  if (query) rows = rows.ilike("description", `%${query.replace(/[%_]/g, "\\$&")}%`);
  const { data: transactions, error } = await rows;
  if (error) throw error;
  return { summary, transactions: transactions ?? [], currency: workspace.display_currency, from, to };
}

export async function tripForArtifact(artifactId: string, costMinor: bigint) {
  const { workspace } = await requirePermission(artifactId, "forecast");
  const baseline = await evaluatePlan(30);
  const tripDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
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
    supabase.from("goals").select("id, name, target_minor, currency_code, target_date, status")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
    supabase.from("goal_allocations").select("goal_id, account_id, amount_minor")
      .eq("workspace_id", workspace.id),
    getBalances(),
  ]);
  if (goalsError || allocationsError) throw goalsError ?? allocationsError;
  return { goals: goals ?? [], allocations: allocations ?? [], balances };
}
