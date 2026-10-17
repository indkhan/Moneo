import { describe, expect, it } from "vitest";
import { organizationProposals } from "@/lib/import/organization";
import { detectRecurring } from "@/lib/finance/recurring";
import { anomalyFindings, budgetProposals, categorizeGroups, deterministicBriefing, mergeProposals, payloadSchemas, planRun, recurringProposals, toolProposals, verifiedBriefing, type LedgerRow, type Proposal } from "./team";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = id(900);
const row = (n: number, date: string, description: string, amountMinor: bigint, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  id: id(n), version: 1, date, description, amountMinor, currency: "EUR", accountId: account, categoryId: null, merchantId: null, kind: "ordinary", status: "posted", reviewReasons: [], ...extra });
const organizationRow = (item: LedgerRow) => ({ id: item.id, version: item.version, description: item.description, merchantId: item.merchantId, categoryId: item.categoryId,
  kind: item.kind as "ordinary", reviewReasons: item.reviewReasons, userCorrected: false });

describe("lead plan", () => {
  it("runs agents in waves and explains every skip", () => {
    const plan = planRun({ transactions: 120, unorganized: 0, months: 1, scopes: ["accounts", "transactions"] });
    expect(plan.find(task => task.agent === "categorizer")).toMatchObject({ status: "skipped", reason: expect.stringContaining("already") });
    expect(plan.find(task => task.agent === "recurring")).toMatchObject({ status: "skipped", reason: expect.stringContaining("two months") });
    expect(plan.find(task => task.agent === "forecaster")).toMatchObject({ status: "skipped", reason: "Allow AI access to planning in Settings" });
    expect(plan.find(task => task.agent === "anomaly")).toMatchObject({ status: "pending", wave: 0 });
    expect(plan.find(task => task.agent === "writer")).toMatchObject({ status: "pending", wave: 2 });
  });
  it("skips everything except writing when there is no data", () => {
    expect(planRun({ transactions: 0, unorganized: 0, months: 0, scopes: ["accounts", "transactions", "planning", "imports"] })
      .every(task => task.status === "skipped")).toBe(true);
  });
});

describe("categorizer", () => {
  it("groups consistent history into one rule-learning change per description", () => {
    const history = [1, 2, 3].map(n => row(n, `2026-0${n}-03`, `CARD PAYMENT NORTHSTAR MARKET REF:${n}`, -1200n, { merchantId: id(50), categoryId: id(60) }));
    const fresh = [4, 5].map(n => row(n, `2026-09-0${n}`, `CARD PAYMENT NORTHSTAR MARKET REF:9${n}`, -1500n));
    const proposals = organizationProposals(fresh.map(organizationRow), history.map(organizationRow), []);
    const groups = categorizeGroups(proposals, new Map(fresh.map(item => [item.id, item])), { categories: new Map([[id(60), "Groceries"]]), merchants: new Map([[id(50), "Northstar"]]) });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "categorize", title: expect.stringContaining("Groceries"), confidence: 85,
      payload: { rows: [{ id: id(4), version: 1 }, { id: id(5), version: 1 }], patch: { merchant_id: id(50), category_id: id(60) }, merchantName: null, ruleKey: "northstar market" } });
    expect(payloadSchemas.categorize.parse(groups[0].payload)).toEqual(groups[0].payload);
  });
  it("proposes a new merchant only for repeated descriptions, never for one-offs or financial reviews", () => {
    const rows = [row(1, "2026-09-01", "STREAMFLIX", -999n), row(2, "2026-10-01", "STREAMFLIX", -999n), row(3, "2026-10-02", "ONE OFF SHOP", -500n),
      row(4, "2026-10-03", "MYSTERY", -100n, { reviewReasons: ["kind:unrecognized"] }), row(5, "2026-10-04", "MYSTERY", -100n, { reviewReasons: ["kind:unrecognized"] })];
    const groups = categorizeGroups(organizationProposals(rows.map(organizationRow), [], []), new Map(rows.map(item => [item.id, item])), { categories: new Map(), merchants: new Map() });
    expect(groups.map(group => group.payload.merchantName)).toEqual(["Streamflix"]);
    expect(groups[0].payload.patch).toEqual({});
  });
});

describe("recurring detective", () => {
  const months = ["2026-05-02", "2026-06-02", "2026-07-02", "2026-08-02", "2026-09-02"];
  const rows = months.map((date, n) => row(n + 1, date, "STREAMFLIX", n === 4 ? -1099n : -999n));
  const series = detectRecurring(rows.map(item => ({ id: item.id, date: item.date, description: item.description, amountMinor: item.amountMinor, currencyCode: "EUR", accountId: account })));
  it("proposes unreviewed series with versioned evidence and flags price increases", () => {
    const { proposals, findings } = recurringProposals(series, [], new Map(rows.map(item => [item.id, item])));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload).toMatchObject({ cadence: "monthly", currencyCode: "EUR", accountId: account });
    expect(proposals[0].payload.evidence).toHaveLength(5);
    expect(findings[0]).toMatchObject({ conflictKey: expect.stringMatching(/^price:/), title: "STREAMFLIX went up 10.0%" });
  });
  it("does not re-propose series the user already reviewed", () => {
    const stored = [{ accountId: account, currencyCode: "EUR", cadence: "monthly", transactionIds: [id(1)] }];
    expect(recurringProposals(series, stored, new Map(rows.map(item => [item.id, item]))).proposals).toEqual([]);
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
    expect(proposals.find(item => item.kind === "budget")).toMatchObject({ confidence: 60, notes: [expect.stringContaining("2 rows")] });
    expect(resolutions.length).toBeGreaterThanOrEqual(4);
    expect(proposals.map(item => item.kind)).toEqual(["finding", "finding", "categorize", "recurring", "budget"]);
  });
  it("toolsmith tailors tools to what the other agents found", () => {
    const tools = toolProposals([recurring, { ...recurring, conflictKey: "recurring:y" }, budget], true, "EUR");
    expect(tools.map(tool => tool.payload.template)).toEqual(["subscription-audit", "budget-tracker", "savings-rate"]);
    expect(tools[1].payload.params).toEqual({ monthlyBudgetMinor: 21000 });
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
