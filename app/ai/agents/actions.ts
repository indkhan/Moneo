"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { decideProposals } from "@/lib/ai/agent-apply";

/** Accept or reject proposals; accepted ones go through the existing audited actions. */
export async function decideAgentProposals(ids: string[], decision: "accept" | "reject", accountId?: string) {
  const input = z.object({ ids: z.array(z.uuid()).min(1).max(100), decision: z.enum(["accept", "reject"]), accountId: z.uuid().optional() }).parse({ ids, decision, accountId });
  const outcomes = await decideProposals(await requireWorkspace(), [...new Set(input.ids)], input.decision, { accountId: input.accountId });
  revalidatePath("/", "layout");
  return outcomes;
}

/** Titles and current statuses for a chat decision card. */
export async function loadAgentProposals(ids: string[]) {
  const parsed = z.array(z.uuid()).min(1).max(100).parse(ids);
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("agent_proposals").select("id, run_id, title, status").eq("workspace_id", workspace.id).in("id", parsed).not("run_id", "is", null);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; run_id: string; title: string; status: string }[];
}
