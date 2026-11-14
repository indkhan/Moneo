import type { SupabaseClient } from "@supabase/supabase-js";

// What the Organize page and the chat tools show. Reads run as the owner, so row-level security fences them to their workspace.
const ok = <T,>(result: { data: T | null; error: { message: string } | null }): T => { if (result.error) throw new Error(result.error.message); return result.data as T; };
const COLUMNS = "id, description, amount_minor::text, currency_code, posted_on, category_id, merchant_id, identity_id, organized_by, ai_confidence, ai_reason, organize_op_id";

export const SOURCES = ["ai", "rule", "memory", "system"] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_LABEL: Record<Source, string> = { ai: "AI", rule: "Your rule", memory: "Your confirmed payee", system: "Bank data" };
export const PAGE_SIZE = 50;

export type Row = { id: string; description: string; amount_minor: string; currency_code: string; posted_on: string; category_id: string | null; merchant_id: string | null;
  identity_id: string | null; organized_by: string | null; ai_confidence: string | null; ai_reason: string | null; organize_op_id: string | null };

export async function loadNames(db: SupabaseClient, workspaceId: string) {
  const [categories, merchants] = await Promise.all([
    db.from("categories").select("id, name").eq("workspace_id", workspaceId).order("name").limit(501),
    db.from("merchants").select("id, name").eq("workspace_id", workspaceId).order("name").limit(501),
  ]);
  const categoryList = ok(categories) as { id: string; name: string }[], merchantList = ok(merchants) as { id: string; name: string }[];
  return { categoryList, merchantList, categories: new Map(categoryList.map(row => [row.id, row.name])), merchants: new Map(merchantList.map(row => [row.id, row.name])) };
}

export type Question = { id: string; identityId: string | null; identityName: string | null; question: string; createdBy: string; transactionIds: string[]; rows: Row[]; blank: number };

/** Open questions, oldest first, each with the rows it covers (the first few in full) and how many of them are still blank. */
export async function loadOpenQuestions(db: SupabaseClient, workspaceId: string, limit = 50, showRows = 6): Promise<Question[]> {
  const questions = ok(await db.from("organize_questions").select("id, identity_id, question, created_by, transaction_ids").eq("workspace_id", workspaceId).eq("status", "open")
    .order("created_at").limit(limit)) as { id: string; identity_id: string | null; question: string; created_by: string; transaction_ids: string[] }[];
  if (!questions.length) return [];
  const rowIds = [...new Set(questions.flatMap(item => item.transaction_ids))];
  const identityIds = [...new Set(questions.map(item => item.identity_id).filter((id): id is string => !!id))];
  const [rows, identities] = await Promise.all([
    Promise.all(Array.from({ length: Math.ceil(rowIds.length / 200) }, (_, index) =>
      db.from("transactions").select(COLUMNS).eq("workspace_id", workspaceId).in("id", rowIds.slice(index * 200, (index + 1) * 200)))).then(parts => parts.flatMap(part => ok(part) as Row[])),
    identityIds.length ? db.from("organize_identities").select("id, display_name").eq("workspace_id", workspaceId).in("id", identityIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const byId = new Map(rows.map(row => [row.id, row]));
  const names = new Map((ok(identities) as { id: string; display_name: string }[]).map(row => [row.id, row.display_name]));
  return questions.map(item => {
    const own = item.transaction_ids.map(id => byId.get(id)).filter((row): row is Row => !!row).sort((a, b) => b.posted_on.localeCompare(a.posted_on));
    // An older question may have no identity; its rows usually all share one.
    const shared = new Set(own.map(row => row.identity_id));
    const identityId = item.identity_id ?? (shared.size === 1 ? [...shared][0] : null);
    return { id: item.id, identityId, identityName: identityId ? names.get(identityId) ?? null : null, question: item.question, createdBy: item.created_by,
      transactionIds: item.transaction_ids, rows: own.slice(0, showRows), blank: own.filter(row => !row.category_id).length };
  });
}

export type Answered = { id: string; question: string; identityName: string | null; batchId: string; applied: number };

/** The owner's recent answers that labelled rows and are still in place, so they can be taken back. */
export async function loadRecentAnswers(db: SupabaseClient, workspaceId: string, limit = 5): Promise<Answered[]> {
  const rows = ok(await db.from("organize_questions").select("id, question, identity_id, answer").eq("workspace_id", workspaceId).eq("status", "answered")
    .not("answer->>batchId", "is", null).order("answered_at", { ascending: false }).limit(limit)) as { id: string; question: string; identity_id: string | null; answer: { batchId: string; applied?: number } }[];
  if (!rows.length) return [];
  const identityIds = rows.map(row => row.identity_id).filter((id): id is string => !!id);
  const [batches, identities] = await Promise.all([
    db.from("transaction_batches").select("id, undone").eq("workspace_id", workspaceId).in("id", rows.map(row => row.answer.batchId)),
    identityIds.length ? db.from("organize_identities").select("id, display_name").eq("workspace_id", workspaceId).in("id", identityIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const undone = new Map((ok(batches) as { id: string; undone: boolean }[]).map(row => [row.id, row.undone]));
  const names = new Map((ok(identities) as { id: string; display_name: string }[]).map(row => [row.id, row.display_name]));
  return rows.filter(row => undone.get(row.answer.batchId) === false)
    .map(row => ({ id: row.id, question: row.question, identityName: row.identity_id ? names.get(row.identity_id) ?? null : null, batchId: row.answer.batchId, applied: row.answer.applied ?? 0 }));
}

export type Decision = Row & { source: Source; opCreatedAt: string | null };
export type RunGroup = { key: string; createdAt: string; opIds: string[] };

/** Rows labelled by the organizer, a rule, a confirmed payee or the bank's data; newest first. */
export async function loadDecisions(db: SupabaseClient, workspaceId: string, options: { source?: Source; page?: number; pageSize?: number } = {}) {
  const pageSize = options.pageSize ?? PAGE_SIZE, offset = (options.page ?? 0) * pageSize;
  const { data, error, count } = await db.from("transactions").select(COLUMNS, { count: "exact" }).eq("workspace_id", workspaceId).in("organized_by", options.source ? [options.source] : [...SOURCES])
    .order("posted_on", { ascending: false }).order("id", { ascending: false }).range(offset, offset + pageSize - 1);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as Row[];
  const opIds = rows.map(row => row.organize_op_id).filter((id): id is string => !!id);
  const ops = opIds.length ? ok(await db.from("organizer_ops").select("id, created_at").eq("workspace_id", workspaceId).in("id", opIds)) as { id: string; created_at: string }[] : [];
  const created = new Map(ops.map(op => [op.id, op.created_at]));
  const decisions = rows.map((row): Decision => ({ ...row, source: row.organized_by as Source, opCreatedAt: row.organize_op_id ? created.get(row.organize_op_id) ?? null : null }));
  return { decisions, total: count ?? decisions.length };
}

/** The latest organizer passes whose labels are still in place, so a whole pass can be taken back at once. */
export async function loadRunGroups(db: SupabaseClient, workspaceId: string, limit = 5): Promise<RunGroup[]> {
  const ops = ok(await db.from("organizer_ops").select("id, run_id, proposal_id, created_at").eq("workspace_id", workspaceId).is("undone_at", null)
    .order("created_at", { ascending: false }).limit(1000)) as { id: string; run_id: string | null; proposal_id: string | null; created_at: string }[];
  const groups = new Map<string, RunGroup>();
  for (const op of ops) {
    const key = op.proposal_id ?? op.run_id;
    if (!key) continue;
    const group = groups.get(key) ?? { key, createdAt: op.created_at, opIds: [] };
    group.opIds.push(op.id);
    groups.set(key, group);
  }
  return [...groups.values()].slice(0, limit);
}

export type MemoryEntry = { id: string; identityId: string; identityName: string; categoryId: string | null; merchantId: string | null; purpose: string | null; source: string; covered: number; examples: string[] };

/** What the owner (and the organizer's own notes) say each payee is, with how many rows carry that payee. */
export async function loadMemory(db: SupabaseClient, workspaceId: string): Promise<MemoryEntry[]> {
  const memory = ok(await db.from("organize_memory").select("id, identity_id, category_id, merchant_id, purpose, source, organize_identities(display_name)").eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false }).limit(500)) as unknown as { id: string; identity_id: string; category_id: string | null; merchant_id: string | null; purpose: string | null; source: string;
    organize_identities: { display_name: string } | null }[];
  if (!memory.length) return [];
  const covered = new Map<string, { count: number; examples: string[] }>();
  const ids = memory.map(item => item.identity_id);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const rows = ok(await db.from("transactions").select("identity_id, description").eq("workspace_id", workspaceId).in("identity_id", ids.slice(offset, offset + 100))
      .order("posted_on", { ascending: false }).limit(2000)) as { identity_id: string; description: string }[];
    for (const row of rows) {
      const entry = covered.get(row.identity_id) ?? { count: 0, examples: [] };
      entry.count++;
      if (entry.examples.length < 3 && !entry.examples.includes(row.description)) entry.examples.push(row.description);
      covered.set(row.identity_id, entry);
    }
  }
  return memory.map(item => ({ id: item.id, identityId: item.identity_id, identityName: item.organize_identities?.display_name ?? "Unknown payee", categoryId: item.category_id, merchantId: item.merchant_id,
    purpose: item.purpose, source: item.source, covered: covered.get(item.identity_id)?.count ?? 0, examples: covered.get(item.identity_id)?.examples ?? [] }));
}

/** Categories and merchants the organizer made, and whether the owner has used them since. */
export async function loadAiCreated(db: SupabaseClient, workspaceId: string) {
  const [categories, merchants] = await Promise.all([
    db.from("categories").select("id, name, owner_touched").eq("workspace_id", workspaceId).eq("created_by", "ai").order("name").limit(200),
    db.from("merchants").select("id, name, owner_touched").eq("workspace_id", workspaceId).eq("created_by", "ai").order("name").limit(200),
  ]);
  return { categories: ok(categories) as { id: string; name: string; owner_touched: boolean }[], merchants: ok(merchants) as { id: string; name: string; owner_touched: boolean }[] };
}

/** Open questions and how many distinct rows wait in them, for the status lines. */
export async function countNeedsYou(db: SupabaseClient, workspaceId: string) {
  const { data, error } = await db.from("organize_questions").select("transaction_ids").eq("workspace_id", workspaceId).eq("status", "open").limit(1000);
  if (error) throw new Error(error.message);
  return { questions: data?.length ?? 0, rows: new Set((data ?? []).flatMap(item => item.transaction_ids as string[])).size };
}
