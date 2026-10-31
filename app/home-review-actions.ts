"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadOrganizationSuggestions } from "@/lib/import/organization-loader";
import { organizationDescriptionKey } from "@/lib/import/organization";
import { loadLoanPayoutIds } from "@/lib/finance/iou";

/** `recent` are the newest few transactions, so a person can decide from the sheet without opening Organize. */
export type UncategorizedGroup = { key: string; label: string; count: number; rows: { id: string; version: number }[]; suggested: string | null;
  recent: { id: string; date: string; description: string; amountMinor: string; currency: string }[] };

const MAX_GROUPS = 30;

/** Uncategorized spending grouped by what the bank wrote, biggest groups first, each with the category the app would pick. */
export async function loadUncategorizedGroups() {
  const { supabase, workspace } = await requireWorkspace();
  const [rows, categories, proposals, loans] = await Promise.all([
    supabase.from("transactions").select("id, version, description, posted_on, amount_minor::text, currency_code").eq("workspace_id", workspace.id).eq("status", "posted").is("category_id", null).neq("kind", "transfer")
      .order("posted_on", { ascending: false }).limit(1000),
    supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).order("name").limit(500),
    // The Categorizer's picks it was not sure enough to apply.
    supabase.from("agent_proposals").select("payload").eq("workspace_id", workspace.id).eq("kind", "categorize").in("status", ["proposed", "failed"]).limit(200),
    // A loan's payout is recorded in Wealth, not spending to categorize.
    loadLoanPayoutIds(supabase, workspace.id).catch(() => new Set<string>()),
  ]);
  if (rows.error || categories.error || proposals.error) throw new Error((rows.error ?? categories.error ?? proposals.error)!.message);
  const picked = new Map<string, string>();
  for (const { payload } of proposals.data ?? []) {
    const category = payload?.patch?.category_id;
    if (typeof category === "string") for (const row of payload.rows ?? []) picked.set(row.id, category);
  }
  const groups = new Map<string, UncategorizedGroup>();
  const spending = (rows.data ?? []).filter(row => !loans.has(row.id));
  for (const row of spending) {
    const key = organizationDescriptionKey(row.description) || row.description;
    const group: UncategorizedGroup = groups.get(key) ?? { key, label: row.description, count: 0, rows: [], suggested: null, recent: [] };
    group.count++;
    group.rows.push({ id: row.id, version: row.version });
    if (group.recent.length < 8) group.recent.push({ id: row.id, date: row.posted_on, description: row.description, amountMinor: row.amount_minor, currency: row.currency_code });
    group.suggested ??= picked.get(row.id) ?? null;
    groups.set(key, group);
  }
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, MAX_GROUPS);
  // History and approved rules suggest a category for groups the Categorizer left open.
  const open = top.filter(group => !group.suggested);
  if (open.length) {
    const history = await loadOrganizationSuggestions(supabase, workspace.id, open.map(group => group.rows[0])).catch(() => null);
    for (const proposal of history?.proposals ?? []) {
      const group = open.find(item => item.rows[0].id === proposal.transactionId);
      if (group && proposal.categoryId) group.suggested = proposal.categoryId;
    }
  }
  return { groups: top, total: spending.length, categories: (categories.data ?? []) as { id: string; name: string }[] };
}

const groupInput = z.object({ rows: z.array(z.object({ id: z.uuid(), version: z.number().int().min(0) }).strict()).min(1).max(1000), categoryId: z.uuid(), key: z.string().max(1000) });

/**
 * Categorizes a group through the audited organization review, 50 rows per batch, and saves a rule so later syncs
 * categorize the same description by themselves. Rows a person corrected meanwhile are left alone; each batch can be undone.
 * A failure comes back as `error` with the groups applied before it, because production hides a thrown action's message.
 */
export async function categorizeGroups(inputs: z.input<typeof groupInput>[]): Promise<{ applied: Record<string, number>; error?: string }> {
  const groups = z.array(groupInput).min(1).max(30).safeParse(inputs);
  if (!groups.success) return { applied: {}, error: "These transactions could not be categorized. Reload and try again." };
  const context = await requireWorkspace();
  // One request and one refresh for the whole batch: each refresh re-renders Home, which is slow on a phone.
  const applied: Record<string, number> = {};
  let error: string | undefined;
  try {
    for (const group of groups.data) applied[group.key] = await categorize(context, group);
  } catch (cause) {
    console.error("categorizeGroups failed", cause);
    error = cause instanceof z.ZodError || !(cause instanceof Error) ? "Could not categorize these transactions. Reload and try again." : cause.message;
  }
  if (Object.keys(applied).length) revalidatePath("/", "layout");
  return { applied, error };
}

async function categorize({ supabase, workspace }: Awaited<ReturnType<typeof requireWorkspace>>, { rows, categoryId, key }: z.infer<typeof groupInput>) {
  let applied = 0;
  for (let offset = 0; offset < rows.length; offset += 50) {
    const current = await loadOrganizationSuggestions(supabase, workspace.id, rows.slice(offset, offset + 50));
    if (!current.proposals.length) continue;
    const evidence = [...new Map(current.proposals.flatMap(item => item.evidence).map(row => [row.id, row])).values()];
    const rule = offset === 0 && key.length >= 3 && current.proposals.every(item => item.descriptionKey === key) ? key : null;
    const created = await supabase.rpc("create_organization_review", { p_rows: current.proposals.map(item => ({ id: item.transactionId, version: item.version })),
      p_patch: { category_id: categoryId }, p_merchant_name: null, p_rule_key: rule, p_evidence: evidence, p_request_id: crypto.randomUUID() });
    if (created.error) throw new Error(created.error.message);
    const done = await supabase.rpc("apply_organization_review", { p_review_id: created.data.id, p_save_rule: rule !== null });
    if (done.error) throw new Error(done.error.message);
    applied += current.proposals.length;
  }
  return applied;
}
