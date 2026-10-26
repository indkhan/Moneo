// Plain-language labels for ledger keys. Raw status/kind/review keys and
// correction JSON never reach the UI directly.

const STATUS: Record<string, string> = { posted: "Posted", pending: "Pending", voided: "Voided" };
const KIND: Record<string, string> = { ordinary: "Regular", transfer: "Transfer", refund: "Refund" };
const REVIEW: Record<string, string> = {
  source_transfer: "the statement calls this a transfer",
  source_exchange: "the statement calls this a currency exchange",
  source_type: "the statement uses an unusual transaction type",
  refund_sign: "money came back but it isn't linked to a purchase",
  fee_semantics: "fees need checking",
  excluded_by_review: "it was excluded during import review",
};
const OPERATION: Record<string, string> = {
  metadata: "Organized",
  split: "Split",
  verified_link: "Linked",
  own_account_transfer: "Transfer to your own account",
  classification_review: "Classification reviewed",
};

const titleCase = (key: string) => key ? key[0].toUpperCase() + key.slice(1).replace(/_/g, " ") : key;
export const statusLabel = (status: string) => STATUS[status] ?? titleCase(status);
export const kindLabel = (kind: string) => KIND[kind] ?? titleCase(kind);
export const reviewReasonLabel = (reason: string) => REVIEW[reason] ?? reason.replace(/_/g, " ");
export const operationLabel = (operation: unknown) => typeof operation === "string" ? OPERATION[operation] ?? "Edited" : "Edited";

type Names = { categories: Record<string, string>; merchants: Record<string, string> };
type Json = Record<string, unknown>;

function show(key: string, value: unknown, names: Names): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
    return key === "category_id" ? "Uncategorized" : key === "merchant_id" ? "Unknown merchant" : "None";
  }
  if (key === "category_id") return names.categories[String(value)] ?? "A removed category";
  if (key === "merchant_id") return names.merchants[String(value)] ?? "A removed merchant";
  if (key === "kind") return kindLabel(String(value));
  if (key === "review_reasons" && Array.isArray(value)) return value.map(String).map(reviewReasonLabel).join("; ");
  if (key === "transfer_id" || key === "refund_of_id") return "Linked";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

const FIELDS: [string, string][] = [
  ["category_id", "Category"], ["merchant_id", "Merchant"], ["note", "Note"], ["tags", "Tags"], ["event_name", "Group"],
  ["kind", "Type"], ["transfer_id", "Transfer"], ["refund_of_id", "Refund of"], ["review_reasons", "Needs review"],
];

/** "Category: Groceries → Dining" lines for each field that changed between two correction snapshots. */
export function describeChanges(before: unknown, after: unknown, names: Names): string[] {
  const a = (before ?? {}) as Json, b = (after ?? {}) as Json;
  return FIELDS.filter(([key]) => (key in a || key in b) && JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null))
    .map(([key, label]) => `${label}: ${show(key, a[key], names)} → ${show(key, b[key], names)}`);
}

/** "Tags set to trip, weekend" for a bulk-edit patch. */
export function describePatch(patch: unknown, names: Names): string {
  const p = (patch ?? {}) as Json;
  return FIELDS.filter(([key]) => key in p).map(([key, label]) => `${label} set to ${show(key, p[key], names)}`).join(" · ") || "No changes";
}
