import { describe, expect, it } from "vitest";
import { anomalyFindings, backlogRerunNeeded, budgetProposals, deterministicBriefing, mergeProposals, planRun, verifiedBriefing, type LedgerRow, type Proposal } from "@/lib/ai/agent-team";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = id(900);
const row = (n: number, date: string, description: string, amountMinor: bigint, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  id: id(n), version: 1, date, description, amountMinor, currency: "EUR", accountId: account, categoryId: null, merchantId: null, kind: "ordinary", status: "posted", reviewReasons: [], ...extra });

describe("lead plan", () => {
  it("runs agents in waves and explains every skip", () => {
    const plan = planRun({ transactions: 120, unorganized: 0, months: 1, spendingLimits: 1, scopes: ["accounts", "transactions"] });
    expect(plan.find(task => task.agent === "categorizer")).toMatchObject({ status: "skipped", reason: expect.stringContaining("already") });
    expect(plan.find(task => task.agent === "recurring")).toMatchObject({ status: "skipped", reason: expect.stringContaining("two months") });
    expect(plan.find(task => task.agent === "forecaster")).toMatchObject({ status: "skipped", reason: "Allow AI access to planning in Settings" });
    expect(plan.find(task => task.agent === "anomaly")).toMatchObject({ status: "pending", wave: 1 });
    expect(plan.find(task => task.agent === "writer")).toMatchObject({ status: "pending", wave: 3 });
  });
  // The budget coach ran beside the categorizer and proposed limits from rows that were still uncategorized.
  it("categorizes alone before anyone reads categories, and coaches budgets only for owners who set limits", () => {
    const profile = { transactions: 400, unorganized: 417, months: 12, scopes: ["accounts", "transactions", "planning"] as const };
    const plan = planRun({ ...profile, scopes: [...profile.scopes], spendingLimits: 0 });
    expect(plan.filter(task => task.wave === 0).map(task => task.agent)).toEqual(["categorizer"]);
    expect(plan.find(task => task.agent === "categorizer")!.status).toBe("pending");
    expect(plan.find(task => task.agent === "budget")).toMatchObject({ status: "skipped", wave: 1 });
    expect(planRun({ ...profile, scopes: [...profile.scopes], spendingLimits: 2 }).find(task => task.agent === "budget")!.status).toBe("pending");
  });
  it("skips everything except writing when there is no data", () => {
    expect(planRun({ transactions: 0, unorganized: 0, months: 0, spendingLimits: 0, scopes: ["accounts", "transactions", "planning", "imports"] })
      .every(task => task.status === "skipped")).toBe(true);
  });
});

// 417 bank rows stayed uncategorized after a failed run: later syncs added nothing, so no run started again.
describe("backlog rerun", () => {
  const base = { transactionsAllowed: true, unorganized: 417, recentRuns: ["completed"], unorganizedSinceLatestRun: false };
  it.each([
    ["the latest run failed", { recentRuns: ["failed", "completed"] }, true],
    ["new rows arrived after the latest run", { unorganizedSinceLatestRun: true }, true],
    ["no run has looked yet", { recentRuns: [] }, true],
    ["a finished run already left these rows", {}, false],
    ["the owner stopped the latest run", { recentRuns: ["canceled"] }, false],
    ["a run is still going", { recentRuns: ["running"], unorganizedSinceLatestRun: true }, false],
    ["nothing lacks a category", { unorganized: 0, recentRuns: ["failed"] }, false],
    ["AI may not read transactions", { transactionsAllowed: false, recentRuns: ["failed"] }, false],
    ["three runs in a row failed", { recentRuns: ["failed", "failed", "failed"] }, false],
    ["three failures, then new rows", { recentRuns: ["failed", "failed", "failed"], unorganizedSinceLatestRun: true }, true],
  ])("%s", (_case, change, expected) => {
    expect(backlogRerunNeeded({ ...base, ...change })).toBe(expected);
  });
});

describe("anomaly hunter", () => {
  it("finds same-day duplicates, fees and outsized charges", () => {
    const base = Array.from({ length: 12 }, (_, n) => row(n + 1, `2026-08-${String(n + 1).padStart(2, "0")}`, `SHOP ${n}`, -2000n));
    const rows = [...base, row(20, "2026-10-01", "CAFE LUNA 4411", -450n), row(21, "2026-10-01", "CAFE LUNA 9912", -450n),
      row(22, "2026-10-05", "Monthly account fee", -500n), row(23, "2026-10-06", "LAPTOP STORE", -150000n)];
    const findings = anomalyFindings(rows, "2026-10-16");
    expect(findings.map(item => item.conflictKey)).toEqual(expect.arrayContaining([`duplicate:${id(20)}:${id(21)}`, "fees:EUR", `large:${id(23)}`]));
    expect(findings.find(item => item.conflictKey === "fees:EUR")!.evidence.facts[0].value).toBe("EUR 5.00");
  });
});

describe("budget coach", () => {
  it("proposes a rounded median limit from three complete months and skips existing plans", () => {
    const category = id(60);
    const rows = [row(1, "2026-07-10", "A", -21000n, { categoryId: category }), row(2, "2026-08-10", "B", -18050n, { categoryId: category }),
      row(3, "2026-09-10", "C", -25000n, { categoryId: category }), row(4, "2026-10-10", "current month ignored", -99999n, { categoryId: category })];
    const [proposal] = budgetProposals(rows, new Map([[category, "Dining"]]), [], "2026-10-16");
    expect(proposal.payload).toEqual({ categoryId: category, currencyCode: "EUR", limitMinor: "21000" });
    expect(proposal.evidence.facts.map(fact => fact.label)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(budgetProposals(rows, new Map(), [{ categoryId: category, currencyCode: "EUR" }], "2026-10-16")).toEqual([]);
  });
});

describe("lead merge", () => {
  const finding = (key: string, ids: string[], confidence = 50): Proposal => ({ agent: "anomaly", kind: "finding", conflictKey: key, title: key, detail: "", confidence, notes: [],
    evidence: { facts: [], transactions: [], links: [] }, payload: { severity: "low", transactionIds: ids } });
  const recurring: Proposal = { agent: "recurring", kind: "recurring", conflictKey: "recurring:x", title: "Gym", detail: "", confidence: 80, notes: [], evidence: { facts: [], transactions: [], links: [] },
    payload: { accountId: account, label: "Gym", cadence: "yearly", currencyCode: "EUR", evidence: [1, 2, 3].map(n => ({ id: id(n), version: 1 })), runAnchorId: id(1), evidenceLimited: false } };
  const categorize: Proposal = { agent: "categorizer", kind: "categorize", conflictKey: "categorize:x", title: "Dining", detail: "", confidence: 85, notes: [], evidence: { facts: [], transactions: [], links: [] },
    payload: { rows: [{ id: id(7), version: 1 }, { id: id(8), version: 1 }], patch: { category_id: id(60) }, merchantName: null, ruleKey: "cafe luna", evidence: [] } };
  const budget: Proposal = { agent: "budget", kind: "budget", conflictKey: "budget:x", title: "Dining limit", detail: "", confidence: 75, notes: [], evidence: { facts: [], transactions: [], links: [] },
    payload: { categoryId: id(60), currencyCode: "EUR", limitMinor: "21000" } };
  it("resolves conflicts between agents and keeps the strongest duplicate", () => {
    const { proposals, resolutions } = mergeProposals([finding(`large:${id(3)}`, [id(3)]), recurring, finding(`price:${id(1)}`, [id(2), id(3)]),
      finding(`duplicate:${id(7)}:${id(9)}`, [id(7), id(9)]), finding(`duplicate:${id(7)}:${id(9)}`, [id(7), id(9)], 90), categorize, budget]);
    expect(proposals.some(item => item.conflictKey === `large:${id(3)}`)).toBe(false);
    expect(proposals.filter(item => item.conflictKey.startsWith("duplicate:"))).toHaveLength(1);
    expect(proposals.find(item => item.conflictKey.startsWith("duplicate:"))!.confidence).toBe(90);
    expect(proposals.find(item => item.kind === "recurring")!.notes).toEqual([`Anomaly check: price:${id(1)}`]);
    expect(proposals.find(item => item.kind === "categorize")!.notes[0]).toContain("1 possible duplicate");
    expect(resolutions.length).toBeGreaterThanOrEqual(3);
    expect(proposals.map(item => item.kind)).toEqual(["finding", "finding", "categorize", "recurring", "budget"]);
  });
});

describe("insight writer", () => {
  const facts = { headline: ["Analysed 120 transactions."], findings: ["fees cost EUR 5.00"], actions: ["3 categorizations"] };
  it("falls back to a deterministic briefing and rejects unverified numbers", () => {
    expect(deterministicBriefing(facts)).toContain("Analysed 120 transactions.");
    expect(verifiedBriefing("You paid EUR 5.00 in fees across 120 transactions.", facts)).not.toBeNull();
    expect(verifiedBriefing("You could save EUR 40.00 a month.", facts)).toBeNull();
  });
});
