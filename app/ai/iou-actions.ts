"use server";

import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { STANDALONE_KINDS } from "@/lib/ai/open-proposals";
import { transactionAccountOptions } from "@/lib/ai/transaction-proposals";

export type ChatProposal = { id: string; kind: string; title: string; detail: string; status: string; result: { error?: string; href?: string; createdAccount?: boolean } | null;
  accounts?: { id: string; name: string }[]; selected?: string | null; needsCash?: boolean };

/** What a chat card shows for a proposal. Accepting or dismissing goes through decideAgentProposals. */
export async function loadIouProposal(id: string): Promise<ChatProposal | null> {
  const parsed = z.uuid().parse(id);
  const { supabase, workspace } = await requireWorkspace();
  const { data } = await supabase.from("agent_proposals").select("id, kind, title, detail, status, result, payload").eq("workspace_id", workspace.id).eq("id", parsed)
    .in("kind", STANDALONE_KINDS).maybeSingle();
  if (!data) return null;
  const { payload, ...proposal } = data;
  // Only an open expense card needs the accounts it can be paid from.
  const open = proposal.status === "proposed" || proposal.status === "failed";
  return proposal.kind === "transaction_create" && open ? { ...proposal, ...await transactionAccountOptions(supabase, workspace.id, payload) } : proposal;
}
