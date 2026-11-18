"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadOrganizationSuggestions } from "@/lib/import/organization-loader";
import { groupUncategorized, type UncategorizedRow } from "@/lib/import/uncategorized-groups";

const groupsStayUnsuggestedWhenHistoryIsUnavailable = () => null;
import { loadLoanPayoutIds } from "@/lib/finance/iou";

const PAGE = 1000;
const SUGGESTION_BATCH = 50;
const categorizePayload = z.object({ patch: z.object({ category_id: z.string().optional() }).optional(), rows: z.array(z.object({ id: z.string() })).optional() });

export async function loadUncategorizedGroups() {
  const { supabase, workspace } = await requireWorkspace();
  const [rows, categories, proposals, loans] = await Promise.all([
    loadAllUncategorized(supabase, workspace.id),
    supabase.from("categories").select("id, name").eq("workspace_id", workspace.id).order("name").limit(500),
    supabase.from("agent_proposals").select("payload").eq("workspace_id", workspace.id).eq("kind", "categorize").in("status", ["proposed", "failed"]).limit(200),
    loadLoanPayoutIds(supabase, workspace.id),
  ]);
  if (categories.error || proposals.error) throw new Error((categories.error ?? proposals.error)!.message);
  const picked = new Map<string, string>();
  for (const { payload } of proposals.data ?? []) {
    const proposal = categorizePayload.safeParse(payload);
    const category = proposal.success ? proposal.data.patch?.category_id : undefined;
    if (proposal.success && category) for (const row of proposal.data.rows ?? []) picked.set(row.id, category);
  }
  const spending = rows.filter(row => !loans.has(row.id));
  const groups = groupUncategorized(spending, picked);
  const open = groups.filter(group => !group.suggested);
  for (let offset = 0; offset < open.length; offset += SUGGESTION_BATCH) {
    const batch = open.slice(offset, offset + SUGGESTION_BATCH);
    const history = await loadOrganizationSuggestions(supabase, workspace.id, batch.map(group => group.rows[0])).catch(groupsStayUnsuggestedWhenHistoryIsUnavailable);
    for (const proposal of history?.proposals ?? []) {
      const group = batch.find(item => item.rows[0].id === proposal.transactionId);
      if (group && proposal.categoryId) group.suggested = proposal.categoryId;
    }
  }
  return { groups, total: spending.length, categories: (categories.data ?? []) as { id: string; name: string }[] };
}

async function loadAllUncategorized(supabase: Awaited<ReturnType<typeof requireWorkspace>>["supabase"], workspaceId: string) {
  const rows: UncategorizedRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await supabase.from("transactions").select("id, version, description, posted_on, amount_minor::text, currency_code, merchants(name)").eq("workspace_id", workspaceId).eq("status", "posted").is("category_id", null).neq("kind", "transfer")
      .order("posted_on", { ascending: false }).order("id", { ascending: false }).range(offset, offset + PAGE - 1);
    if (page.error) throw new Error(page.error.message);
    rows.push(...page.data);
    if (page.data.length < PAGE) return rows;
  }
}

export async function skipUncategorized(): Promise<string | undefined> {
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("workspace_settings").update({ uncategorized_skipped_at: new Date().toISOString() }).eq("workspace_id", workspace.id);
  if (error) {
    console.error("skipUncategorized failed", { code: error.code });
    return "Could not save. Try again.";
  }
  revalidatePath("/", "layout");
  return undefined;
}

const groupInput = z.object({ rows: z.array(z.object({ id: z.uuid(), version: z.number().int().min(0) }).strict()).min(1).max(1000), categoryId: z.uuid().optional(),
  newCategory: z.string().trim().min(1).max(100).optional(), key: z.string().max(1000) }).refine(group => !!group.categoryId !== !!group.newCategory);

export async function categorizeGroups(inputs: z.input<typeof groupInput>[], remember = false): Promise<{ applied: Record<string, number>; rows: Record<string, { id: string; version: number }[]>; error?: string }> {
  const groups = z.array(groupInput).min(1).max(30).safeParse(inputs);
  if (!groups.success) return { applied: {}, rows: {}, error: "These transactions could not be categorized. Reload and try again." };
  const context = await requireWorkspace();
  const applied: Record<string, number> = {};
  const rows: Record<string, { id: string; version: number }[]> = {};
  let error: string | undefined;
  try {
    const created = new Map<string, string>();
    for (const group of groups.data) {
      const categoryId = group.categoryId ?? created.get(group.newCategory!) ?? await createCategory(context, group.newCategory!);
      created.set(group.newCategory ?? "", categoryId);
      applied[group.key] = await categorize(context, { ...group, categoryId }, remember === true);
      rows[group.key] = await currentVersions(context, group.rows);
    }
  } catch (cause) {
    console.error("categorizeGroups failed", cause);
    error = cause instanceof z.ZodError || !(cause instanceof Error) ? "Could not categorize these transactions. Reload and try again." : cause.message;
  }
  if (Object.keys(applied).length) revalidatePath("/", "layout");
  return { applied, rows, error };
}

async function createCategory({ supabase, workspace }: Awaited<ReturnType<typeof requireWorkspace>>, name: string) {
  const { data, error } = await supabase.from("categories").upsert({ workspace_id: workspace.id, name }, { onConflict: "workspace_id,name" }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function currentVersions({ supabase, workspace }: Awaited<ReturnType<typeof requireWorkspace>>, rows: { id: string }[]) {
  const versions: { id: string; version: number }[] = [];
  for (let offset = 0; offset < rows.length; offset += 200) {
    const { data, error } = await supabase.from("transactions").select("id, version").eq("workspace_id", workspace.id).in("id", rows.slice(offset, offset + 200).map(row => row.id));
    if (error) throw new Error(error.message);
    versions.push(...data);
  }
  return versions;
}

async function categorize({ supabase, workspace }: Awaited<ReturnType<typeof requireWorkspace>>, { rows, categoryId, key }: { rows: { id: string; version: number }[]; categoryId: string; key: string }, remember: boolean) {
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    const current = await loadOrganizationSuggestions(supabase, workspace.id, batch);
    const evidence = [...new Map(current.proposals.flatMap(item => item.evidence).map(row => [row.id, row])).values()];
    const rule = remember && offset === 0 && key.length >= 3 && current.proposals.every(item => item.descriptionKey === key) ? key : null;
    const created = await supabase.rpc("create_organization_review", { p_rows: batch, p_patch: { category_id: categoryId }, p_merchant_name: null, p_rule_key: rule, p_evidence: evidence, p_request_id: crypto.randomUUID() });
    if (created.error) throw new Error(created.error.message);
    const done = await supabase.rpc("apply_organization_review", { p_review_id: created.data.id, p_save_rule: rule !== null });
    if (done.error) throw new Error(done.error.message);
  }
  return rows.length;
}
