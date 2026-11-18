import type { SupabaseClient } from "@supabase/supabase-js";
import { loadLoanPayoutIds } from "@/lib/finance/iou";
import { cardTransactions, type CardTransaction } from "@/lib/ai/open-proposals";

export type HomeFinding = { ids: string[]; title: string; detail: string; href: string | null; transactions: CardTransaction[] };
export type HomeReview = { uncategorized: number; findings: HomeFinding[] };

type FindingRow = { id: string; conflict_key: string; title: string; detail: string; evidence: { links?: { href: string }[]; transactions?: { id: string }[] } | null };

function readSkippedAt(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export async function loadHomeReview(supabase: SupabaseClient, workspaceId: string): Promise<HomeReview> {
  const loans = await loadLoanPayoutIds(supabase, workspaceId);
  const uncategorizedSince = (since: string | null) => {
    let count = supabase.from("transactions").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "posted").is("category_id", null).neq("kind", "transfer");
    if (since) count = count.gt("created_at", since);
    if (loans.size) count = count.not("id", "in", `(${[...loans].join(",")})`);
    return count;
  };
  const skipped = await supabase.from("workspace_settings").select("uncategorized_skipped_at").eq("workspace_id", workspaceId).maybeSingle();
  const skippedAt = skipped.error ? null : readSkippedAt(skipped.data?.uncategorized_skipped_at);
  const [uncategorized, arrived, findings] = await Promise.all([
    uncategorizedSince(null),
    skippedAt ? uncategorizedSince(skippedAt) : null,
    supabase.from("agent_proposals").select("id, conflict_key, title, detail, evidence").eq("workspace_id", workspaceId).eq("kind", "finding").eq("status", "proposed")
      .not("run_id", "is", null).order("created_at", { ascending: false }).limit(300),
  ]);
  if (uncategorized.error) throw new Error(uncategorized.error.message);
  if (arrived?.error) throw new Error(arrived.error.message);
  if (findings.error) throw new Error(findings.error.message);
  const byKey = new Map<string, HomeFinding>();
  for (const row of (findings.data ?? []) as FindingRow[]) {
    if (row.evidence?.transactions?.length && row.evidence.transactions.every(item => loans.has(item.id))) continue;
    const known = byKey.get(row.conflict_key);
    if (known) { known.ids.push(row.id); continue; }
    const transaction = row.evidence?.transactions?.[0]?.id;
    byKey.set(row.conflict_key, { ids: [row.id], title: row.title, detail: row.detail, transactions: cardTransactions(row.evidence),
      href: transaction ? `/money/transactions?transaction=${transaction}` : row.evidence?.links?.[0]?.href ?? null });
  }
  const hidden = arrived !== null && !arrived.count;
  return { uncategorized: hidden ? 0 : uncategorized.count ?? 0, findings: [...byKey.values()] };
}
