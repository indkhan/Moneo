import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

export const categoryPreviewSchema = z.object({ transactionIds: z.array(z.uuid()).min(1).max(50).refine(ids => new Set(ids).size === ids.length), categoryId: z.uuid() }).strict();
export async function loadCategoryPreview(db: SupabaseClient, workspaceId: string, transactionIds: string[], categoryId: string) {
  const input = categoryPreviewSchema.parse({ transactionIds, categoryId });
  const [entries, category] = await Promise.all([
    db.from("transactions").select("id, version, description, posted_on, amount_minor::text, currency_code, category_id, tags, event_name")
      .eq("workspace_id", workspaceId).neq("status", "voided").in("id", input.transactionIds),
    db.from("categories").select("id, name").eq("workspace_id", workspaceId).eq("id", input.categoryId).maybeSingle(),
  ]);
  if (entries.error || category.error) throw entries.error ?? category.error;
  if (!category.data || entries.data.length !== input.transactionIds.length) throw new Error("The exact selection or category is unavailable");
  const totals: Record<string, string> = {};
  for (const row of entries.data) totals[row.currency_code] = ((BigInt(totals[row.currency_code] ?? "0")) + BigInt(row.amount_minor)).toString();
  const url = new URLSearchParams({ ids: input.transactionIds.join(","), category: input.categoryId });
  return { rows: entries.data, category: category.data, totals, href: `/ai/actions/preview?${url}`,
    warning: "Preview only. Review the exact entries and confirm in the application. Financial amounts and sources are preserved; version conflicts or linked/split category restrictions may refuse the change." };
}
