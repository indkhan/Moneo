import type { requireWorkspace } from "@/lib/auth";
import { loadInvestigationDataset } from "./investigation-reader";
import { evidenceFingerprint } from "./evidence-receipts";
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
// The same owned reader supplies import/source revisions for capture and later freshness checks.
export async function retainToolSourceSupport(name: string, input: unknown, result: unknown, context: Awaited<ReturnType<typeof requireWorkspace>>, canReadImports: boolean): Promise<unknown> {
  const value = object(result), support = object(value.calculationEvidence), args = object(input);
  if (name !== "analytics_cashflow" || !Array.isArray(support.rows)) return result;
  const dataset = await loadInvestigationDataset({ version: 1, period: { from: value.from, to: value.to }, statuses: ["posted", "pending"], kinds: ["ordinary", "refund", "transfer"], classifications: "all", metric: "signed" }, context, { canReadImports });
  const accounts = Array.isArray(args.accountIds) ? new Set(args.accountIds) : null;
  const selected = dataset.rows.filter(row => !accounts || accounts.has(row.accountId));
  const original = support.rows.map(row => { const r = object(row); return { id: r.id, parentId: r.parent_transaction_id ?? r.id, accountId: r.account_id, date: r.posted_on, amountMinor: r.amount_minor, currency: r.currency_code, status: r.status, kind: r.kind, reviewReasons: r.review_reasons ?? [], version: r.version }; }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const current = selected.map(row => ({ id: row.id, parentId: row.parentId, accountId: row.accountId, date: row.date, amountMinor: row.amountMinor, currency: row.currency, status: row.status, kind: row.kind, reviewReasons: row.reviewReasons, version: row.version })).sort((a, b) => a.id.localeCompare(b.id));
  if (evidenceFingerprint(original) !== evidenceFingerprint(current)) throw new Error("Source evidence changed during calculation; retry the query.");
  return { ...value, calculationEvidence: { ...support, originSourceRevision: dataset.sourceRevision, supportingSourceVersions: selected.map(row => ({ id: row.id, parentId: row.parentId, version: row.version, sourceVersions: row.sourceVersions ?? null })) } };
}
