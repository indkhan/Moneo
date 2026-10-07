import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { investigate, investigationIdentity, investigationSchema, resolveInvestigation, type InvestigationEntities, type InvestigationRow, type InvestigationSpec } from "./investigation";

type Context = { supabase: SupabaseClient; workspace: { id: string } };
const PAGE_SIZE = 500;
const MAX_ROWS = 100_000;

/** A resource bound is an explicit error, never a silently incomplete result. */
async function allRows<T>(query: { range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }> }): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await query.range(offset, offset + PAGE_SIZE - 1);
    if (page.error) throw page.error;
    if (result.length + (page.data?.length ?? 0) > MAX_ROWS) throw new Error("Investigation exceeds 100,000 records; narrow its dates or filters");
    result.push(...(page.data ?? []) as T[]);
    if (!page.data || page.data.length < PAGE_SIZE) return result;
  }
}
export async function loadInvestigationEntities(context?: Context): Promise<InvestigationEntities> {
  const { supabase, workspace } = context ?? await requireWorkspace();
  const [accounts, categories, merchants] = await Promise.all(["accounts", "categories", "merchants"].map(table => allRows<{ id: string; name: string }>(supabase.from(table).select("id, name").eq("workspace_id", workspace.id).order("id"))));
  return { accounts, categories, merchants };
}
type LedgerRow = {
  id: string; parent_transaction_id: string; account_id: string; category_id: string | null; merchant_id: string | null;
  posted_on: string; amount_minor: string; currency_code: string; status: InvestigationRow["status"]; kind: InvestigationRow["kind"];
  tags: string[]; event_name: string | null; review_reasons: string[]; version: number; description: string; refund_of_id: string | null;
};
type Source = { id: string; import_id: string; status: string; review_reasons: string[]; normalized_row: unknown; fee_evidence: unknown;
  imports: { run_version: number; status: string; undone_at: string | null } | null; transaction_sources: { transaction_id: string }[] };

async function loadRows(context: Context, spec: InvestigationSpec, includeAll = false) {
  const { supabase, workspace } = context;
  const from = [spec.period.from, spec.comparison?.from].filter((v): v is string => Boolean(v)).sort()[0];
  const to = [spec.period.to, spec.comparison?.to].filter((v): v is string => Boolean(v)).sort().at(-1)!;
  let ledger = supabase.from("effective_transactions")
    .select("id, parent_transaction_id, account_id, category_id, merchant_id, posted_on, amount_minor::text, currency_code, status, kind, tags, event_name, review_reasons, version, description, refund_of_id")
    .eq("workspace_id", workspace.id);
  if (!includeAll) ledger = ledger.gte("posted_on", from).lte("posted_on", to);
  const [effective, sources] = await Promise.all([
    allRows<LedgerRow>(ledger.order("id")),
    allRows<Source>(supabase.from("source_transactions").select("id, import_id, status, review_reasons, normalized_row, fee_evidence, imports(run_version, status, undone_at), transaction_sources(transaction_id)").eq("workspace_id", workspace.id).order("id")),
  ]);
  const byParent = new Map<string, unknown[]>();
  for (const source of sources) for (const link of source.transaction_sources ?? []) {
    const values = byParent.get(link.transaction_id) ?? [];
    values.push({ id: source.id, importId: source.import_id, status: source.status, import: source.imports,
      identity: investigationIdentity({ normalized: source.normalized_row, fees: source.fee_evidence, reviewReasons: source.review_reasons }) });
    byParent.set(link.transaction_id, values);
  }
  const rows: InvestigationRow[] = effective.map(r => ({ id: r.id, parentId: r.parent_transaction_id, accountId: r.account_id,
    categoryId: r.category_id, merchantId: r.merchant_id, date: r.posted_on, amountMinor: r.amount_minor, currency: r.currency_code,
    status: r.status, kind: r.kind, tags: r.tags ?? [], event: r.event_name, reviewReasons: r.review_reasons ?? [], version: r.version,
    description: r.description, refundOfId: r.refund_of_id, sourceVersions: byParent.get(r.parent_transaction_id) ?? [] }));
  // Refunds inherit the verified original category when their own category is unset.
  const refundIds = [...new Set(rows.filter(r => r.kind === "refund" && !r.categoryId && r.refundOfId).map(r => r.refundOfId!))];
  for (let offset = 0; offset < refundIds.length; offset += 100) {
    const original = await supabase.from("transactions").select("id, category_id, version").eq("workspace_id", workspace.id).in("id", refundIds.slice(offset, offset + 100));
    if (original.error) throw original.error;
    for (const row of rows) if (row.kind === "refund" && !row.categoryId && row.refundOfId) {
      const parent = original.data?.find(r => r.id === row.refundOfId);
      if (parent) { row.categoryId = parent.category_id; row.sourceVersions = { sources: row.sourceVersions, refundOriginal: parent }; }
    }
  }
  return rows;
}

export async function runInvestigation(input: unknown, context?: Context) {
  const ctx = context ?? await requireWorkspace();
  const spec = resolveInvestigation(input, await loadInvestigationEntities(ctx));
  const rows = await loadRows(ctx, spec);
  return investigate(spec, rows, { workspaceId: ctx.workspace.id, capturedAt: new Date().toISOString() });
}

const minor = z.string().regex(/^-?\d{1,19}$/).refine(v => BigInt(v) >= -(2n ** 63n) && BigInt(v) <= 2n ** 63n - 1n, "Amount exceeds bigint range");
export const investigationScenarioSchema = z.object({ query: investigationSchema, overrides: z.array(z.object({
  id: z.uuid(), amountMinor: minor.optional(), date: z.iso.date().optional(), categoryId: z.uuid().nullable().optional(),
}).strict().refine(o => o.amountMinor !== undefined || o.date !== undefined || o.categoryId !== undefined, "Provide an override")).min(1).max(100) }).strict().refine(v => new Set(v.overrides.map(o => o.id)).size === v.overrides.length, "Duplicate override");

export async function evaluateInvestigationScenario(input: unknown, context?: Context) {
  const args = investigationScenarioSchema.parse(input);
  const ctx = context ?? await requireWorkspace();
  const entities = await loadInvestigationEntities(ctx);
  const spec = resolveInvestigation(args.query, entities);
  const rows = await loadRows(ctx, spec, true);
  for (const override of args.overrides) {
    if (!rows.some(r => r.id === override.id)) throw new Error("Unknown owned effective transaction in scenario");
    if (override.categoryId && !entities.categories.some(c => c.id === override.categoryId)) throw new Error("Unknown owned category in scenario");
  }
  const evidence = { workspaceId: ctx.workspace.id, capturedAt: new Date().toISOString() };
  const hypothetical = rows.map(row => {
    const override = args.overrides.find(o => o.id === row.id);
    return override ? { ...row, ...override } : row;
  });
  return { version: 1, canonicalMutations: false, hypothetical: investigate(spec, hypothetical, evidence), baseline: investigate(spec, rows, evidence),
    overrides: args.overrides, limitation: "Read-only effective-row overrides. No canonical edits, bank balances, recurring assumptions or source records are changed." };
}
