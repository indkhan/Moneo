import type { requireWorkspace } from "@/lib/auth";
import { loadOrganizationSuggestions } from "@/lib/import/organization-loader";
import { payloadSchemas, type ProposalKind } from "@/lib/ai/agent-team";
import { calendarDate } from "@/lib/finance/calendar";
import { iouCreateSchema, iouRecord, iouSettleSchema, parseIouName, settledRecord } from "@/lib/finance/iou";
import { applyTransactionProposal } from "@/lib/ai/transaction-proposals";
import { applyBalanceProposal } from "@/lib/ai/balance-proposals";
import { applyRecurringProposal } from "@/lib/ai/recurring-proposals";

// Accepting a proposal calls the SAME audited RPCs a person uses by hand, as
// the signed-in owner (auth.uid()), so corrections, batches and Undo stay intact.
type Context = Awaited<ReturnType<typeof requireWorkspace>>;
export type StoredProposal = { id: string; kind: ProposalKind | "iou_create" | "iou_settle" | "transaction_create" | "balance_set" | "recurring_edit"; payload: unknown };
/** Choices made on the card itself, such as the account a chat expense is paid from. */
export type DecideOptions = { accountId?: string };
export type Applied = { href: string; undo?: string; [key: string]: unknown };

export async function applyProposal(context: Context, proposal: StoredProposal, options: DecideOptions = {}): Promise<Applied> {
  const { supabase, workspace } = context;
  switch (proposal.kind) {
    case "categorize": {
      const payload = payloadSchemas.categorize.parse(proposal.payload);
      // Same guard as a manual organization review: corrections and complete rows take precedence.
      const current = await loadOrganizationSuggestions(supabase, workspace.id, payload.rows);
      if (current.proposals.length !== payload.rows.length) throw new Error("Some rows were corrected or organized since the agent ran");
      const evidence = [...new Map(current.proposals.flatMap(item => item.evidence).map(row => [row.id, row])).values()];
      const created = await supabase.rpc("create_organization_review", { p_rows: payload.rows, p_patch: payload.patch, p_merchant_name: payload.merchantName,
        p_rule_key: payload.ruleKey, p_evidence: evidence, p_request_id: proposal.id });
      if (created.error) throw new Error(created.error.message);
      const reviewId = String(created.data.id);
      const applied = await supabase.rpc("apply_organization_review", { p_review_id: reviewId, p_save_rule: payload.ruleKey !== null });
      if (applied.error) throw new Error(applied.error.message);
      return { reviewId, href: `/money/organization?review=${reviewId}`, undo: "Undo from the organization review" };
    }
    case "recurring": {
      const payload = payloadSchemas.recurring.parse(proposal.payload);
      const { error } = await supabase.rpc("review_recurring_series_versions", { p_decision: "confirmed", p_account_id: payload.accountId, p_label: payload.label,
        p_cadence: payload.cadence, p_currency_code: payload.currencyCode, p_evidence: payload.evidence, p_run_anchor_id: payload.runAnchorId, p_evidence_limited: payload.evidenceLimited });
      if (error) throw new Error(error.message);
      return { href: "/money/recurring", undo: "Choose “Not recurring” on the Recurring page" };
    }
    case "budget": {
      const payload = payloadSchemas.budget.parse(proposal.payload);
      const category = await supabase.from("categories").select("id").eq("workspace_id", workspace.id).eq("id", payload.categoryId).maybeSingle();
      if (category.error || !category.data) throw new Error("Category not found");
      // Same insert as Plan → Spending limits; a target only, never touches balances or goals.
      const { error } = await supabase.from("spending_plans").insert({ workspace_id: workspace.id, category_id: payload.categoryId, currency_code: payload.currencyCode,
        limit_minor: payload.limitMinor, enabled: true, updated_at: new Date().toISOString() });
      if (error?.code === "23505") throw new Error("A limit already exists for this category and currency");
      if (error) throw new Error(error.message);
      return { href: "/plan/spending", undo: "Turn the limit off in Plan → Spending" };
    }
    case "iou_create": {
      // The proposal id is both the new item's id and the request id, so accepting twice cannot duplicate it.
      const record = iouRecord(iouCreateSchema.parse(proposal.payload));
      const { error } = await supabase.rpc("edit_wealth_item", { p_id: proposal.id, p_expected_version: 0, p_record: record, p_remove: false, p_request_id: proposal.id });
      if (error) throw new Error(error.message);
      return { href: "/money/wealth", undo: "Undo from the Wealth history" };
    }
    case "iou_settle": {
      const payload = iouSettleSchema.parse(proposal.payload);
      const [item, transaction] = await Promise.all([
        supabase.from("wealth_items").select("id, kind, name, currency_code, amount_minor::text, as_of, version, removed_at, linked_account_id, annual_rate_text, monthly_payment_minor::text")
          .eq("workspace_id", workspace.id).eq("id", payload.itemId).is("removed_at", null).maybeSingle(),
        supabase.from("transactions").select("id, amount_minor::text, currency_code").eq("workspace_id", workspace.id).eq("id", payload.transactionId).maybeSingle(),
      ]);
      if (item.error || !item.data || !parseIouName(item.data.name)) throw new Error("This loan changed or was removed since the repayment was found");
      const paid = transaction.data ? BigInt(transaction.data.amount_minor) : 0n;
      const lent = item.data.kind === "asset";
      if (transaction.data?.currency_code !== item.data.currency_code || (lent ? paid <= 0n : paid >= 0n) || BigInt(payload.appliedMinor) > (paid < 0n ? -paid : paid))
        throw new Error("The transaction no longer matches this repayment");
      const next = settledRecord(item.data, payload.appliedMinor, calendarDate(new Date(), workspace.timezone));
      const { error } = await supabase.rpc("edit_wealth_item", { p_id: item.data.id, p_expected_version: item.data.version, p_record: next ?? {}, p_remove: next === null, p_request_id: proposal.id });
      if (error) throw new Error(error.message);
      return { href: "/money/wealth", undo: "Undo from the Wealth history" };
    }
    case "transaction_create":
      return applyTransactionProposal(context, proposal.id, proposal.payload, options.accountId);
    case "balance_set":
      return applyBalanceProposal(context, proposal.id, proposal.payload);
    case "recurring_edit":
      return applyRecurringProposal(context, proposal.id, proposal.payload);
    case "finding":
      payloadSchemas.finding.parse(proposal.payload);
      return { href: "/money/transactions", acknowledged: true };
  }
}

/** Claims each proposal once, applies it, and records the outcome. Rejecting never changes data. */
export async function decideProposals(context: Context, ids: string[], decision: "accept" | "reject", options: DecideOptions = {}) {
  const { supabase, workspace } = context;
  const outcomes: { id: string; status: string; error?: string }[] = [];
  for (const id of ids) {
    const now = new Date().toISOString();
    if (decision === "reject") {
      const { data, error } = await supabase.from("agent_proposals").update({ status: "rejected", decided_at: now }).eq("id", id).eq("workspace_id", workspace.id).in("status", ["proposed", "failed"]).select("id").maybeSingle();
      outcomes.push({ id, status: error ? "failed" : data ? "rejected" : "unchanged", ...(error ? { error: error.message } : {}) });
      continue;
    }
    const claim = await supabase.from("agent_proposals").update({ status: "applying", decided_at: now }).eq("id", id).eq("workspace_id", workspace.id).in("status", ["proposed", "failed"])
      .select("id, kind, payload").maybeSingle();
    if (claim.error || !claim.data) { outcomes.push({ id, status: "unchanged", ...(claim.error ? { error: claim.error.message } : {}) }); continue; }
    let result: Applied;
    try { result = await applyProposal(context, claim.data as StoredProposal, options); }
    catch (cause) {
      const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
      await supabase.from("agent_proposals").update({ status: "failed", result: { error: message } }).eq("id", id).eq("workspace_id", workspace.id).eq("status", "applying");
      outcomes.push({ id, status: "failed", error: message });
      continue;
    }
    const saved = await supabase.from("agent_proposals").update({ status: "accepted", result, decided_at: new Date().toISOString() }).eq("id", id).eq("workspace_id", workspace.id).eq("status", "applying");
    outcomes.push({ id, status: "accepted", ...(saved.error ? { error: `Applied, but the review record was not updated: ${saved.error.message}` } : {}) });
  }
  return outcomes;
}
