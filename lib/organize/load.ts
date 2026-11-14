import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRawContext } from "@/lib/bank/raw-context";
import { loadLoanPayoutIds } from "@/lib/finance/iou";
import { MAX_ORGANIZATION_RULES, organizationRuleSchema } from "@/lib/import/organization";
import { judgeLabel, type AiLabel, type LabelledRow } from "./calibration";
import type { HistoryRow, Identity, Memory, OrganizeInput, OrganizeRow } from "./organizer";

// Reads what the organizer needs through the service role, fenced by workspace_id.
type Result<T> = { data: T | null; error: { message: string } | null };
const checked = <T,>(result: Result<T>): T => { if (result.error) throw new Error(result.error.message); return result.data as T; };
async function pages<T>(page: (offset: number) => PromiseLike<Result<T[]>>) {
  const all: T[] = [];
  for (let offset = 0; ; offset += 1000) { const rows = checked(await page(offset)); all.push(...rows); if (rows.length < 1000) return all; }
}
const chunks = <T,>(items: T[], size = 200) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

// AI labels are never evidence for more guesses; rows from before provenance existed (null) are.
const NOT_AI = "organized_by.is.null,organized_by.neq.ai";
const COLUMNS = "id, version, description, amount_minor::text, currency_code, posted_on, account_id, identity_id, category_id, merchant_id, kind, review_reasons, organized_by";
type Row = { id: string; version: number; description: string; amount_minor: string; currency_code: string; posted_on: string; account_id: string; identity_id: string | null;
  category_id: string | null; merchant_id: string | null; kind: string; review_reasons: string[] | null; organized_by: string | null };
const toHistory = (row: Row): HistoryRow => ({ id: row.id, version: row.version, description: row.description, amountMinor: BigInt(row.amount_minor), currency: row.currency_code,
  date: row.posted_on, identityId: row.identity_id, categoryId: row.category_id, merchantId: row.merchant_id, kind: row.kind, reviewReasons: row.review_reasons ?? [] });

/**
 * Rows the organizer may label: posted, not organized by anyone yet, missing a category or merchant, not a transfer or a row
 * waiting for a financial review, not corrected by the owner, not a loan payout, and not already in an open or dismissed question.
 */
export async function loadOrganizeInput(db: SupabaseClient, workspaceId: string): Promise<OrganizeInput> {
  const [targets, recent, corrections, rules, memory, categories, merchants, accounts, suppressedOps, questions, loans] = await Promise.all([
    pages<Row>(offset => db.from("transactions").select(COLUMNS).eq("workspace_id", workspaceId).eq("status", "posted").is("organized_by", null)
      .or("merchant_id.is.null,category_id.is.null").order("posted_on", { ascending: false }).order("id").range(offset, offset + 999)),
    db.from("transactions").select(COLUMNS).eq("workspace_id", workspaceId).eq("status", "posted").or(NOT_AI).not("category_id", "is", null)
      .order("posted_on", { ascending: false }).order("id", { ascending: false }).limit(2000),
    pages<{ transaction_id: string }>(offset => db.from("correction_events").select("transaction_id").eq("workspace_id", workspaceId).eq("undone", false).eq("origin", "owner").order("id").range(offset, offset + 999)),
    db.from("organization_rules").select("id,version,description_key,merchant_id,category_id,approved_by,enabled").eq("workspace_id", workspaceId).order("description_key").limit(MAX_ORGANIZATION_RULES),
    db.from("organize_memory").select("identity_id, category_id, merchant_id, purpose, suppressed").eq("workspace_id", workspaceId).eq("source", "owner").limit(5000),
    db.from("categories").select("id, name").eq("workspace_id", workspaceId).order("name").limit(500),
    db.from("merchants").select("id, name").eq("workspace_id", workspaceId).order("name").limit(5000),
    db.from("accounts").select("id, name").eq("workspace_id", workspaceId).limit(500),
    db.from("organizer_ops").select("identity_key, category_id").eq("workspace_id", workspaceId).eq("suppressed", true).not("category_id", "is", null).limit(5000),
    db.from("organize_questions").select("transaction_ids").eq("workspace_id", workspaceId).in("status", ["open", "dismissed"]).limit(5000),
    loadLoanPayoutIds(db, workspaceId).catch(() => new Set<string>()),
  ]);
  const corrected = new Set(corrections.map(row => row.transaction_id));
  const asked = new Set((checked(questions) as { transaction_ids: string[] }[]).flatMap(row => row.transaction_ids));
  const eligible = targets.filter(row => row.kind !== "transfer" && !(row.review_reasons ?? []).length && !corrected.has(row.id) && !loans.has(row.id) && !asked.has(row.id));

  const identityIds = [...new Set(eligible.map(row => row.identity_id).filter((id): id is string => !!id))];
  const identities = new Map<string, Identity>(), ownHistory: Row[] = [];
  for (const ids of chunks(identityIds)) {
    const [found, labelled] = await Promise.all([
      db.from("organize_identities").select("id, kind, display_name, merchant_id").eq("workspace_id", workspaceId).in("id", ids),
      db.from("transactions").select(COLUMNS).eq("workspace_id", workspaceId).eq("status", "posted").in("identity_id", ids).or(NOT_AI)
        .not("category_id", "is", null).order("posted_on", { ascending: false }).limit(1000),
    ]);
    for (const row of checked(found) as { id: string; kind: Identity["kind"]; display_name: string; merchant_id: string | null }[])
      identities.set(row.id, { id: row.id, kind: row.kind, displayName: row.display_name, merchantId: row.merchant_id });
    ownHistory.push(...checked(labelled) as Row[]);
  }
  const history = [...new Map([...checked(recent) as Row[], ...ownHistory].map(row => [row.id, toHistory(row)])).values()]
    .sort((a, b) => b.date.localeCompare(a.date));

  const raw = await loadRawContext(db, workspaceId, eligible.map(row => row.id));
  const rows: OrganizeRow[] = eligible.map(row => ({ id: row.id, version: row.version, description: row.description, amountMinor: BigInt(row.amount_minor), currency: row.currency_code,
    date: row.posted_on, accountId: row.account_id, identityId: row.identity_id, categoryId: row.category_id, merchantId: row.merchant_id, raw: raw.get(row.id) ?? null }));
  const memories = checked(memory) as { identity_id: string; category_id: string | null; merchant_id: string | null; purpose: string | null; suppressed: string[] }[];
  const suppressed = new Map<string, Set<string>>();
  const suppress = (key: string, categoryId: string) => suppressed.set(key, (suppressed.get(key) ?? new Set()).add(categoryId));
  for (const op of checked(suppressedOps) as { identity_key: string; category_id: string }[]) suppress(op.identity_key, op.category_id);
  for (const item of memories) for (const categoryId of item.suppressed ?? []) suppress(item.identity_id, String(categoryId));
  return {
    rows, history, identities,
    rules: (checked(rules) as { id: string; version: number; description_key: string; merchant_id: string | null; category_id: string | null; approved_by: string; enabled: boolean }[])
      .map(rule => organizationRuleSchema.parse({ id: rule.id, version: rule.version, descriptionKey: rule.description_key, merchantId: rule.merchant_id, categoryId: rule.category_id, approvedBy: rule.approved_by, enabled: rule.enabled })),
    memory: new Map(memories.map(item => [item.identity_id, { identityId: item.identity_id, categoryId: item.category_id, merchantId: item.merchant_id, purpose: item.purpose } satisfies Memory])),
    categories: new Map((checked(categories) as { id: string; name: string }[]).map(row => [row.id, row.name])),
    merchants: new Map((checked(merchants) as { id: string; name: string }[]).map(row => [row.id, row.name])),
    accounts: new Map((checked(accounts) as { id: string; name: string }[]).map(row => [row.id, row.name])),
    suppressed,
  };
}

/** The owner's verdicts on recent AI labels, newest first, for the calibration kill switch. */
export async function loadJudgedLabels(db: SupabaseClient, workspaceId: string, now = new Date()) {
  const ops = checked(await db.from("organizer_ops").select("id, created_at, undone_at, category_id, merchant_id, transactions(category_id, merchant_id, organized_by, organize_op_id)")
    .eq("workspace_id", workspaceId).eq("after->>organized_by", "ai").order("created_at", { ascending: false }).limit(1000)) as unknown as
    { id: string; created_at: string; undone_at: string | null; category_id: string | null; merchant_id: string | null;
      transactions: { category_id: string | null; merchant_id: string | null; organized_by: string | null; organize_op_id: string | null } | null }[];
  return ops.map(op => {
    const label: AiLabel = { id: op.id, createdAt: op.created_at, undoneAt: op.undone_at, categoryId: op.category_id, merchantId: op.merchant_id };
    const row: LabelledRow | null = op.transactions && { categoryId: op.transactions.category_id, merchantId: op.transactions.merchant_id, organizedBy: op.transactions.organized_by, organizeOpId: op.transactions.organize_op_id };
    return judgeLabel(label, row, now);
  }).filter((verdict): verdict is boolean => verdict !== null);
}
