import { z } from "zod";
import type { AiDataScope } from "@/lib/settings";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import { recurringCadences } from "@/lib/finance/cadences";

// The agent team's deterministic core. Every number here is computed from
// application data in exact minor units; models only phrase or suggest, and
// every proposal carries the evidence a person needs to accept or reject it.

export const AGENTS = {
  lead: { name: "Lead", role: "Plans the run, assigns work, merges results and resolves conflicts", scopes: [] },
  categorizer: { name: "Categorizer", role: "Organizes every unorganized row: your rules, memory and the bank's data first, then the AI; sure labels are applied, marked and undoable, and the rest become questions for you", scopes: ["transactions"] },
  recurring: { name: "Recurring detective", role: "Finds subscriptions and bills and raises them on Home", scopes: ["accounts", "transactions"] },
  anomaly: { name: "Anomaly hunter", role: "Finds duplicates, fees, unusual charges and price increases", scopes: ["transactions"] },
  budget: { name: "Budget coach", role: "Proposes monthly category limits from real history", scopes: ["transactions", "planning"] },
  forecaster: { name: "Cash-flow forecaster", role: "Projects cash and flags shortfalls", scopes: ["accounts", "transactions", "planning"] },
  writer: { name: "Insight writer", role: "Writes the briefing from verified findings", scopes: [] },
} as const satisfies Record<string, { name: string; role: string; scopes: AiDataScope[] }>;
export type AgentId = keyof typeof AGENTS;
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];
/** Agents in the same wave run in parallel; later waves read earlier proposals. The categorizer goes first, alone. */
export const WAVES: AgentId[][] = [["categorizer"], ["recurring", "anomaly", "budget"], ["forecaster"], ["writer"]];

const versioned = z.object({ id: z.uuid(), version: z.number().int().min(0).max(2147483647) }).strict();
export const payloadSchemas = {
  categorize: z.object({ rows: z.array(versioned).min(1).max(50), patch: z.object({ merchant_id: z.uuid().nullable().optional(), category_id: z.uuid().nullable().optional() }).strict(),
    merchantName: z.string().trim().min(1).max(100).nullable(), ruleKey: z.string().min(3).max(1000).nullable(), evidence: z.array(versioned).max(2000),
    // The identity (or description) key; an undone label is suppressed for it. Missing on proposals from before it existed.
    identityKey: z.string().max(1000).optional(),
    // Who decided: the AI, or the owner's rule or memory or the bank's own data ('system'). Missing means the AI.
    source: z.enum(["ai", "rule", "memory", "system"]).optional() }).strict(),
  recurring: z.object({ accountId: z.uuid(), label: z.string().trim().min(1).max(200), cadence: z.enum(recurringCadences), currencyCode: z.string().regex(/^[A-Z]{3}$/),
    evidence: z.array(versioned).min(3).max(1000), runAnchorId: z.uuid(), evidenceLimited: z.boolean() }).strict(),
  budget: z.object({ categoryId: z.uuid(), currencyCode: z.string().regex(/^[A-Z]{3}$/), limitMinor: z.string().regex(/^[1-9]\d{0,17}$/) }).strict(),
  finding: z.object({ severity: z.enum(["high", "medium", "low"]), transactionIds: z.array(z.uuid()).max(50) }).strict(),
};
export type ProposalKind = keyof typeof payloadSchemas;

export type EvidenceRow = { id: string; date: string; description: string; amountMinor: string; currency: string };
export type Evidence = { facts: { label: string; value: string }[]; transactions: EvidenceRow[]; links: { label: string; href: string }[] };
export type Proposal<K extends ProposalKind = ProposalKind> = K extends ProposalKind ? {
  agent: AgentId; kind: K; conflictKey: string; title: string; detail: string; evidence: Evidence;
  payload: z.infer<(typeof payloadSchemas)[K]>; confidence: number; notes: string[];
} : never;
export type LedgerRow = {
  id: string; version: number; date: string; description: string; amountMinor: bigint; currency: string; accountId: string;
  categoryId: string | null; merchantId: string | null; kind: string; status: string; reviewReasons: string[];
};

const abs = (value: bigint) => value < 0n ? -value : value;
const evidenceRow = (row: LedgerRow): EvidenceRow => ({ id: row.id, date: row.date, description: row.description.slice(0, 120), amountMinor: row.amountMinor.toString(), currency: row.currency });
const txLink = (id: string) => `/money/transactions?transaction=${id}`;
const median = (values: bigint[]) => {
  const sorted = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle] + 1n) / 2n;
};
export const reviewed = (row: LedgerRow) => row.status === "posted" && row.kind === "ordinary" && !row.reviewReasons.length;
export const daysBefore = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

// ── Lead: plan ───────────────────────────────────────────────────────────────
export type Profile = { transactions: number; unorganized: number; months: number; spendingLimits: number; scopes: AiDataScope[] };
export type PlannedTask = { agent: AgentId; wave: number; status: "pending" | "skipped"; reason: string };

/** Deterministic plan: which agents run, in which wave, and why the others are skipped. */
export function planRun(profile: Profile): PlannedTask[] {
  const why: Partial<Record<AgentId, string>> = {
    categorizer: profile.unorganized ? `${profile.unorganized} rows lack a merchant or category` : "",
    recurring: profile.months >= 2 ? `${profile.months} months of history can show repeating payments` : "",
    budget: profile.months >= 2 ? "Enough complete months to suggest limits" : "",
  };
  const skip: Partial<Record<AgentId, string>> = {
    categorizer: profile.unorganized ? undefined : "Every recent row already has a merchant and category",
    recurring: profile.months >= 2 ? undefined : "Needs at least two months of history",
    // The coach tunes limits the owner chose to keep; it does not invent a budget for someone who has none.
    budget: !profile.spendingLimits ? "No spending limits set up" : profile.months >= 2 ? undefined : "Needs at least two months of history",
  };
  return WAVES.flatMap((agents, wave) => agents.map(agent => {
    const missing = AGENTS[agent].scopes.filter(scope => !profile.scopes.includes(scope));
    const blocked = !profile.transactions ? "No posted transactions yet" : missing.length ? `Allow AI access to ${missing.join(", ")} in Settings` : skip[agent];
    return blocked ? { agent, wave, status: "skipped" as const, reason: blocked }
      : { agent, wave, status: "pending" as const, reason: why[agent] || AGENTS[agent].role };
  }));
}

export type Backlog = { transactionsAllowed: boolean; unorganized: number; recentRuns: string[]; unorganizedSinceLatestRun: boolean };

/**
 * Whether the hourly check should start a run for rows still lacking a merchant or category.
 * recentRuns holds the newest runs' statuses, newest first. Rows a finished run looked at and
 * left alone stay alone; new rows or a failed run are worth another go, up to three failures in a row.
 */
export function backlogRerunNeeded(backlog: Backlog) {
  const [latest] = backlog.recentRuns;
  if (!backlog.transactionsAllowed || !backlog.unorganized || backlog.recentRuns.some(status => status === "queued" || status === "running")) return false;
  if (!latest || backlog.unorganizedSinceLatestRun) return true;
  return latest === "failed" && !(backlog.recentRuns.length >= 3 && backlog.recentRuns.slice(0, 3).every(status => status === "failed"));
}

// ── Categorizer ──────────────────────────────────────────────────────────────
/** High and medium labels are applied by the organizer itself; low ones wait for the owner. */
export const aiConfidence = (confidence: number) => confidence >= 85 ? "high" as const : confidence >= 60 ? "medium" as const : "low" as const;

// ── Anomaly hunter ───────────────────────────────────────────────────────────
const FEE = /\b(?:fee|fees|commission|overdraft|penalty|late charge|interest charge|atm|service charge)\b/i;
export function anomalyFindings(rows: LedgerRow[], today: string, locale?: string): Proposal<"finding">[] {
  const findings: Proposal<"finding">[] = [];
  const spend = rows.filter(row => reviewed(row) && row.amountMinor < 0n);
  const key = (row: LedgerRow) => [row.accountId, row.currency, row.amountMinor, row.description.toLowerCase().replace(/\d{4,}/g, "").replace(/\s+/g, " ").trim()].join("|");
  const groups = new Map<string, LedgerRow[]>();
  for (const row of spend) groups.set(key(row), [...groups.get(key(row)) ?? [], row]);
  for (const group of groups.values()) {
    const sorted = group.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (let index = 1; index < sorted.length; index++) {
      const [a, b] = [sorted[index - 1], sorted[index]];
      if (Date.parse(b.date) - Date.parse(a.date) > 86_400_000) continue;
      findings.push({ agent: "anomaly", kind: "finding", conflictKey: `duplicate:${a.id}:${b.id}`, title: `Possible duplicate: ${a.description.slice(0, 60)}`,
        detail: `Two identical ${formatMoney(abs(a.amountMinor), a.currency, locale)} charges on ${a.date} and ${b.date} in the same account. Check with the merchant before disputing; split bills can look like this.`,
        evidence: { facts: [{ label: "Amount", value: formatMoney(abs(a.amountMinor), a.currency, locale) }], transactions: [a, b].map(evidenceRow), links: [a, b].map((row, n) => ({ label: `Charge ${n + 1}`, href: txLink(row.id) })) },
        payload: { severity: "high", transactionIds: [a.id, b.id] }, confidence: 70, notes: [] });
    }
  }
  const since = daysBefore(today, 90);
  const fees = rows.filter(row => row.status === "posted" && row.amountMinor < 0n && row.date >= since && FEE.test(row.description));
  for (const currency of [...new Set(fees.map(row => row.currency))].sort()) {
    const items = fees.filter(row => row.currency === currency), total = items.reduce((sum, row) => sum - row.amountMinor, 0n);
    findings.push({ agent: "anomaly", kind: "finding", conflictKey: `fees:${currency}`, title: `${items.length} fees and charges: ${formatMoney(total, currency, locale)} in 90 days`,
      detail: "Descriptions mention fees, interest or ATM charges. Some may be avoidable by changing account plan or payment method.",
      evidence: { facts: [{ label: "Total", value: formatMoney(total, currency, locale) }, { label: "Count", value: String(items.length) }, { label: "Since", value: since }],
        transactions: items.slice(0, 8).map(evidenceRow), links: [{ label: "Search fees", href: "/money/transactions?q=fee" }] },
      payload: { severity: "medium", transactionIds: items.slice(0, 50).map(row => row.id) }, confidence: 75, notes: [] });
  }
  const recentFrom = daysBefore(today, 45);
  for (const row of spend.filter(row => row.date >= recentFrom)) {
    const peers = spend.filter(peer => peer.accountId === row.accountId && peer.currency === row.currency && peer.date < row.date).map(peer => -peer.amountMinor);
    if (peers.length < 10) continue;
    const typical = median(peers), amount = -row.amountMinor;
    if (typical <= 0n || amount < typical * 4n || amount - typical < 50n * 10n ** BigInt(minorDigits(row.currency))) continue;
    findings.push({ agent: "anomaly", kind: "finding", conflictKey: `large:${row.id}`, title: `Unusually large: ${row.description.slice(0, 60)}`,
      detail: `${formatMoney(amount, row.currency, locale)} on ${row.date}, ${amount / typical}× the median ${formatMoney(typical, row.currency, locale)} of ${peers.length} earlier expenses in this account. Size alone does not mean anything is wrong.`,
      evidence: { facts: [{ label: "Amount", value: formatMoney(amount, row.currency, locale) }, { label: "Median", value: formatMoney(typical, row.currency, locale) }],
        transactions: [evidenceRow(row)], links: [{ label: "Transaction", href: txLink(row.id) }] },
      payload: { severity: "low", transactionIds: [row.id] }, confidence: 55, notes: [] });
  }
  return findings;
}

// ── Budget coach ─────────────────────────────────────────────────────────────
/** Monthly limit = the median of the last three complete months, rounded up to a round step. */
export function budgetProposals(rows: LedgerRow[], categories: Map<string, string>, existing: { categoryId: string; currencyCode: string }[], today: string, locale?: string): Proposal<"budget">[] {
  const month = (offset: number) => { const date = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() - offset); return date.toISOString().slice(0, 7); };
  const months = [3, 2, 1].map(month);
  const totals = new Map<string, bigint[]>();
  for (const row of rows) {
    const index = months.indexOf(row.date.slice(0, 7));
    if (index < 0 || !row.categoryId || !reviewed(row)) continue;
    const key = `${row.categoryId}|${row.currency}`;
    const values = totals.get(key) ?? [0n, 0n, 0n];
    values[index] -= row.amountMinor;
    totals.set(key, values);
  }
  const result: Proposal<"budget">[] = [];
  for (const [key, values] of totals) {
    const [categoryId, currency] = key.split("|");
    if (existing.some(plan => plan.categoryId === categoryId && plan.currencyCode === currency) || values.filter(value => value > 0n).length < 2) continue;
    const typical = median(values);
    const step = (typical >= 1000n * 10n ** BigInt(minorDigits(currency)) ? 50n : 10n) * 10n ** BigInt(minorDigits(currency));
    if (typical < step) continue;
    const limit = (typical + step - 1n) / step * step;
    const name = categories.get(categoryId) ?? "Category";
    result.push({ agent: "budget", kind: "budget", conflictKey: `budget:${categoryId}:${currency}`, title: `${name}: ${formatMoney(limit, currency, locale)} a month`,
      detail: `Median of your last three complete months, rounded up. A target only; it never moves money.`,
      evidence: { facts: months.map((label, index) => ({ label, value: formatMoney(values[index], currency, locale) })), transactions: [],
        links: [{ label: `${name} transactions`, href: `/money/transactions?category=${categoryId}&from=${months[0]}-01` }] },
      payload: { categoryId, currencyCode: currency, limitMinor: limit.toString() },
      confidence: values.every(value => value > 0n) ? 75 : 55, notes: [] });
  }
  return result.sort((a, b) => Number(BigInt(b.payload.limitMinor) - BigInt(a.payload.limitMinor))).slice(0, 12);
}

// ── Lead: merge and resolve conflicts ────────────────────────────────────────
/** Deduplicates proposals and resolves cross-agent conflicts; returns the decisions it made. */
export function mergeProposals(input: Proposal[]): { proposals: Proposal[]; resolutions: string[] } {
  const resolutions: string[] = [];
  const byKey = new Map<string, Proposal>();
  for (const proposal of input) {
    const existing = byKey.get(proposal.conflictKey);
    if (existing) resolutions.push(`Kept the ${existing.confidence >= proposal.confidence ? AGENTS[existing.agent].name : AGENTS[proposal.agent].name} version of “${proposal.title}”`);
    if (!existing || proposal.confidence > existing.confidence) byKey.set(proposal.conflictKey, { ...proposal, notes: [...proposal.notes] });
  }
  let proposals = [...byKey.values()];
  const recurringIds = new Set(proposals.flatMap(item => item.kind === "recurring" ? (item as Proposal<"recurring">).payload.evidence.map(row => row.id) : []));
  // A large charge that belongs to a recurring series is explained by it (for example a yearly plan).
  proposals = proposals.filter(item => {
    if (!item.conflictKey.startsWith("large:") || !recurringIds.has((item as Proposal<"finding">).payload.transactionIds[0])) return true;
    resolutions.push(`Dropped “${item.title}”: the Recurring detective explains it as a scheduled payment`);
    return false;
  });
  const duplicates = new Set(proposals.flatMap(item => item.conflictKey.startsWith("duplicate:") ? (item as Proposal<"finding">).payload.transactionIds : []));
  for (const item of proposals) {
    if (item.kind === "categorize") {
      const count = (item as Proposal<"categorize">).payload.rows.filter(row => duplicates.has(row.id)).length;
      if (count) { item.notes.push(`Includes ${count} possible duplicate ${count === 1 ? "charge" : "charges"} flagged by the Anomaly hunter`); resolutions.push(`Flagged possible duplicates inside “${item.title}”`); }
    }
    if (item.kind === "recurring") {
      const ids = new Set((item as Proposal<"recurring">).payload.evidence.map(row => row.id));
      const price = proposals.find(other => other.conflictKey.startsWith("price:") && (other as Proposal<"finding">).payload.transactionIds.some(id => ids.has(id)));
      if (price) item.notes.push(`Anomaly check: ${price.title}`);
    }
  }
  const order: ProposalKind[] = ["finding", "categorize", "recurring", "budget"];
  proposals.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.confidence - a.confidence);
  return { proposals, resolutions };
}

// ── Insight writer ───────────────────────────────────────────────────────────
export type BriefingFacts = { headline: string[]; findings: string[]; actions: string[] };
export function deterministicBriefing(facts: BriefingFacts) {
  return [facts.headline.join(" "), facts.findings.length ? `Worth a look: ${facts.findings.slice(0, 4).join("; ")}.` : "", facts.actions.length ? `Ready for your review: ${facts.actions.join(", ")}.` : ""].filter(Boolean).join("\n\n");
}
/** A model briefing is used only when every number it states appears in the verified facts. */
export function verifiedBriefing(text: string, facts: BriefingFacts): string | null {
  const corpus = [...facts.headline, ...facts.findings, ...facts.actions].join(" ");
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  const numbers = trimmed.match(/\d[\d.,]*\d|\d/g) ?? [];
  return numbers.every(number => corpus.includes(number)) ? trimmed : null;
}
