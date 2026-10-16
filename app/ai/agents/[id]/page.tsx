import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadAgentRun } from "@/lib/agents/state";
import { MissionControl } from "@/components/mission-control";

export default async function AgentRunPage({ params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const run = await loadAgentRun(context.supabase, context.workspace.id, id.data);
  if (!run) notFound();
  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 lg:py-8"><MissionControl initial={run} locale={context.workspace.locale} /></main>;
}
