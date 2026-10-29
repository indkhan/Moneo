import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiDataScope } from "@/lib/settings";

const MAX_TERMS = 80;
const MAX_TERM_LENGTH = 60;

/**
 * Names that help speech-to-text spell a spoken note the way the workspace does: accounts, the most
 * used recent merchants, then categories. Bounded and limited to the AI data scopes Settings allows.
 */
export async function loadVoiceVocabulary(supabase: SupabaseClient, workspaceId: string, scopes: readonly AiDataScope[]): Promise<string[]> {
  const transactions = scopes.includes("transactions");
  const [accounts, categories, recent] = await Promise.all([
    scopes.includes("accounts") ? supabase.from("accounts").select("name").eq("workspace_id", workspaceId).is("archived_at", null).order("name").limit(30) : null,
    transactions ? supabase.from("categories").select("name").eq("workspace_id", workspaceId).order("name").limit(60) : null,
    transactions ? supabase.from("transactions").select("merchants(name)").eq("workspace_id", workspaceId).not("merchant_id", "is", null)
      .order("posted_on", { ascending: false }).limit(500) : null,
  ]);
  for (const result of [accounts, categories, recent]) if (result?.error) throw result.error;
  const uses = new Map<string, number>();
  for (const row of (recent?.data ?? []) as { merchants: { name: string } | { name: string }[] | null }[])
    for (const merchant of [row.merchants ?? []].flat()) uses.set(merchant.name, (uses.get(merchant.name) ?? 0) + 1);
  const merchants = [...uses].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name]) => name);
  const names = [...(accounts?.data ?? []), ...merchants.map(name => ({ name })), ...(categories?.data ?? [])].map(row => (row as { name: string }).name.trim());
  return [...new Set(names.filter(name => name && name.length <= MAX_TERM_LENGTH))].slice(0, MAX_TERMS);
}
