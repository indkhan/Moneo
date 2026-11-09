import type { SupabaseClient } from "@supabase/supabase-js";
import { recurringCadences } from "@/lib/finance/cadences";
import { formatMoney } from "@/lib/finance/format";
import { loadWealthItems, wealthOverview } from "@/lib/finance/wealth";
import type { AiDataScope } from "@/lib/settings";

type Context = { supabase: SupabaseClient; workspace: { id: string; locale: string }; settings: { ai_data_scopes: AiDataScope[] } };

/** A short "About the owner" brief for each chat, so the model already knows their accounts, the people they lent
 * to or borrowed from, and their recurring payments, the way an assistant would. Only allowed scopes are read;
 * `scopes` lists what was read so later tool results keep the same checks. */
export async function ownerBrief({ supabase, workspace, settings }: Context) {
  const allowed = (scope: AiDataScope) => settings.ai_data_scopes.includes(scope);
  const money = (minor: string, currency: string) => formatMoney(minor, currency, workspace.locale);
  // Names are record data: one line each and quoted, so a name can never read as a heading or an instruction.
  const name = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim().slice(0, 80));
  const scopes: AiDataScope[] = [];
  const [accounts, people, recurring] = await Promise.all([
    allowed("accounts") ? supabase.from("accounts").select("name, type, currency_code").eq("workspace_id", workspace.id)
      .is("archived_at", null).order("name").limit(50).then(({ data, error }) => {
        if (error) throw error;
        scopes.push("accounts");
        return (data ?? []).map(row => `${name(row.name)} (${row.type}, ${row.currency_code})`);
      }) : null,
    allowed("planning") ? loadWealthItems(supabase, workspace.id).then(items => {
      scopes.push("planning");
      return wealthOverview(items).items.filter(item => item.person).slice(0, 50)
        .map(item => `${name(item.person!)}: ${item.group === "lent" ? "owes you" : "you owe"} ${item.amountFormatted} (since ${item.asOf})`);
    }) : null,
    allowed("planning") && allowed("transactions") ? supabase.from("financial_assumptions").select("name, amount_minor::text, currency_code, cadence")
      .eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).is("removed_at", null).in("cadence", recurringCadences)
      .order("name").limit(30).then(({ data, error }) => {
        if (error) throw error;
        scopes.push("planning", "transactions");
        return ((data ?? []) as { name: string; amount_minor: string; currency_code: string; cadence: string }[])
          .map(row => `${name(row.name)}: ${money(row.amount_minor.replace("-", ""), row.currency_code)} ${row.amount_minor.startsWith("-") ? "out" : "in"}, ${row.cadence}`);
      }) : null,
  ]);
  const section = (title: string, lines: string[] | null) => lines === null ? [] : [`${title}: ${lines.length ? lines.join("; ") : "none"}`];
  const text = [...section("Accounts", accounts), ...section("People with open loans", people), ...section("Recurring payments", recurring)].join("\n");
  return { text, scopes: [...new Set(scopes)] };
}
