"use server";

import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { STANDALONE_KINDS, cardTransactions, type CardTransaction } from "@/lib/ai/open-proposals";
import { transactionAccountOptions } from "@/lib/ai/transaction-proposals";
import { cashAccountOptions } from "@/lib/ai/cash-proposals";
import { TRADE_KINDS, type TradeReview } from "@/lib/scalable/orders";

export type ChatProposal = { id: string; kind: string; title: string; detail: string; status: string; result: { error?: string; href?: string; createdAccount?: boolean; unknown?: boolean; reference?: string | null } | null;
  accounts?: { id: string; name: string }[]; selected?: string | null; createsCash?: boolean; conflict_key?: string; transactions?: CardTransaction[]; trade?: TradeReview };

export async function loadIouProposal(id: string): Promise<ChatProposal | null> {
  const parsed = z.uuid().parse(id);
  const { supabase, workspace } = await requireWorkspace();
  const { data } = await supabase.from("agent_proposals").select("id, kind, title, detail, status, result, payload, conflict_key, evidence").eq("workspace_id", workspace.id).eq("id", parsed)
    .in("kind", [...STANDALONE_KINDS, ...TRADE_KINDS]).maybeSingle();
  if (!data) return null;
  const { payload, evidence, ...row } = data;
  if (TRADE_KINDS.includes(row.kind)) return { ...row, trade: (evidence as { trade: TradeReview }).trade };
  const proposal = { ...row, transactions: cardTransactions(evidence) };
  const open = proposal.status === "proposed" || proposal.status === "failed";
  if (proposal.kind === "cash_withdrawal" && open) return { ...proposal, ...await cashAccountOptions(supabase, workspace.id, payload) };
  return proposal.kind === "transaction_create" && open ? { ...proposal, ...await transactionAccountOptions(supabase, workspace.id, payload) } : proposal;
}
