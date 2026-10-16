import { z } from "zod";
import type { AiDataScope } from "@/lib/settings";
import { formatMoney } from "@/lib/finance/format";
import { minorDigits } from "@/lib/finance/fx";
import type { OrganizationProposal } from "@/lib/import-organization";
import type { RecurringSeries } from "@/lib/finance/recurring";
import { recurringCadences } from "@/lib/finance/cadences";
import { monthlyEquivalent } from "@/app/money/recurring/series";

// The agent team's deterministic core. Every number here is computed from
// application data in exact minor units; models only phrase or suggest, and
// every proposal carries the evidence a person needs to accept or reject it.

export const AGENTS = {
  lead: { name: "Lead", role: "Plans the run, assigns work, merges results and resolves conflicts", scopes: [] },
  categorizer: { name: "Categorizer", role: "Proposes merchants and categories for unorganized rows and learns rules", scopes: ["transactions"] },
  recurring: { name: "Recurring detective", role: "Finds subscriptions and bills and proposes schedules", scopes: ["accounts", "transactions"] },
  anomaly: { name: "Anomaly hunter", role: "Finds duplicates, fees, unusual charges and price increases", scopes: ["transactions"] },
  budget: { name: "Budget coach", role: "Proposes monthly category limits from real history", scopes: ["transactions", "planning"] },
  forecaster: { name: "Cash-flow forecaster", role: "Projects cash and flags shortfalls", scopes: ["accounts", "transactions", "planning"] },
  toolsmith: { name: "Toolsmith", role: "Builds tailored tools through the sandboxed artifact pipeline", scopes: ["transactions"] },
  writer: { name: "Insight writer", role: "Writes the briefing from verified findings", scopes: [] },
} as const satisfies Record<string, { name: string; role: string; scopes: AiDataScope[] }>;
export type AgentId = keyof typeof AGENTS;
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];
/** Agents in the same wave run in parallel; later waves read earlier proposals. */
export const WAVES: AgentId[][] = [["categorizer", "recurring", "anomaly", "budget"], ["forecaster", "toolsmith"], ["writer"]];

const versioned = z.object({ id: z.uuid(), version: z.number().int().min(0).max(2147483647) }).strict();
export const payloadSchemas = {
  categorize: z.object({ rows: z.array(versioned).min(1).max(50), patch: z.object({ merchant_id: z.uuid().nullable().optional(), category_id: z.uuid().nullable().optional() }).strict(),
    merchantName: z.string().trim().min(1).max(100).nullable(), ruleKey: z.string().min(3).max(1000).nullable(), evidence: z.array(versioned).max(2000) }).strict(),
  recurring: z.object({ accountId: z.uuid(), label: z.string().trim().min(1).max(200), cadence: z.enum(recurringCadences), currencyCode: z.string().regex(/^[A-Z]{3}$/),
    evidence: z.array(versioned).min(3).max(1000), runAnchorId: z.uuid(), evidenceLimited: z.boolean() }).strict(),
  budget: z.object({ categoryId: z.uuid(), currencyCode: z.string().regex(/^[A-Z]{3}$/), limitMinor: z.string().regex(/^[1-9]\d{0,17}$/) }).strict(),
  tool: z.object({ template: z.enum(["subscription-audit", "savings-rate", "budget-tracker"]), name: z.string().trim().min(1).max(120),
    params: z.record(z.string(), z.number().finite()) }).strict(),
  finding: z.object({ severity: z.enum(["high", "medium", "low"]), transactionIds: z.array(z.uuid()).max(50) }).strict(),
};
export type ProposalKind = keyof typeof payloadSchemas;

export type EvidenceRow = { id: string; date: string; description: string; amountMinor: string; currency: string };
export type Evidence = { facts: { label: string; value: string }[]; transactions: EvidenceRow[]; links: { label: string; href: string }[] };
export type Proposal<K extends ProposalKind = ProposalKind> = {
  agent: AgentId; kind: K; conflictKey: string; title: string; detail: string; evidence: Evidence;
  payload: z.infer<(typeof payloadSchemas)[K]>; confidence: number; notes: string[];
};
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
const titleCase = (key: string) => key.replace(/\b\p{L}/gu, letter => letter.toLocaleUpperCase("en")).slice(0, 100);
const reviewed = (row: LedgerRow) => row.status === "posted" && row.kind === "ordinary" && !row.reviewReasons.length;

// ── Lead: plan ───────────────────────────────────────────────────────────────
export type Profile = { transactions: number; unorganized: number; months: number; currencies: string[]; scopes: AiDataScope[]; modelAvailable: boolean };
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
    budget: profile.months >= 2 ? undefined : "Needs at least two months of history",
  };
  return WAVES.flatMap((agents, wave) => agents.map(agent => {
    const missing = AGENTS[agent].scopes.filter(scope => !profile.scopes.includes(scope));
    const blocked = !profile.transactions ? "No posted transactions yet" : missing.length ? `Allow AI access to ${missing.join(", ")} in Settings` : skip[agent];
    return blocked ? { agent, wave, status: "skipped" as const, reason: blocked }
      : { agent, wave, status: "pending" as const, reason: why[agent] || AGENTS[agent].role };
  }));
}

// ── Categorizer ──────────────────────────────────────────────────────────────
const BASIS: Record<OrganizationProposal["basis"], string> = {
  "approved-rule": "Your saved rule", "consistent-history": "Consistent history", "provider-suggestion": "AI suggestion (quoted from the description)", "review-required": "Repeated description",
};
/**
 * Groups row-level organization proposals into one reviewable change per
 * description key. Lone review-required rows are left for a person.
 */
export function categorizeGroups(proposals: OrganizationProposal[], rows: Map<string, LedgerRow>, names: { categories: Map<string, string>; merchants: Map<string, string> }): Proposal<"categorize">[] {
  const groups = new Map<string, OrganizationProposal[]>();
  for (const proposal of proposals) {
    const row = rows.get(proposal.transactionId);
    if (!row || proposal.financialReviewRequired) continue;
    const patch = { merchant: !row.merchantId && proposal.merchantId ? proposal.merchantId : null, category: !row.categoryId && proposal.categoryId ? proposal.categoryId : null };
    const merchantName = !row.merchantId && !proposal.merchantId ? proposal.merchantName : null;
    if (!patch.merchant && !patch.category && !merchantName) continue;
    const key = JSON.stringify([proposal.descriptionKey, patch.merchant, patch.category, merchantName, proposal.basis === "provider-suggestion"]);
    groups.set(key, [...groups.get(key) ?? [], proposal]);
  }
  const result: Proposal<"categorize">[] = [];
  for (const [key, members] of groups) {
    const [descriptionKey, merchantId, categoryId, merchantName] = JSON.parse(key) as [string, string | null, string | null, string | null];
    const basis = members[0].basis;
    // A new merchant name taken only from the description needs repetition to be worth a rule.
    if (basis === "review-required" && members.length < 2) continue;
    for (let offset = 0; offset < members.length; offset += 50) {
      const chunk = members.slice(offset, offset + 50);
      const evidence = [...new Map(chunk.flatMap(item => item.evidence).map(item => [item.id, item])).values()].slice(0, 2000);
      const target = [merchantId ? names.merchants.get(merchantId) ?? "known merchant" : merchantName ? `new merchant “${titleCase(merchantName)}”` : null,
        categoryId ? names.categories.get(categoryId) ?? "known category" : null].filter(Boolean).join(" · ");
      result.push({ agent: "categorizer", kind: "categorize", conflictKey: `categorize:${key}:${offset}`,
        title: `${target} for ${chunk.length} “${descriptionKey.slice(0, 40)}” ${chunk.length === 1 ? "row" : "rows"}`,
        detail: `${BASIS[basis]}. Accepting applies one audited batch${descriptionKey.length >= 3 ? " and saves a rule for future imports" : ""}; Undo restores every row.`,
        evidence: { facts: [{ label: "Rows", value: String(chunk.length) }, { label: "Basis", value: BASIS[basis] },
          ...(evidence.length ? [{ label: "Matching history", value: `${evidence.length} earlier rows` }] : []),
          ...(chunk[0].evidenceQuote ? [{ label: "Quoted text", value: chunk[0].evidenceQuote }] : [])],
          transactions: chunk.slice(0, 5).map(item => evidenceRow(rows.get(item.transactionId)!)), links: [{ label: "Organization", href: "/money/organization" }] },
        payload: { rows: chunk.map(item => ({ id: item.transactionId, version: item.version })),
          patch: { ...(merchantId ? { merchant_id: merchantId } : {}), ...(categoryId ? { category_id: categoryId } : {}) },
          merchantName: merchantName ? titleCase(merchantName) : null, ruleKey: descriptionKey.length >= 3 ? descriptionKey : null, evidence },
        confidence: basis === "approved-rule" ? 95 : basis === "consistent-history" ? 85 : basis === "provider-suggestion" ? 60 : 45, notes: [] });
    }
  }
  return result.sort((a, b) => b.payload.rows.length - a.payload.rows.length);
}

// ── Recurring detective ──────────────────────────────────────────────────────
export type StoredSeries = { accountId: string; currencyCode: string; cadence: string; transactionIds: string[] };
export function recurringProposals(series: RecurringSeries[], stored: StoredSeries[], rows: Map<string, LedgerRow>, locale?: string): { proposals: Proposal<"recurring">[]; findings: Proposal<"finding">[] } {
  const proposals: Proposal<"recurring">[] = [], findings: Proposal<"finding">[] = [];
  for (const item of series) {
    const evidence = item.transactionIds.map(id => rows.get(id)).filter((row): row is LedgerRow => Boolean(row));
    if (evidence.length !== item.transactionIds.length) continue;
    const ids = new Set(item.transactionIds);
    const reviewedAlready = stored.some(other => other.accountId === item.accountId && other.currencyCode === item.currencyCode && other.transactionIds.some(id => ids.has(id)));
    const latest = evidence.at(-1)!, previous = evidence.at(-2)!;
    if (abs(latest.amountMinor) > abs(previous.amountMinor) && (abs(latest.amountMinor) - abs(previous.amountMinor)) * 100n >= abs(previous.amountMinor) * 5n) {
      const percent = (abs(latest.amountMinor) - abs(previous.amountMinor)) * 1000n / abs(previous.amountMinor);
      findings.push({ agent: "recurring", kind: "finding", conflictKey: `price:${item.runAnchorId}`,
        title: `${item.label} went up ${percent / 10n}.${percent % 10n}%`,
        detail: `Latest charge ${formatMoney(abs(latest.amountMinor), latest.currency, locale)} on ${latest.date}, previously ${formatMoney(abs(previous.amountMinor), previous.currency, locale)} on ${previous.date}.`,
        evidence: { facts: [{ label: "Before", value: formatMoney(abs(previous.amountMinor), previous.currency, locale) }, { label: "Now", value: formatMoney(abs(latest.amountMinor), latest.currency, locale) }],
          transactions: [previous, latest].map(evidenceRow), links: [{ label: "Latest charge", href: txLink(latest.id) }] },
        payload: { severity: "medium", transactionIds: [previous.id, latest.id] }, confidence: 80, notes: [] });
    }
    if (reviewedAlready) continue;
    const typical = median(evidence.map(row => row.amountMinor));
    const monthly = monthlyEquivalent(typical, item.cadence);
    proposals.push({ agent: "recurring", kind: "recurring", conflictKey: `recurring:${item.runAnchorId}`,
      title: `${item.label} · ${item.cadence} ${typical < 0n ? "payment" : "income"}`,
      detail: `${item.occurrences} matching postings since ${evidence[0].date}. About ${formatMoney(abs(monthly), item.currencyCode, locale)} a month. Confirming adds it to your forecast; “Not recurring” on the Recurring page reverses it.`,
      evidence: { facts: [{ label: "Typical amount", value: formatMoney(typical, item.currencyCode, locale) }, { label: "Per month", value: formatMoney(monthly, item.currencyCode, locale) },
        { label: "Observed", value: `${item.occurrences} times` }, ...(item.missingPeriods ? [{ label: "Gaps", value: `${item.missingPeriods} unobserved periods` }] : [])],
        transactions: evidence.slice(-5).map(evidenceRow), links: [{ label: "Recurring", href: "/money/recurring" }] },
      payload: { accountId: item.accountId, label: item.label.slice(0, 200), cadence: item.cadence, currencyCode: item.currencyCode,
        evidence: evidence.map(row => ({ id: row.id, version: row.version })), runAnchorId: item.runAnchorId, evidenceLimited: item.evidenceLimited },
      confidence: Math.max(1, Math.min(99, Math.round(item.confidence * 100))), notes: [] });
  }
  return { proposals: proposals.sort((a, b) => b.confidence - a.confidence).slice(0, 40), findings };
}

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
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  const fees = rows.filter(row => row.status === "posted" && row.amountMinor < 0n && row.date >= since && FEE.test(row.description));
  for (const currency of [...new Set(fees.map(row => row.currency))].sort()) {
    const items = fees.filter(row => row.currency === currency), total = items.reduce((sum, row) => sum - row.amountMinor, 0n);
    findings.push({ agent: "anomaly", kind: "finding", conflictKey: `fees:${currency}`, title: `${items.length} fees and charges: ${formatMoney(total, currency, locale)} in 90 days`,
      detail: "Descriptions mention fees, interest or ATM charges. Some may be avoidable by changing account plan or payment method.",
      evidence: { facts: [{ label: "Total", value: formatMoney(total, currency, locale) }, { label: "Count", value: String(items.length) }, { label: "Since", value: since }],
        transactions: items.slice(0, 8).map(evidenceRow), links: [{ label: "Search fees", href: "/money/transactions?q=fee" }] },
      payload: { severity: "medium", transactionIds: items.slice(0, 50).map(row => row.id) }, confidence: 75, notes: [] });
  }
  const recentFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 45 * 86_400_000).toISOString().slice(0, 10);
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

// ── Toolsmith ────────────────────────────────────────────────────────────────
export function toolProposals(proposals: Proposal[], hasIncome: boolean, currency: string, locale?: string): Proposal<"tool">[] {
  const recurring = proposals.filter(item => item.kind === "recurring");
  const budgets = proposals.filter((item): item is Proposal<"budget"> => item.kind === "budget" && item.payload.currencyCode === currency);
  const tools: Proposal<"tool">[] = [];
  if (recurring.length >= 2) tools.push({ agent: "toolsmith", kind: "tool", conflictKey: "tool:subscription-audit", title: "Subscription audit",
    detail: `A saved report of merchants that charge you month after month, built because the Recurring detective found ${recurring.length} candidates.`,
    evidence: { facts: [{ label: "Recurring candidates", value: String(recurring.length) }], transactions: [], links: [{ label: "Library", href: "/ai/library" }] },
    payload: { template: "subscription-audit", name: "Subscription audit", params: { minMonths: 2 } }, confidence: 70, notes: [] });
  if (budgets.length) {
    const total = budgets.reduce((sum, item) => sum + BigInt(item.payload.limitMinor), 0n);
    if (total <= 100_000_000_000n) tools.push({ agent: "toolsmith", kind: "tool", conflictKey: "tool:budget-tracker", title: `Budget tracker preset to ${formatMoney(total, currency, locale)}`,
      detail: `Tracks this month against the sum of the Budget coach's ${budgets.length} proposed limits.`,
      evidence: { facts: [{ label: "Monthly budget", value: formatMoney(total, currency, locale) }], transactions: [], links: [{ label: "Library", href: "/ai/library" }] },
      payload: { template: "budget-tracker", name: "Agent budget tracker", params: { monthlyBudgetMinor: Number(total) } }, confidence: 65, notes: [] });
  }
  if (hasIncome) tools.push({ agent: "toolsmith", kind: "tool", conflictKey: "tool:savings-rate", title: "Savings-rate dashboard",
    detail: "This month's savings rate from real income and spending, with the spending limit that reaches a 20% target.",
    evidence: { facts: [{ label: "Target", value: "20%" }], transactions: [], links: [{ label: "Library", href: "/ai/library" }] },
    payload: { template: "savings-rate", name: "Savings rate", params: { targetRatePercent: 20 } }, confidence: 60, notes: [] });
  return tools;
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
    if (item.kind === "budget") {
      const { categoryId } = (item as Proposal<"budget">).payload;
      const incoming = proposals.filter(other => other.kind === "categorize" && (other as Proposal<"categorize">).payload.patch.category_id === categoryId)
        .reduce((sum, other) => sum + (other as Proposal<"categorize">).payload.rows.length, 0);
      if (incoming) {
        item.notes.push(`${incoming} rows proposed for this category are not in this history yet; revisit the limit after accepting them`);
        item.confidence = Math.max(1, item.confidence - 15);
        resolutions.push(`Lowered confidence of “${item.title}” until the Categorizer's ${incoming} rows are decided`);
      }
    }
  }
  const order: ProposalKind[] = ["finding", "categorize", "recurring", "budget", "tool"];
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
