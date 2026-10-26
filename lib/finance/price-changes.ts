import type { SupabaseClient } from "@supabase/supabase-js";

type Charge = { amountMinor: bigint; currencyCode: string; postedOn: string };

/** The change between a series' two latest posted charges in the same currency (positive = price went up), or null. */
export function latestPriceChange(charges: Charge[]) {
  const [latest, previous] = [...charges].sort((a, b) => b.postedOn.localeCompare(a.postedOn));
  if (!latest || !previous || latest.currencyCode !== previous.currencyCode) return null;
  const abs = (value: bigint) => value < 0n ? -value : value;
  const changeMinor = abs(latest.amountMinor) - abs(previous.amountMinor);
  return changeMinor === 0n ? null : { changeMinor, currencyCode: latest.currencyCode, since: latest.postedOn };
}

/** Price changes for confirmed recurring payments, keyed by "accountId:assumption name" to match forecast events. */
export async function loadPriceChanges(db: SupabaseClient, workspaceId: string) {
  const series = await db.from("recurring_series").select("id, assumption_id").eq("workspace_id", workspaceId).not("assumption_id", "is", null).limit(500);
  if (series.error) throw series.error;
  const assumptionIds = (series.data ?? []).map(row => row.assumption_id as string);
  if (!assumptionIds.length) return new Map<string, ReturnType<typeof latestPriceChange>>();
  const [assumptions, links] = await Promise.all([
    db.from("financial_assumptions").select("id, account_id, name").eq("workspace_id", workspaceId).in("id", assumptionIds),
    db.from("recurring_series_transactions").select("series_id, transaction_id").eq("workspace_id", workspaceId).in("series_id", (series.data ?? []).map(row => row.id)).limit(5000),
  ]);
  if (assumptions.error || links.error) throw assumptions.error ?? links.error;
  const ids = (links.data ?? []).map(row => row.transaction_id as string);
  const pages = await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, async (_, index) => {
    const page = await db.from("transactions").select("id, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspaceId).eq("status", "posted").in("id", ids.slice(index * 100, index * 100 + 100));
    if (page.error) throw page.error;
    return page.data as { id: string; amount_minor: string; currency_code: string; posted_on: string }[];
  }));
  const charges = new Map(pages.flat().map(row => [row.id, { amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code, postedOn: row.posted_on }]));
  const names = new Map((assumptions.data ?? []).map(row => [row.id as string, `${row.account_id}:${row.name}`]));
  const result = new Map<string, ReturnType<typeof latestPriceChange>>();
  for (const row of series.data ?? []) {
    const key = names.get(row.assumption_id as string);
    const change = latestPriceChange((links.data ?? []).filter(link => link.series_id === row.id).flatMap(link => charges.get(link.transaction_id) ?? []));
    if (key && change) result.set(key, change);
  }
  return result;
}
