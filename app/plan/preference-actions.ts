"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { parseManualAmount } from "@/app/money/transactions/input";
import { forecastPreferencesSchema } from "@/lib/finance/preferences";

export async function saveForecastPreferences(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const currency = z.string().regex(/^[A-Z]{3}$/).parse(form.get("currency"));
  const record = forecastPreferencesSchema.parse({ currency_code: currency,
    safety_buffer_minor: parseManualAmount(String(form.get("buffer") ?? ""), currency).toString(),
    daily_spending_minor: parseManualAmount(String(form.get("dailySpending") ?? ""), currency).toString(),
    uncertainty_bps: z.coerce.number().int().min(0).max(10000).parse(form.get("uncertaintyBps")),
    spending_account_id: form.get("spendingAccountId") || null,
    spending_starts_on: form.get("spendingStartsOn") || null });
  const { error } = await supabase.rpc("edit_forecast_preferences", { p_workspace_id: workspace.id, p_record: record,
    p_expected_version: z.coerce.number().int().min(0).max(2147483646).parse(form.get("version")), p_request_id: z.uuid().parse(form.get("requestId")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/plan");
}
export async function undoForecastPreferences(form: FormData) {
  const { supabase } = await requireWorkspace();
  const { error } = await supabase.rpc("undo_forecast_preferences", { p_event_id: z.uuid().parse(form.get("eventId")), p_expected_version: z.coerce.number().int().min(1).max(2147483646).parse(form.get("version")) });
  if (error) throw new Error(error.message);
  revalidatePath("/", "layout"); redirect("/plan");
}
