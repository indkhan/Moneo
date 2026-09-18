// E02-S04 deterministic-first mapping with bounded model assistance
// (architecture ##53, 74, 76, 190-192; product ##6.1, 7, 16). Deterministic
// header/profile rules come first and own amount/date/currency coherence;
// one bounded model request assists only when deterministic confidence is
// insufficient and the AI-policy permit gate allows it. The model proposes a
// column map — it never computes or authorizes canonical money, and every
// proposal revalidates deterministically before publication. Samples carry
// header + raw staged cells only (<=50 rows/cols): never account names/ids,
// secrets, bytes or full files. Ordinary logs record path/version/counts,
// never prompts, rows or responses.

import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { issuePermit } from "./ai-policy.ts";
import { validateImportProfile, type UploadProfile } from "./uploads.ts";
import {
  classifyMappingError,
  consumeReservation,
  extractUsage,
  parseModelBody,
  releaseReservation,
  reserveMappingCall,
  validateModelMapping,
  type MappingTransport,
} from "./mapping-provider.ts";

export const MAPPING_SAMPLE_ROWS = 50;
export const MAPPING_SAMPLE_COLS = 50;
const PROOF_CURRENCIES = ["EUR", "JPY", "KWD"];

export type MappingQuestionField = "columns" | "date" | "amount" | "currency" | "account";
export type MappingQuestion = { field: MappingQuestionField; reason: string; detail?: string };

export type MappingPath = "deterministic" | "model-assisted" | "manual";
export type MappingStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";

export type MappingProposalView = {
  workspaceId: string;
  id: string;
  importId: string;
  profile: UploadProfile;
  accountId: string | null;
  suggestedAccountId: string | null;
  path: MappingPath;
  status: MappingStatus;
  questions: MappingQuestion[];
  policyVersion: string | null;
  model: string | null;
  createdAt: string;
};

export class MappingError extends Error {
  readonly code: "mapping_empty" | "mapping_busy" | "mapping_stale" | "mapping_invalid" | "mapping_incomplete" | "permit_denied" | "invalid_request";
  readonly questions?: MappingQuestion[];
  readonly reason?: string;
  constructor(code: MappingError["code"], questions?: MappingQuestion[], reason?: string) {
    super(reason ?? code);
    this.code = code;
    this.questions = questions;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Deterministic header rules: normalized exact-alias match per role.
// Ambiguity (two headers, one role) or absence becomes a targeted question,
// never a guess.
// ---------------------------------------------------------------------------

function normalizeHeader(name: string): string {
  return name.replace(/^\uFEFF/, "").trim().toLowerCase();
}

const DATE_ALIASES = new Set(["date", "datum", "buchungstag", "buchung", "booking date", "transaction date", "value date", "valuta", "posting date"]);
const DESCRIPTION_ALIASES = new Set(["description", "beschreibung", "verwendungszweck", "memo", "details", "detail", "merchant", "text", "betreff", "narrative"]);
const AMOUNT_ALIASES = new Set(["amount", "betrag", "value", "total"]);
const DEBIT_ALIASES = new Set(["debit", "soll", "debit amount", "ausgang"]);
const CREDIT_ALIASES = new Set(["credit", "haben", "credit amount", "eingang"]);
const CURRENCY_ALIASES = new Set(["currency", "waehrung", "währung", "ccy", "curr"]);

function matchRole(header: string[], aliases: Set<string>): string[] {
  const found: string[] = [];
  for (const name of header) {
    if (aliases.has(normalizeHeader(name))) found.push(name);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Strict cell validators (S04's deterministic ownership of amount/date/
// currency coherence; canonical parsing stays with the parser/money core).
// ---------------------------------------------------------------------------

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const round = new Date(Date.UTC(y, m - 1, d));
  return round.getUTCFullYear() === y && round.getUTCMonth() === m - 1 && round.getUTCDate() === d;
}

export function parseDateCell(value: string, format: UploadProfile["dateFormat"]): { ok: true; iso: string } | { ok: false } {
  const trimmed = value.trim();
  if (format === "iso") {
    const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { ok: false };
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return isCalendarDate(y, mo, d) ? { ok: true, iso: trimmed } : { ok: false };
  }
  if (format === "de") {
    const m = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return { ok: false };
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    return isCalendarDate(y, mo, d) ? { ok: true, iso: `${m[3]}-${m[2]}-${m[1]}` } : { ok: false };
  }
  if (format === "us") {
    const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return { ok: false };
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const y = Number(m[3]);
    return isCalendarDate(y, mo, d) ? { ok: true, iso: `${m[3]}-${m[1]}-${m[2]}` } : { ok: false };
  }
  const serial = trimmed.match(/^(\d{1,5})$/);
  if (!serial) return { ok: false };
  const ms = Date.UTC(1899, 11, 30) + Number(serial[1]) * 86_400_000;
  const date = new Date(ms);
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return { ok: false };
  return { ok: true, iso: date.toISOString().slice(0, 10) };
}

export function detectDateFormat(value: string): UploadProfile["dateFormat"] | null {
  const formats: UploadProfile["dateFormat"][] = ["iso", "de", "us", "excel-serial"];
  for (const format of formats) {
    if (parseDateCell(value, format).ok) return format;
  }
  return null;
}

/** Strict dialect amount shape check: correct separators, grouping, sign. */
export function parseAmountCell(
  value: string,
  seps: { decimalSep: "." | ","; thousandsSep: "." | "," | "" },
  kind: "signed" | "debit-credit",
): { ok: boolean } {
  let rest = value.trim();
  if (!rest) return { ok: false };
  if (kind === "signed") {
    if (rest.startsWith("+") || rest.startsWith("-")) rest = rest.slice(1);
  } else if (/^[+-]/.test(rest)) {
    return { ok: false };
  }
  if (!rest) return { ok: false };
  const { decimalSep, thousandsSep } = seps;
  const decimals = rest.split(decimalSep);
  if (decimals.length > 2) return { ok: false };
  let whole = rest;
  if (decimals.length === 2) {
    whole = decimals[0]!;
    if (!/^[0-9]+$/.test(decimals[1]!)) return { ok: false };
  }
  if (thousandsSep === "" || !whole.includes(thousandsSep)) {
    // No thousands separator present: plain digits (grouping is optional in
    // real exports — "2500" stays valid whether or not a separator is set).
    if (!/^[0-9]+$/.test(whole)) return { ok: false };
  } else {
    const groups = whole.split(thousandsSep);
    if (groups.length === 0 || !/^[0-9]{1,3}$/.test(groups[0]!)) return { ok: false };
    for (let i = 1; i < groups.length; i++) {
      if (!/^[0-9]{3}$/.test(groups[i]!)) return { ok: false };
    }
  }
  return { ok: true };
}

const SEP_COMBOS: { decimalSep: "." | ","; thousandsSep: "." | "," | "" }[] = [
  { decimalSep: ".", thousandsSep: "" },
  { decimalSep: ".", thousandsSep: "," },
  { decimalSep: ",", thousandsSep: "." },
  { decimalSep: ",", thousandsSep: "" },
];

// ---------------------------------------------------------------------------
// Deduce: header + raw sample rows -> profile proposal with confidence.
// ---------------------------------------------------------------------------

export type DeduceResult = { profile: UploadProfile; confidence: "high" | "low"; questions: MappingQuestion[] };

export type ParseDialect = { delimiter: "," | ";"; defaultCurrency?: string; seps: { decimalSep: "." | ","; thousandsSep: "." | "," | "" } };

export function deduceMapping(
  header: string[],
  samples: Record<string, string>[],
  parse: ParseDialect,
): DeduceResult {
  const questions: MappingQuestion[] = [];
  if (parse.delimiter !== "," && parse.delimiter !== ";") throw new TenantInvalid();
  const dates = matchRole(header, DATE_ALIASES);
  const descriptions = matchRole(header, DESCRIPTION_ALIASES);
  const amounts = matchRole(header, AMOUNT_ALIASES);
  const debits = matchRole(header, DEBIT_ALIASES);
  const credits = matchRole(header, CREDIT_ALIASES);
  const currencies = matchRole(header, CURRENCY_ALIASES);

  if (dates.length === 0) questions.push({ field: "date", reason: "missing-date-column", detail: header.join("|").slice(0, 200) });
  if (dates.length > 1) questions.push({ field: "date", reason: "ambiguous-date-column", detail: dates.join(",") });
  if (descriptions.length === 0) questions.push({ field: "columns", reason: "missing-description-column" });
  if (descriptions.length > 1) questions.push({ field: "columns", reason: "ambiguous-description-column", detail: descriptions.join(",") });

  const hasAmount = amounts.length === 1;
  const hasSplit = debits.length === 1 && credits.length === 1;
  if (!hasAmount && !hasSplit) questions.push({ field: "amount", reason: "missing-amount-column" });
  if (amounts.length > 1 || debits.length > 1 || credits.length > 1 || (hasAmount && hasSplit)) {
    questions.push({ field: "amount", reason: "ambiguous-amount-column" });
  }
  const kind: "signed" | "debit-credit" = hasSplit && !hasAmount ? "debit-credit" : "signed";

  const dateValues = samples.map((r) => r[dates[0]!] ?? "").filter((v) => v.trim() !== "");
  const dateFormats = new Set(dateValues.map(detectDateFormat));
  let dateFormat: UploadProfile["dateFormat"] = "iso";
  if (dateValues.length === 0 || dateFormats.size !== 1 || dateFormats.has(null)) {
    questions.push({ field: "date", reason: dateValues.length === 0 ? "missing-date-values" : "ambiguous-date-format" });
  } else {
    dateFormat = [...dateFormats][0]!;
  }

  const amountValues = samples
    .map((r) => {
      if (hasSplit && !hasAmount) return [r[debits[0]!] ?? "", r[credits[0]!] ?? ""].find((v) => v.trim() !== "") ?? "";
      return r[amounts[0]!] ?? "";
    })
    .filter((v) => v.trim() !== "");
  // Separator bias is evidence-based, not a guess: the parse profile
  // demonstrably parsed these bytes into staged rows, so it wins every tie
  // among combos that all cohere with the samples. A combo the parse
  // profile contradicts (or a tie it cannot break) asks a targeted
  // question instead of silently reinterpreting money.
  const passing = SEP_COMBOS.filter((combo) => amountValues.every((v) => parseAmountCell(v, combo, kind).ok));
  const parseConsistent = passing.some((c) => c.decimalSep === parse.seps.decimalSep && c.thousandsSep === parse.seps.thousandsSep);
  // The staged rows exist because the parse profile parsed these bytes: the
  // proposal keeps its separators whenever they cohere, so mapping can never
  // silently reinterpret staged money. Contradiction or an unbreakable tie
  // asks a targeted question instead.
  const seps = parse.seps;
  if (amountValues.length === 0 || !parseConsistent) {
    questions.push({ field: "amount", reason: amountValues.length === 0 ? "missing-amount-values" : "ambiguous-amount-format" });
  }

  let defaultCurrency: string | undefined;
  if (currencies.length > 1) {
    questions.push({ field: "currency", reason: "ambiguous-currency-column", detail: currencies.join(",") });
  } else if (currencies.length === 0) {
    if (parse.defaultCurrency && PROOF_CURRENCIES.includes(parse.defaultCurrency)) defaultCurrency = parse.defaultCurrency;
    else questions.push({ field: "currency", reason: "missing-currency-column" });
  } else {
    const seen = new Set(samples.map((r) => (r[currencies[0]!] ?? "").trim().toUpperCase()).filter((v) => v !== ""));
    const bad = [...seen].filter((c) => !PROOF_CURRENCIES.includes(c));
    if (bad.length > 0) questions.push({ field: "currency", reason: "unsupported-currency", detail: bad.join(",") });
  }

  const profile: UploadProfile = {
    delimiter: parse.delimiter,
    dateFormat,
    amount: { kind, decimalSep: seps?.decimalSep ?? ".", thousandsSep: seps?.thousandsSep ?? "" },
    columns: {
      ...(dates.length === 1 ? { date: dates[0]! } : { date: "date" }),
      ...(descriptions.length === 1 ? { description: descriptions[0]! } : { description: "description" }),
      ...(hasAmount ? { amount: amounts[0]! } : {}),
      ...(hasSplit ? { debit: debits[0]!, credit: credits[0]! } : {}),
      ...(currencies.length === 1 ? { currency: currencies[0]! } : {}),
    },
    ...(defaultCurrency ? { defaultCurrency } : {}),
  };
  return { profile, confidence: questions.length === 0 ? "high" : "low", questions };
}

// ---------------------------------------------------------------------------
// Cell re-validation: a proposed profile must cohere with the staged header
// and every sampled raw row. Returns targeted questions, never guesses.
// ---------------------------------------------------------------------------

export function validateMappingCells(
  profile: UploadProfile,
  header: string[],
  rows: Record<string, string>[],
  parseDelimiter: "," | ";",
): { ok: boolean; questions: MappingQuestion[] } {
  const questions: MappingQuestion[] = [];
  if (profile.delimiter !== parseDelimiter) {
    questions.push({ field: "columns", reason: "delimiter-mismatch" });
    return { ok: false, questions };
  }
  const headerSet = new Set(header);
  const mapped = [profile.columns.date, profile.columns.description, profile.columns.amount, profile.columns.debit, profile.columns.credit, profile.columns.currency];
  for (const name of mapped) {
    if (name !== undefined && !headerSet.has(name)) {
      questions.push({ field: "columns", reason: "unknown-column", detail: name.slice(0, 64) });
    }
  }
  if (questions.length > 0) return { ok: false, questions };
  const failed = new Set<MappingQuestionField>();
  for (const row of rows) {
    const dateRaw = row[profile.columns.date] ?? "";
    if (dateRaw.trim() === "" || !parseDateCell(dateRaw, profile.dateFormat).ok) failed.add("date");
    if (profile.amount.kind === "signed") {
      const amountRaw = row[profile.columns.amount!] ?? "";
      if (amountRaw.trim() === "" || !parseAmountCell(amountRaw, profile.amount, "signed").ok) failed.add("amount");
    } else {
      const debitRaw = row[profile.columns.debit!] ?? "";
      const creditRaw = row[profile.columns.credit!] ?? "";
      if (debitRaw.trim() !== "" && creditRaw.trim() !== "") failed.add("amount");
      const side = debitRaw.trim() !== "" ? debitRaw : creditRaw;
      if (side.trim() === "" || !parseAmountCell(side, profile.amount, "debit-credit").ok) failed.add("amount");
    }
    if (profile.columns.currency !== undefined) {
      const currencyRaw = (row[profile.columns.currency] ?? "").trim().toUpperCase();
      if (currencyRaw === "" || !PROOF_CURRENCIES.includes(currencyRaw)) failed.add("currency");
    } else if (profile.defaultCurrency === undefined || !PROOF_CURRENCIES.includes(profile.defaultCurrency)) {
      failed.add("currency");
    }
  }
  for (const field of failed) questions.push({ field, reason: `sample-mismatch-${field}` });
  return { ok: questions.length === 0, questions };
}

// ---------------------------------------------------------------------------
// Sample loading: header (stored at parse terminal, raw-union fallback) +
// up to 50 staged raw rows. Uniform raw logical cells for every status.
// ---------------------------------------------------------------------------

export type MappingSample = { header: string[]; rows: Record<string, string>[]; parseDelimiter: "," | ";"; parseDefaultCurrency?: string; parseSeps: { decimalSep: "." | ","; thousandsSep: "." | "," | "" } };

async function sampleIn(client: PoolClient, workspaceId: string, importId: string): Promise<MappingSample | null> {
  const imp = await client.query("SELECT source_columns FROM imports WHERE workspace_id = $1 AND id = $2", [workspaceId, importId]);
  if ((imp.rowCount ?? 0) === 0) return null;
  const job = await client.query("SELECT input_ref FROM background_jobs WHERE workspace_id = $1 AND deduplication_key = $2", [
    workspaceId,
    `imports.parse:${importId}`,
  ]);
  if ((job.rowCount ?? 0) === 0) return null;
  const inputRef = (job.rows[0] as { input_ref: { profile: { delimiter: "," | ";"; defaultCurrency?: string; amount: { decimalSep: "." | ","; thousandsSep: "." | "," | "" }; columns: Record<string, string> } } }).input_ref;
  let header = (imp.rows[0] as { source_columns: string[] | null }).source_columns;
  const rows = await client.query("SELECT raw_cells FROM parsed_observations WHERE workspace_id = $1 AND import_id = $2 ORDER BY row_no LIMIT $3", [
    workspaceId,
    importId,
    MAPPING_SAMPLE_ROWS,
  ]);
  // Stored raw cells are keyed by LOGICAL column role (the parse profile's
  // view); mapping reasons over PHYSICAL header names, so translate through
  // the durable parse profile before anything else touches the sample.
  const logicalToHeader = inputRef.profile.columns;
  const records = (rows.rows as { raw_cells: Record<string, string> | null }[]).map((r) => {
    const raw = r.raw_cells ?? {};
    const remapped: Record<string, string> = {};
    for (const [logical, value] of Object.entries(raw)) {
      remapped[logicalToHeader[logical] ?? logical] = value;
    }
    return remapped;
  });
  if (!Array.isArray(header) || header.length === 0) {
    const union: string[] = [];
    for (const record of records) {
      for (const key of Object.keys(record)) {
        if (!union.includes(key) && union.length < MAPPING_SAMPLE_COLS) union.push(key);
      }
    }
    header = union;
  }
  return { header: header.slice(0, MAPPING_SAMPLE_COLS), rows: records, parseDelimiter: inputRef.profile.delimiter, parseDefaultCurrency: inputRef.profile.defaultCurrency, parseSeps: inputRef.profile.amount };
}

export async function loadMappingSample(pool: Pool, claims: TenantClaims, importId: string): Promise<MappingSample | null> {
  if (!isUuid(importId)) return null;
  return withTenant(pool, claims, (client) => sampleIn(client, claims.workspaceId, importId));
}

type ProposalRow = {
  workspace_id: string;
  id: string;
  import_id: string;
  profile: UploadProfile;
  account_id: string | null;
  path: MappingPath;
  status: MappingStatus;
  questions: MappingQuestion[];
  policy_version: string | null;
  model: string | null;
  created_at: unknown;
};

function rowToView(row: ProposalRow): MappingProposalView {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    importId: row.import_id,
    profile: row.profile,
    accountId: row.account_id,
    suggestedAccountId: row.account_id,
    path: row.path,
    status: row.status,
    questions: row.questions,
    policyVersion: row.policy_version === null ? null : String(row.policy_version),
    model: row.model,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

async function resolveAccount(client: PoolClient, workspaceId: string): Promise<{ accountId: string | null; question: MappingQuestion | null }> {
  const found = await client.query("SELECT id FROM accounts WHERE workspace_id = $1 ORDER BY created_at", [workspaceId]);
  if ((found.rowCount ?? 0) === 0) return { accountId: null, question: null };
  if ((found.rowCount ?? 0) === 1) return { accountId: (found.rows[0] as { id: string }).id, question: null };
  return { accountId: null, question: { field: "account", reason: "ambiguous-account", detail: `${found.rowCount} accounts` } };
}

async function currentProposal(client: PoolClient, workspaceId: string, importId: string): Promise<ProposalRow | null> {
  const found = await client.query(
    "SELECT workspace_id, id, import_id, profile, account_id, path, status, questions, policy_version, model, created_at FROM mapping_proposals WHERE workspace_id = $1 AND import_id = $2 AND status IN ('PROPOSED', 'ACCEPTED') ORDER BY created_at DESC LIMIT 1",
    [workspaceId, importId],
  );
  return ((found.rowCount ?? 0) === 0 ? null : (found.rows[0] as ProposalRow));
}

async function policyVersionIn(client: PoolClient, workspaceId: string): Promise<string> {
  const rows = await client.query("SELECT policy_version AS v FROM ai_policies WHERE workspace_id = $1", [workspaceId]);
  return (rows.rowCount ?? 0) === 0 ? "1" : String((rows.rows[0] as { v: string }).v);
}

async function storeProposal(
  client: PoolClient,
  workspaceId: string,
  importId: string,
  input: { profile: UploadProfile; accountId: string | null; path: MappingPath; questions: MappingQuestion[]; policyVersion: string; permitId?: string; reservationId?: string; model?: string },
): Promise<string> {
  const id = uuidv7();
  await client.query(
    "INSERT INTO mapping_proposals (workspace_id, id, import_id, profile, account_id, path, status, questions, policy_version, permit_id, reservation_id, model) VALUES ($1, $2, $3, $4, $5, $6, 'PROPOSED', $7, $8, $9, $10, $11)",
    [workspaceId, id, importId, JSON.stringify(input.profile), input.accountId, input.path, JSON.stringify(input.questions), input.policyVersion, input.permitId ?? null, input.reservationId ?? null, input.model ?? null],
  );
  return id;
}

export type ProposeResult = { proposal: MappingProposalView; aiUsed: boolean; fallback?: "manual" | "model-unavailable"; replayed: boolean };

// Propose a mapping: deterministic first; bounded model assistance only on
// low confidence with a configured transport; manual questions otherwise. An
// existing open proposal replays instead of spending again. Provider I/O
// always happens outside tenant transactions.
export async function proposeMapping(
  pool: Pool,
  claims: TenantClaims,
  importId: string,
  opts: { transport: MappingTransport | null; model?: string; replace?: boolean },
): Promise<ProposeResult> {
  if (!isUuid(importId)) throw new TenantDenied();
  const gate = await withTenant(pool, claims, async (client) => {
    const own = await client.query("SELECT 1 FROM imports WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, importId]);
    if ((own.rowCount ?? 0) === 0) throw new TenantDenied();
    const obs = await client.query("SELECT count(*)::int AS n FROM parsed_observations WHERE workspace_id = $1 AND import_id = $2", [
      claims.workspaceId,
      importId,
    ]);
    if (((obs.rows[0] as { n: number }).n) === 0) throw new MappingError("mapping_empty");
    const existing = await currentProposal(client, claims.workspaceId, importId);
    if (existing && !opts.replace) return { replay: true as const, id: existing.id };
    if (existing && opts.replace) {
      await client.query("UPDATE mapping_proposals SET status = 'SUPERSEDED' WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, existing.id]);
    }
    return { replay: false as const, id: null as string | null };
  });
  if (gate.replay) {
    const view = await readProposal(pool, claims, gate.id);
    return { proposal: view!, aiUsed: view!.path === "model-assisted", replayed: true };
  }
  const sample = await loadMappingSample(pool, claims, importId);
  if (!sample) throw new TenantDenied();
  const deduced = deduceMapping(sample.header, sample.rows, { delimiter: sample.parseDelimiter, defaultCurrency: sample.parseDefaultCurrency, seps: sample.parseSeps });
  const policyVersion = await withTenant(pool, claims, (client) => policyVersionIn(client, claims.workspaceId));
  const accounts = await withTenant(pool, claims, (client) => resolveAccount(client, claims.workspaceId));
  const questions = [...deduced.questions, ...(accounts.question ? [accounts.question] : [])];
  if (deduced.confidence === "high" && questions.length === 0) {
    const id = await withTenant(pool, claims, (client) =>
      storeProposal(client, claims.workspaceId, importId, { profile: deduced.profile, accountId: accounts.accountId, path: "deterministic", questions: [], policyVersion }),
    );
    const view = await readProposal(pool, claims, id);
    return { proposal: view!, aiUsed: false, replayed: false };
  }
  if (!opts.transport) {
    const id = await withTenant(pool, claims, (client) =>
      storeProposal(client, claims.workspaceId, importId, { profile: deduced.profile, accountId: accounts.accountId, path: "manual", questions, policyVersion }),
    );
    const view = await readProposal(pool, claims, id);
    return { proposal: view!, aiUsed: false, fallback: "manual", replayed: false };
  }
  return proposeWithModel(pool, claims, importId, sample, deduced, questions, accounts.accountId, policyVersion, opts.transport, opts.model ?? "liquid/lfm-2.5-2.6b:free");
}

function buildMappingPrompt(sample: { header: string[]; rows: Record<string, string>[] }): { system: string; user: string } {
  const system = [
    "You map bank-statement columns to a strict import profile. Reply with JSON only: {\"profile\": {...}, \"notes\": \"...\"}.",
    "The profile shape is {delimiter: ',' | ';', dateFormat: 'iso' | 'de' | 'us' | 'excel-serial',",
    " amount: {kind: 'signed' | 'debit-credit', decimalSep: '.' | ',', thousandsSep: '.' | ',' | ''},",
    " columns: {date, description, amount?, debit?, credit?, currency?}, defaultCurrency?: 'EUR' | 'JPY' | 'KWD'}.",
    "Rules: every columns value must be one of the given headers; decimalSep and thousandsSep must differ;",
    "prefer signed amount when one amount column exists; use debit/credit only when two split columns exist;",
    "never invent columns, money values, or currencies; keep notes under 500 characters.",
  ].join(" ");
  const rows = sample.rows.slice(0, 50).map((cells, i) => ({ row: i + 1, cells }));
  return { system, user: JSON.stringify({ header: sample.header.slice(0, 50), rows }) };
}

async function proposeWithModel(
  pool: Pool,
  claims: TenantClaims,
  importId: string,
  sample: { header: string[]; rows: Record<string, string>[]; parseDelimiter: "," | ";" },
  deduced: DeduceResult,
  questions: MappingQuestion[],
  accountId: string | null,
  policyVersion: string,
  transport: MappingTransport,
  model: string,
): Promise<ProposeResult> {
  const storeManual = async (): Promise<ProposeResult> => {
    const id = await withTenant(pool, claims, (client) =>
      storeProposal(client, claims.workspaceId, importId, { profile: deduced.profile, accountId, path: "manual", questions, policyVersion }),
    );
    const view = await readProposal(pool, claims, id);
    return { proposal: view!, aiUsed: false, fallback: "manual" as const, replayed: false };
  };
  let permit: { id: string; policyVersion: string } | null = null;
  try {
    permit = await issuePermit(pool, claims, "import-mapping");
  } catch {
    // Permit gate closed: deterministic/manual only, nothing dispatched.
    return storeManual();
  }
  let reservation: { id: string; model: string };
  try {
    reservation = await reserveMappingCall(pool, claims, importId, model);
  } catch (err) {
    if (err instanceof Error && err.message === "mapping_busy") throw new MappingError("mapping_busy");
    throw err;
  }
  const prompt = buildMappingPrompt(sample);
  let attempt: { httpStatus: number | null; bodyText: string } | undefined;
  let retryable = false;
  for (let round = 0; round < 2; round++) {
    attempt = await transport({ model, system: prompt.system, user: prompt.user, maxOutputTokens: 2000 }, 30_000);
    retryable = classifyMappingError(attempt.httpStatus).retryable;
    if (!retryable) break;
  }
  const usage = extractUsage(attempt?.bodyText ?? "", model);
  await consumeReservation(pool, claims, reservation.id, usage);
  if (!attempt || attempt.httpStatus !== 200) {
    const manual = await storeManual();
    return { ...manual, fallback: "model-unavailable" as const };
  }
  try {
    const parsed = parseModelBody(attempt.bodyText);
    const validated = validateModelMapping(parsed);
    for (const name of [validated.profile.columns.date, validated.profile.columns.description, validated.profile.columns.amount, validated.profile.columns.debit, validated.profile.columns.credit, validated.profile.columns.currency]) {
      if (name !== undefined && !sample.header.includes(name)) throw new Error(`model-output-unknown-column:${name}`);
    }
    const recheck = validateMappingCells(validated.profile, sample.header, sample.rows, sample.parseDelimiter);
    if (!recheck.ok) throw new Error(`model-output-sample-mismatch:${recheck.questions.map((q) => q.reason).join(",")}`);
    const id = await withTenant(pool, claims, (client) =>
      storeProposal(client, claims.workspaceId, importId, {
        profile: validated.profile,
        accountId,
        path: "model-assisted",
        questions,
        policyVersion: permit!.policyVersion,
        permitId: permit!.id,
        reservationId: reservation.id,
        model,
      }),
    );
    const view = await readProposal(pool, claims, id);
    return { proposal: view!, aiUsed: true, replayed: false };
  } catch {
    const manual = await storeManual();
    return manual;
  }
}

export async function readProposal(pool: Pool, claims: TenantClaims, proposalId: string): Promise<MappingProposalView | null> {
  if (!isUuid(proposalId)) return null;
  return withTenant(pool, claims, async (client) => {
    const found = await client.query(
      "SELECT workspace_id, id, import_id, profile, account_id, path, status, questions, policy_version, model, created_at FROM mapping_proposals WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, proposalId],
    );
    if ((found.rowCount ?? 0) === 0) return null;
    return rowToView(found.rows[0] as ProposalRow);
  });
}

export async function readCurrentMapping(pool: Pool, claims: TenantClaims, importId: string): Promise<MappingProposalView | null> {
  if (!isUuid(importId)) return null;
  return withTenant(pool, claims, async (client) => {
    const found = await currentProposal(client, claims.workspaceId, importId);
    return found ? rowToView(found) : null;
  });
}

export type AcceptMappingInput = { proposalId: string; accountId?: string; profile?: unknown; saveAs?: string };

export type AcceptMappingResult = { proposal: MappingProposalView; profileName: string | null; profileVersion: string | null; replayed: boolean };

// Accept a mapping: deterministic revalidation first, then the permit gate
// (for model-assisted proposals), then the atomic accept — all in one
// tenant transaction, so a policy change between dispatch and publication
// fails the accept instead of publishing stale work.
export async function acceptMapping(
  pool: Pool,
  claims: TenantClaims,
  importId: string,
  raw: AcceptMappingInput,
): Promise<AcceptMappingResult> {
  if (!isUuid(importId)) throw new TenantDenied();
  if (!raw || typeof raw !== "object" || !isUuid(raw.proposalId)) throw new MappingError("invalid_request");
  const inputAccount = raw.accountId;
  if (inputAccount !== undefined && typeof inputAccount !== "string") throw new MappingError("invalid_request");
  const saveAs = raw.saveAs;
  if (saveAs !== undefined && (typeof saveAs !== "string" || saveAs.length < 1 || saveAs.length > 120)) {
    throw new MappingError("invalid_request");
  }
  return withTenant(pool, claims, async (client) => {
    const own = await client.query("SELECT 1 FROM imports WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, importId]);
    if ((own.rowCount ?? 0) === 0) throw new TenantDenied();
    const found = await client.query(
      "SELECT workspace_id, id, import_id, profile, account_id, path, status, questions, policy_version, model, created_at, permit_id FROM mapping_proposals WHERE workspace_id = $1 AND id = $2 AND import_id = $3",
      [claims.workspaceId, raw.proposalId, importId],
    );
    if ((found.rowCount ?? 0) === 0) throw new TenantDenied();
    const current = found.rows[0] as ProposalRow & { permit_id: string | null };
    if (current.status === "ACCEPTED") {
      return { proposal: rowToView(current), profileName: null, profileVersion: null, replayed: true };
    }
    if (current.status !== "PROPOSED") throw new MappingError("mapping_stale");
    const finalProfile = raw.profile === undefined ? (current.profile as UploadProfile) : validateImportProfile(raw.profile);
    const sample = await sampleIn(client, claims.workspaceId, importId);
    if (!sample) throw new TenantDenied();
    const recheck = validateMappingCells(finalProfile, sample.header, sample.rows, sample.parseDelimiter);
    let finalAccount: string | null = current.account_id;
    if (inputAccount !== undefined) {
      if (!isUuid(inputAccount)) throw new MappingError("invalid_request", undefined, "unknown-account");
      const owned = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, inputAccount]);
      if ((owned.rowCount ?? 0) === 0) throw new MappingError("invalid_request", undefined, "unknown-account");
      finalAccount = inputAccount;
    }
    const accounts = await resolveAccount(client, claims.workspaceId);
    if (finalAccount === null && accounts.question) {
      throw new MappingError("mapping_incomplete", [{ field: "account", reason: "ambiguous-account" }]);
    }
    if (finalAccount === null) finalAccount = accounts.accountId;
    if (recheck.questions.length > 0) throw new MappingError("mapping_invalid", recheck.questions);
    // Permit gate for model-assisted proposals: revocation between dispatch
    // and this accept fails closed here, publishing nothing.
    let policyVersion = current.policy_version === null ? null : String(current.policy_version);
    if (current.path === "model-assisted") {
      if (!current.permit_id) throw new MappingError("permit_denied", undefined, "permit-missing");
      policyVersion = await consumePermitTx(client, claims.workspaceId, current.permit_id);
    } else {
      policyVersion = await policyVersionIn(client, claims.workspaceId);
    }
    await client.query("UPDATE mapping_proposals SET status = 'SUPERSEDED' WHERE workspace_id = $1 AND import_id = $2 AND status = 'PROPOSED' AND id <> $3", [
      claims.workspaceId,
      importId,
      raw.proposalId,
    ]);
    await client.query("UPDATE mapping_proposals SET status = 'ACCEPTED', profile = $3, account_id = $4, questions = '[]'::jsonb, policy_version = $5 WHERE workspace_id = $1 AND id = $2", [
      claims.workspaceId,
      raw.proposalId,
      JSON.stringify(finalProfile),
      finalAccount,
      policyVersion,
    ]);
    let profileName: string | null = null;
    let profileVersion: string | null = null;
    if (saveAs !== undefined) {
      const maxed = await client.query("SELECT coalesce(max(version), 0)::int AS v FROM mapping_profiles WHERE workspace_id = $1 AND name = $2", [
        claims.workspaceId,
        saveAs,
      ]);
      const version = ((maxed.rows[0] as { v: number }).v) + 1;
      await client.query("INSERT INTO mapping_profiles (workspace_id, id, name, version, profile, created_from) VALUES ($1, $2, $3, $4, $5, $6)", [
        claims.workspaceId,
        uuidv7(),
        saveAs,
        version,
        JSON.stringify(finalProfile),
        current.path,
      ]);
      profileName = saveAs;
      profileVersion = String(version);
    }
    const done = await client.query(
      "SELECT workspace_id, id, import_id, profile, account_id, path, status, questions, policy_version, model, created_at FROM mapping_proposals WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, raw.proposalId],
    );
    return { proposal: rowToView(done.rows[0] as ProposalRow), profileName, profileVersion, replayed: false };
  });
}

// Consume-permit inside the caller's accept transaction (ai-policy's own
// consumePermit opens a second transaction; the accept path needs atomicity
// with its writes, so the check-and-flip happens here on the same client,
// mirroring its version/expiry/status rules).
async function consumePermitTx(client: PoolClient, workspaceId: string, permitId: string): Promise<string> {
  const found = await client.query("SELECT policy_version, status, expires_at FROM ai_dispatch_permits WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
    workspaceId,
    permitId,
  ]);
  if ((found.rowCount ?? 0) === 0) throw new MappingError("permit_denied", undefined, "permit-revoked");
  const row = found.rows[0] as { policy_version: string; status: string; expires_at: string };
  if (row.status !== "QUEUED") throw new MappingError("permit_denied", undefined, "permit-consumed");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new MappingError("permit_denied", undefined, "permit-expired");
  const version = await policyVersionIn(client, workspaceId);
  if (String(row.policy_version) !== version) {
    await client.query("UPDATE ai_dispatch_permits SET status = 'INVALIDATED' WHERE workspace_id = $1 AND id = $2", [workspaceId, permitId]);
    throw new MappingError("permit_denied", undefined, "permit-invalidated");
  }
  await client.query("UPDATE ai_dispatch_permits SET status = 'DISPATCHED' WHERE workspace_id = $1 AND id = $2", [workspaceId, permitId]);
  return version;
}

export async function listMappingProfiles(pool: Pool, claims: TenantClaims, name?: string): Promise<{ name: string; version: string; profile: UploadProfile; createdFrom: string }[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      "SELECT name, version, profile, created_from AS \"createdFrom\" FROM mapping_profiles WHERE workspace_id = $1 AND ($2::text IS NULL OR name = $2) ORDER BY name, version DESC",
      [claims.workspaceId, name ?? null],
    );
    return (rows.rows as { name: string; version: number; profile: UploadProfile; createdFrom: string }[]).map((r) => ({
      name: r.name,
      version: String(r.version),
      profile: r.profile,
      createdFrom: r.createdFrom,
    }));
  });
}

export function mappingErrorBody(err: MappingError): { status: number; body: unknown } {
  if (err.code === "mapping_busy") return { status: 409, body: { error: "conflict", reason: err.code } };
  if (err.code === "permit_denied" || err.code === "mapping_stale") {
    return { status: 409, body: { error: "conflict", reason: err.reason ?? err.code } };
  }
  if (err.code === "mapping_invalid" || err.code === "mapping_incomplete" || err.code === "mapping_empty") {
    return { status: 409, body: { error: "conflict", reason: err.code, questions: err.questions ?? [] } };
  }
  return { status: 400, body: { error: "invalid_request", ...(err.reason ? { reason: err.reason } : {}) } };
}
