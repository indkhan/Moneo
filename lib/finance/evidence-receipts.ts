import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AI_DATA_SCOPES } from "@/lib/settings";
import { minorDigits } from "./fx";
import type { FinancialEvidenceReceipt } from "./verified-claims";

const sourceSchema = z.object({ id: z.string().min(1).max(200), type: z.enum(["transaction", "account", "goal", "budget", "wealth", "assumption", "snapshot"]),
  entityId: z.uuid().optional(), version: z.string().min(1).max(200), record: z.json() }).strict();
const period = z.object({ from: z.iso.date(), to: z.iso.date() }).strict().refine(value => value.from <= value.to);
const metricSchema = z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(200), valueMinor: z.string().regex(/^-?(?:0|[1-9]\d{0,79})$/).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).refine(value => { try { minorDigits(value); return true; } catch { return false; } }), period,
  qualifiers: z.array(z.enum(["partial_classification", "partial_coverage", "unresolved_included", "dated_snapshot", "assumption", "manual_evidence", "virtual_reservation"])).max(30),
  sourceIds: z.array(z.string().min(1).max(200)).max(20000), calculation: z.string().min(1).max(2000) }).strict();
const receiptInputSchema = z.object({ workspaceId: z.uuid(), fetchedAt: z.iso.datetime({ offset: true }), calculationVersion: z.string().min(1).max(200), sourceVersion: z.string().min(1).max(200),
  query: z.record(z.string(), z.json()), scopes: z.array(z.enum(AI_DATA_SCOPES)).min(1).max(4), sources: z.array(sourceSchema).max(20000), metrics: z.array(metricSchema).max(2000) }).strict();
export type EvidenceReceiptInput = z.infer<typeof receiptInputSchema>;
export type EvidenceReceipt = Omit<FinancialEvidenceReceipt, "sources" | "query"> & {
  query: EvidenceReceiptInput["query"];
  scopes: EvidenceReceiptInput["scopes"];
  sources: (EvidenceReceiptInput["sources"][number] & { href: string })[];
};
export function evidenceFingerprint(input: unknown): string {
  function canonical(value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}
function sourceHref(source: EvidenceReceiptInput["sources"][number]) {
  const id = source.entityId ?? z.uuid().parse(source.id);
  if (source.type === "transaction") return `/money/transactions?transaction=${id}`;
  if (source.type === "account" || source.type === "snapshot") return `/money/accounts?account=${id}`;
  if (source.type === "wealth") return `/money/wealth?item=${id}`;
  if (source.type === "budget") return `/plan/spending?plan=${id}`;
  return `/plan?${source.type}=${id}`;
}
export function createEvidenceReceipt(raw: unknown): EvidenceReceipt {
  const input = receiptInputSchema.parse(raw);
  if (new Set(input.sources.map(source => source.id)).size !== input.sources.length || new Set(input.metrics.map(metric => metric.id)).size !== input.metrics.length) throw new Error("Duplicate evidence identity");
  for (const metric of input.metrics) if (new Set(metric.sourceIds).size !== metric.sourceIds.length || metric.sourceIds.some(id => !input.sources.some(source => source.id === id))) throw new Error("Metric supporting record unavailable");
  // The clock does not change immutable evidence identity; the first stored receipt retains its capture time.
  const hash = evidenceFingerprint({ ...input, fetchedAt: undefined });
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return { ...input, id, sources: input.sources.map(source => ({ ...source, href: sourceHref(source) })) };
}
function parseStoredReceipt(raw: unknown): EvidenceReceipt {
  const stored = z.object({ id: z.uuid() }).passthrough().parse(raw);
  const plain = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "id"));
  if (Array.isArray(plain.sources)) plain.sources = plain.sources.map(source => {
    const entry = z.object({ href: z.string() }).passthrough().parse(source);
    return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "href"));
  });
  const receipt = createEvidenceReceipt(plain);
  if (receipt.id !== stored.id || receipt.sources.some((source, index) => source.href !== (stored.sources as EvidenceReceipt["sources"])[index].href)) throw new Error("Receipt integrity mismatch");
  return receipt;
}
export function evidenceFreshness(receipt: FinancialEvidenceReceipt, sourceVersion: string | null, calculationVersion: string) {
  return sourceVersion === null ? { status: "unknown" as const, reason: "Current evidence could not be checked; this retained result is historical." }
    : receipt.sourceVersion !== sourceVersion || receipt.calculationVersion !== calculationVersion
      ? { status: "stale" as const, reason: "Sources, classifications, coverage or calculation rules have changed. This retained result remains the original dated evidence." }
      : { status: "current" as const, reason: "Current source versions and calculation rules match this retained evidence." };
}
export async function loadEvidenceReceipt(db: SupabaseClient, workspaceId: string, id: string): Promise<EvidenceReceipt | null> {
  z.uuid().parse(workspaceId); z.uuid().parse(id);
  const result = await db.from("financial_evidence_receipts").select("receipt").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  const receipt = parseStoredReceipt(result.data.receipt);
  if (receipt.workspaceId !== workspaceId || receipt.id !== id) throw new Error("Evidence ownership mismatch");
  return receipt;
}
// Only pass a trusted service client after an owned deterministic query. Authenticated clients cannot insert receipts.
export async function persistEvidenceReceipt(db: SupabaseClient, receipt: EvidenceReceipt): Promise<EvidenceReceipt> {
  const validated = parseStoredReceipt(receipt);
  const result = await db.from("financial_evidence_receipts").insert({ id: validated.id, workspace_id: validated.workspaceId, scopes: validated.scopes, receipt: validated });
  if (result.error && result.error.code !== "23505") throw result.error;
  if (!result.error) return validated;
  const existing = await loadEvidenceReceipt(db, validated.workspaceId, validated.id);
  if (!existing || evidenceFingerprint({ ...existing, fetchedAt: null }) !== evidenceFingerprint({ ...validated, fetchedAt: null })) throw new Error("Receipt collision or ownership mismatch");
  return existing;
}
