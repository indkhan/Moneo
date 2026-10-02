import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope } from "@/lib/settings";
import { categoryPreviewSchema, loadCategoryPreview } from "@/lib/finance/edit-preview";
import { BulkEditor } from "@/app/money/transactions/bulk-editor";
import { formatMoney } from "@/lib/finance/format";

export default async function ActionPreview({ searchParams }: { searchParams: Promise<{ ids?: string; category?: string }> }) {
  const { supabase, workspace, settings } = await requireWorkspace();
  const params = await searchParams;
  let preview: Awaited<ReturnType<typeof loadCategoryPreview>>;
  try {
    requireAiScope(settings, "transactions");
    const input = categoryPreviewSchema.parse({ transactionIds: (params.ids ?? "").split(","), categoryId: params.category });
    preview = await loadCategoryPreview(supabase, workspace.id, input.transactionIds, input.categoryId);
  } catch {
    return <main className="mx-auto max-w-3xl p-6"><h1 className="text-2xl font-semibold">Action preview unavailable</h1><p className="mt-3">The exact selection, category or permission is unavailable. Select entries in Money to review changes.</p><Link href="/money/transactions" className="mt-3 inline-block underline">Open transactions</Link></main>;
  }
  const categoryIds = [...new Set([preview.category.id, ...preview.rows.flatMap(row => row.category_id ? [row.category_id] : [])])];
  const categories = await supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).in("id", categoryIds);
  if (categories.error) throw categories.error;
  return <main className="mx-auto max-w-3xl space-y-5 p-6"><h1 className="text-2xl font-semibold">Review proposed category changes</h1>
    <p>Set {preview.rows.length} selected transactions to {preview.category.name}. Check each entry and preview its current category before applying.</p>
    <p className="text-sm">Selected amounts: {Object.entries(preview.totals).map(([currency, amount]) => formatMoney(amount, currency, workspace.locale)).join(" · ")}. Separate currencies remain separate.</p>
    <p className="text-sm text-muted-foreground">{preview.warning}</p>
    <BulkEditor rows={preview.rows} categories={categories.data} query="" requestId={crypto.randomUUID()} initialSelected={preview.rows.map(row => row.id)} initialCategory={preview.category.id} locale={workspace.locale} />
    <Link href="/ai" className="inline-block text-sm underline">Return to conversation</Link>
  </main>;
}
