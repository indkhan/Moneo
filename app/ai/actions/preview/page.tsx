import Link from "next/link";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope } from "@/lib/settings";
import { categoryPreviewSchema, loadCategoryPreview } from "@/lib/finance/edit-preview";
import { CategoryApproval } from "./category-approval";

export const metadata = { title: "Review changes" };

export default async function ActionPreview({ searchParams }: { searchParams: Promise<{ ids?: string; category?: string }> }) {
  const { supabase, workspace, settings } = await requireWorkspace();
  const params = await searchParams;
  let preview: Awaited<ReturnType<typeof loadCategoryPreview>>;
  try {
    requireAiScope(settings, "transactions");
    const input = categoryPreviewSchema.parse({ transactionIds: (params.ids ?? "").split(","), categoryId: params.category });
    preview = await loadCategoryPreview(supabase, workspace.id, input.transactionIds, input.categoryId);
  } catch (cause) {
    const scope = cause instanceof Error && cause.message.startsWith("AI access to");
    const badLink = cause instanceof z.ZodError;
    return <main className="mx-auto max-w-3xl p-6"><h1 className="page-title">Action preview unavailable</h1>
      <p className="mt-3">{scope ? "Moneo’s AI is not allowed to read transactions, so it cannot prepare this change." : badLink ? "This link does not name an exact selection and category. Select entries in Money to review changes." : "That selection has changed or could not be loaded."}</p>
      <p className="mt-3 flex gap-4">{scope ? <Link href="/settings" className="underline">Review AI access in Settings</Link> : !badLink && <Link href={`/ai/actions/preview?${new URLSearchParams({ ids: params.ids ?? "", category: params.category ?? "" })}`} className="underline">Try again</Link>}<Link href="/money/transactions" className="underline">Open transactions</Link></p></main>;
  }
  const categoryIds = [...new Set([preview.category.id, ...preview.rows.flatMap(row => row.category_id ? [row.category_id] : [])])];
  const categories = await supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).in("id", categoryIds);
  if (categories.error) return <main className="mx-auto max-w-3xl p-6"><h1 className="page-title">Action preview unavailable</h1><p role="alert" className="mt-3">Could not load the categories for this change. <Link href={`/ai/actions/preview?${new URLSearchParams({ ids: params.ids ?? "", category: params.category ?? "" })}`} className="underline">Try again</Link></p></main>;
  return <main className="mx-auto max-w-3xl space-y-5 p-6"><h1 className="page-title">Review proposed category changes</h1>
    <p>Set {preview.rows.length} selected transactions to {preview.category.name}. Nothing changes until you apply.</p>
    <p className="text-sm text-muted-foreground">{preview.warning}</p>
    <CategoryApproval rows={preview.rows} category={preview.category} names={Object.fromEntries(categories.data.map(row => [row.id, row.name]))} requestId={crypto.randomUUID()} locale={workspace.locale} />
    <Link href="/ai" className="inline-block text-sm underline">Return to conversation</Link>
  </main>;
}
