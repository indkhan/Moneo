import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";

export default async function ImportReviewPage({ params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { redirect("/login"); }
  const { id } = await params;
  const { supabase, workspace } = context;
  const { data: imported } = await supabase.from("imports").select("id, filename, status, review_rows")
    .eq("workspace_id", workspace.id).eq("id", id).maybeSingle();
  if (!imported) notFound();
  const { data: rows, error } = await supabase.from("source_transactions")
    .select("id, row_number, original_row, external_id")
    .eq("workspace_id", workspace.id).eq("import_id", id).eq("status", "review")
    .order("row_number").limit(100);

  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/import" className="underline">← Import history</Link>
    <h1 className="text-2xl font-semibold">Review: {imported.filename}</h1>
    <p>{imported.review_rows} ambiguous rows. They are excluded from accepted totals.</p>
    {error && <p role="alert">Could not load review rows: {error.message}</p>}
    {!error && !rows?.length && <p>No rows awaiting review.</p>}
    {rows?.map((row) => <article className="rounded border p-4" key={row.id}>
      <h2 className="font-medium">Source row {row.row_number}</h2>
      {row.external_id && <p className="text-sm">Source ID: {row.external_id}</p>}
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">{JSON.stringify(row.original_row, null, 2)}</pre>
    </article>)}
    {rows?.length === 100 && <p>Showing the first 100 rows.</p>}
  </main>;
}
