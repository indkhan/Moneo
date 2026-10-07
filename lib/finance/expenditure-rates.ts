import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenditureOptions, ExpenditureRate } from "./expenditure";

export async function loadExpenditureRates(db: SupabaseClient, workspaceId: string, options: Pick<ExpenditureOptions, "currencyCode" | "from" | "to">): Promise<ExpenditureRate[]> {
  const rates: ExpenditureRate[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from("fx_rates").select("id, from_currency, to_currency, rate_text, rate_date, source")
      .eq("workspace_id", workspaceId).eq("to_currency", options.currencyCode)
      .gte("rate_date", options.from).lte("rate_date", options.to).order("id").range(offset, offset + 499);
    if (error) throw error;
    rates.push(...(data ?? []).map(row => ({ id: row.id, fromCurrency: row.from_currency, toCurrency: row.to_currency, rateText: row.rate_text, rateDate: row.rate_date, source: row.source })));
    if (!data || data.length < 500) return rates;
  }
}
