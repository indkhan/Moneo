"use server";

import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

/** What a chat card shows for a proposal. Accepting or dismissing goes through decideAgentProposals. */
export async function loadIouProposal(id: string) {
  const parsed = z.uuid().parse(id);
  const { supabase, workspace } = await requireWorkspace();
  const { data } = await supabase.from("agent_proposals").select("id, title, detail, status, result").eq("workspace_id", workspace.id).eq("id", parsed)
    .in("kind", ["iou_create", "iou_settle"]).maybeSingle();
  return data as { id: string; title: string; detail: string; status: string; result: { error?: string } | null } | null;
}
