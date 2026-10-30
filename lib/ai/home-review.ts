import type { SupabaseClient } from "@supabase/supabase-js";

export type HomeFinding = { ids: string[]; title: string; detail: string; href: string | null };
export type HomeReview = { uncategorized: number; findings: HomeFinding[] };

type FindingRow = { id: string; conflict_key: string; title: string; detail: string; evidence: { links?: { href: string }[]; transactions?: { id: string }[] } | null };

/** What the after-sync checks left for a person: uncategorized spending and open findings, one entry per finding however many runs raised it. */
export async function loadHomeReview(supabase: SupabaseClient, workspaceId: string): Promise<HomeReview> {
  const [uncategorized, findings] = await Promise.all([
    // Transfers between accounts need no category.
    supabase.from("transactions").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "posted").is("category_id", null).neq("kind", "transfer"),
    supabase.from("agent_proposals").select("id, conflict_key, title, detail, evidence").eq("workspace_id", workspaceId).eq("kind", "finding").eq("status", "proposed")
      .not("run_id", "is", null).order("created_at", { ascending: false }).limit(300),
  ]);
  if (uncategorized.error) throw new Error(uncategorized.error.message);
  if (findings.error) throw new Error(findings.error.message);
  const byKey = new Map<string, HomeFinding>();
  for (const row of (findings.data ?? []) as FindingRow[]) {
    const known = byKey.get(row.conflict_key);
    if (known) { known.ids.push(row.id); continue; }
    const transaction = row.evidence?.transactions?.[0]?.id;
    byKey.set(row.conflict_key, { ids: [row.id], title: row.title, detail: row.detail,
      href: transaction ? `/money/transactions?transaction=${transaction}` : row.evidence?.links?.[0]?.href ?? null });
  }
  return { uncategorized: uncategorized.count ?? 0, findings: [...byKey.values()] };
}
