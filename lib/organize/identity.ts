import type { RawContext } from "@/lib/bank/raw-context";
import { organizationDescriptionKey, organizationDisplayName } from "@/lib/import/organization";

export type AliasType = "creditor_id" | "iban" | "card_merchant" | "counterparty_name" | "description_key";
export type IdentityKind = "merchant" | "person" | "processor" | "own_account" | "internal";
export type Alias = { type: AliasType; value: string };
export type IdentityCandidate = { kind: IdentityKind; displayName: string; aliases: Alias[] };
export type IdentityContext = Pick<RawContext, "payment_type" | "counterparty_name" | "counterparty_iban" | "counterparty_ids" | "own_side_ids" | "creditor_id" | "own_account">;

const PROCESSORS: { slug: string; label: string; pattern: RegExp }[] = [
  { slug: "paypal", label: "PayPal", pattern: /\bpaypal\b/ },
  { slug: "klarna", label: "Klarna", pattern: /\bklarna\b/ },
  { slug: "stripe", label: "Stripe", pattern: /\bstripe\b/ },
  { slug: "apple", label: "Apple", pattern: /\bapple\b/ },
  { slug: "google", label: "Google", pattern: /\bgoogle\b/ },
  { slug: "amazon-payments", label: "Amazon Payments", pattern: /\bamazon pay(?:ments)?\b/ },
  { slug: "curve", label: "Curve", pattern: /\bcurve\b|\bcrv\b/ },
  { slug: "adyen", label: "Adyen", pattern: /\badyen\b/ },
  { slug: "sumup", label: "SumUp", pattern: /\bsum ?up\b/ },
  { slug: "wise", label: "Wise", pattern: /\b(?:transfer)?wise\b/ },
  { slug: "mollie", label: "Mollie", pattern: /\bmollie\b/ },
];

const LEGAL = new Set(["gmbh", "mbh", "ag", "kg", "kgaa", "ohg", "gbr", "ug", "se", "ek", "ev", "eg", "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc",
  "corp", "corporation", "co", "bv", "nv", "sa", "sas", "sarl", "srl", "spa", "ab", "oy", "as", "aps", "sl", "cie", "sca", "scs"]);
const LEGAL_SPLIT = [["e", "k"], ["e", "v"], ["b", "v"], ["n", "v"], ["s", "a"], ["s", "a", "r", "l"], ["s", "r", "l"], ["s", "p", "a"], ["s", "c", "a"], ["l", "l", "c"]];
const ORGANIZATION = /\b(?:bank|sparkasse|volksbank|versicherung|insurance|stadtwerke|verein|stiftung|kasse|finanzamt|amt|verlag|service|services|shop|store|markt|market|club|school|schule|universit\w*|hospital|klinik|praxis|apotheke|pharmacy|hotel|restaurant)\b/;

export function normalizeText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const words = (value: string) => normalizeText(value).split(" ").filter(Boolean);

function nameWords(name: string) {
  const tokens = words(name);
  const kept: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const split = LEGAL_SPLIT.find(parts => parts.every((part, offset) => tokens[index + offset] === part) && (index + parts.length === tokens.length || tokens[index + parts.length].length > 1 || LEGAL.has(tokens[index + parts.length])));
    if (split && index > 0) { index += split.length - 1; continue; }
    if (index > 0 && LEGAL.has(tokens[index])) continue;
    kept.push(tokens[index]);
  }
  return kept;
}

export function normalizeName(name: string) {
  return nameWords(name).join(" ");
}

export function hasCompanyForm(name: string) {
  return nameWords(name).length < words(name).length;
}

export function looksLikePerson(name: string) {
  const tokens = words(name);
  return tokens.length >= 2 && tokens.length <= 5 && !hasCompanyForm(name) && !/[\d&@/+]/.test(name) && !ORGANIZATION.test(normalizeText(name))
    && tokens.every(token => /^\p{L}+$/u.test(token));
}

export function processorOf(text: string) {
  const normalized = normalizeText(text);
  return PROCESSORS.find(processor => processor.pattern.test(normalized)) ?? null;
}

export function isInternalMove(raw: IdentityContext | null | undefined) {
  return !!raw && !raw.own_account && !raw.counterparty_name && !raw.counterparty_iban && !raw.creditor_id && !raw.counterparty_ids?.length
    && ["transfer", "top_up", "unknown"].includes(raw.payment_type);
}

const clip = (value: string, length: number) => Array.from(value.trim()).slice(0, length).join("");

export function identityCandidate(description: string, raw: IdentityContext | null | undefined, ownIbans: ReadonlySet<string> = new Set()): IdentityCandidate | null {
  const descriptionKey = organizationDescriptionKey(description);
  const name = raw?.counterparty_name?.trim() || null;
  const processor = processorOf(name ?? "") ?? (name ? null : processorOf(description));
  if (processor) {
    const own = new Set([...words(processor.label), ...words(processor.slug), ...(name ? words(name) : []), ...LEGAL]);
    const rest = descriptionKey.split(" ").filter(word => word.length > 2 && !own.has(word) && !processor.pattern.test(word)).join(" ");
    if (rest.length < 3) return null;
    return { kind: "processor", displayName: clip(`${processor.label} · ${organizationDisplayName(rest)}`, 200), aliases: [{ type: "description_key", value: clip(`${processor.slug}:${rest}`, 1000) }] };
  }
  const iban = raw?.counterparty_iban?.replace(/\s/g, "").toUpperCase() || null;
  const card = raw?.payment_type === "card";
  const ownAccount = !!raw?.own_account || (!!iban && ownIbans.has(iban));
  const kind: IdentityKind = ownAccount ? "own_account" : isInternalMove(raw) ? "internal"
    : name && raw?.payment_type === "transfer" && !card && !raw.own_side_ids?.length && looksLikePerson(name) ? "person" : "merchant";
  const normalizedName = name ? normalizeName(name) : "";
  const aliases: Alias[] = [];
  if (raw?.creditor_id) aliases.push({ type: "creditor_id", value: raw.creditor_id.toUpperCase() });
  if (iban && !card) aliases.push({ type: "iban", value: iban });
  if (normalizedName) aliases.push({ type: card ? "card_merchant" : "counterparty_name", value: clip(normalizedName, 1000) });
  if (descriptionKey.length >= 3 && kind !== "person") aliases.push({ type: "description_key", value: clip(descriptionKey, 1000) });
  if (!aliases.length) return null;
  const displayName = name ? clip(name, 200) : descriptionKey.length >= 3 ? organizationDisplayName(descriptionKey) : clip(iban ?? description, 200);
  return { kind, displayName: displayName || "Unknown", aliases };
}
