import { requireWorkspace } from "@/lib/auth";
import { listFreeModels } from "@/lib/ai/provider";
import { SettingsForm } from "./form";

export default async function SettingsPage() {
  const { user, workspace, settings } = await requireWorkspace();
  let models: { id: string; name: string }[] = [], catalogueError: string | undefined;
  try { models = await listFreeModels(); } catch (error) { catalogueError = error instanceof Error ? error.message : "Model availability could not be checked"; }
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
    <div><h1 className="text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 text-muted-foreground">Your private workspace · {user.email ?? "Signed in"}</p></div>
    <SettingsForm settings={settings} currency={workspace.display_currency} models={models} catalogueError={catalogueError}
      defaultModel={process.env.OPENROUTER_MODEL ?? "qwen/qwen3.8-27b:free"} />
    <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">AI usage</h2><p className="mt-2 text-sm text-muted-foreground">Provider usage is shown when available in Activity. Missing token counts or costs are unknown; they are not reported as zero.</p></section>
  </main>;
}
