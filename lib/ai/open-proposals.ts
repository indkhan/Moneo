import type { SupabaseClient } from "@supabase/supabase-js";
import { transactionAccountOptions } from "@/lib/ai/transaction-proposals";

/** Card kinds that live outside an agent run: raised by chat or detection, decided one at a time. */
export const STANDALONE_KINDS = ["iou_create", "iou_settle", "transaction_create", "balance_set", "recurring_edit"];

/** Card ids an assistant answer shows in its moneo-proposal(s) blocks. */
export function answerCardIds(content: string | null | undefined): string[] {
  return [...(content ?? "").matchAll(/```moneo-proposals?\n([\s\S]*?)```/g)].flatMap(match => match[1].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);
}

/** A bank transaction a card is about (a repayment, a flagged charge), shown under the card so it can be decided there. */
export type CardTransaction = { id: string; date: string; description: string; amountMinor: string; currency: string };
export type OpenProposal = { id: string; kind: string; title: string; detail: string; status: string; conflict_key?: string; accounts?: { id: string; name: string }[]; selected?: string | null; needsCash?: boolean;
  transactions?: CardTransaction[] };

export const cardTransactions = (evidence: unknown): CardTransaction[] => {
  const rows = (evidence as { transactions?: unknown } | null)?.transactions;
  return Array.isArray(rows) ? rows.filter((row): row is CardTransaction => typeof row?.id === "string" && typeof row?.amountMinor === "string").slice(0, 8) : [];
};

/** Every open standalone card, oldest first, as IouCard shows it; an expense card carries the accounts it can be paid from. */
export async function openStandaloneProposals(supabase: SupabaseClient, workspaceId: string): Promise<OpenProposal[]> {
  const { data, error } = await supabase.from("agent_proposals").select("id, kind, title, detail, status, conflict_key, payload, evidence").eq("workspace_id", workspaceId).is("run_id", null)
    .in("kind", STANDALONE_KINDS).in("status", ["proposed", "failed"]).order("created_at").limit(100);
  if (error) throw new Error(error.message);
  return Promise.all((data ?? []).map(async ({ payload, evidence, ...row }) => {
    const transactions = cardTransactions(evidence), proposal = transactions.length ? { ...row, transactions } : row;
    // Without options the card still accepts into the proposed account, so one unreadable payload does not hide the rest.
    return proposal.kind === "transaction_create" ? { ...proposal, ...await transactionAccountOptions(supabase, workspaceId, payload).catch(() => ({})) } : proposal;
  }));
}
