import type { SupabaseClient } from "@supabase/supabase-js";
import { transactionAccountOptions } from "@/lib/ai/transaction-proposals";
import { cashAccountOptions } from "@/lib/ai/cash-proposals";

export const STANDALONE_KINDS = ["iou_create", "iou_settle", "transaction_create", "balance_set", "recurring_edit", "own_transfer", "cash_withdrawal", "organize_answer"];

export function answerCardIds(content: string | null | undefined): string[] {
  return [...(content ?? "").matchAll(/```moneo-proposals?\n([\s\S]*?)```/g)].flatMap(match => match[1].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);
}

export type CardTransaction = { id: string; date: string; description: string; amountMinor: string; currency: string };
export type OpenProposal = { id: string; kind: string; title: string; detail: string; status: string; conflict_key?: string; accounts?: { id: string; name: string }[]; selected?: string | null; createsCash?: boolean;
  transactions?: CardTransaction[] };

export const cardTransactions = (evidence: unknown): CardTransaction[] => {
  const rows = (evidence as { transactions?: unknown } | null)?.transactions;
  return Array.isArray(rows) ? rows.filter((row): row is CardTransaction => typeof row?.id === "string" && typeof row?.amountMinor === "string").slice(0, 8) : [];
};

export async function openStandaloneProposals(supabase: SupabaseClient, workspaceId: string): Promise<OpenProposal[]> {
  const { data, error } = await supabase.from("agent_proposals").select("id, kind, title, detail, status, conflict_key, payload, evidence").eq("workspace_id", workspaceId).is("run_id", null)
    .in("kind", STANDALONE_KINDS).in("status", ["proposed", "failed"]).order("created_at").limit(100);
  if (error) throw new Error(error.message);
  return Promise.all((data ?? []).map(async ({ payload, evidence, ...row }) => {
    const transactions = cardTransactions(evidence), proposal = transactions.length ? { ...row, transactions } : row;
    if (proposal.kind === "cash_withdrawal") return { ...proposal, ...await cashAccountOptions(supabase, workspaceId, payload) };
    return proposal.kind === "transaction_create" ? { ...proposal, ...await transactionAccountOptions(supabase, workspaceId, payload) } : proposal;
  }));
}
