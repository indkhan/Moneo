"use workflow";

// Long-running financial review. Started by the deployed backend, continues
// after the browser closes; progress is persisted in Supabase.
// Docs: https://vercel.com/docs/workflows (SDK package: `workflow@4.8.9`)
export async function financialReview(workflowRunId: string, workspaceId: string) {
  "use step";
  // Step 1: load workspace snapshot (Drizzle + Supabase).
  void workflowRunId;
  void workspaceId;
  // Step 2: run Finance SDK calculations (lib/finance).
  // Step 3: ask OpenRouter free model for narrative insights via controlled tools.
  // Step 4: save results + progress to Supabase so the UI can poll them.
  return { ok: true };
}
