import {test, expect, type APIRequestContext, type BrowserContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {resolveReviewRequest} from "../lib/finance/review-request";

const boundary = "http://127.0.0.1:3041";
async function fixture(request: APIRequestContext, browser: BrowserContext, mode = "normal") {
  const id = randomUUID(), workspace = randomUUID(), account = randomUUID(), merchant = randomUUID();
  const ledger = [
    {id: randomUUID(), posted_on: "2026-08-05", merchant_id: merchant, amount_minor: "-9007199254740993"},
    {id: randomUUID(), posted_on: "2026-09-05", merchant_id: null, amount_minor: "-25"},
  ].map(row => ({...row, parent_transaction_id: row.id, account_id: account, currency_code: "EUR", status: "posted", kind: "ordinary", category_id: null,
    review_reasons: [], tags: [], event_name: null, version: 1, description: "Synthetic owned acceptance", refund_of_id: null}));
  expect((await request.post(`${boundary}/fixture`, {data: {id, workspace, mode, ledger, accounts: [{id: account, name: "Synthetic account"}],
    merchants: [{id: merchant, name: "Large decline"}], goals: [{id: randomUUID(), name: "Synthetic goal", currency_code: "EUR", target_minor: "10000", recorded_saved_minor: "25", saved_as_of: "2026-09-01", status: "active"}]}})).ok()).toBe(true);
  await browser.addCookies([{name: "qa-workspace", value: workspace, url: "http://localhost:3040"}]);
  const specification = resolveReviewRequest({version: 1, question: "Explain September spending and its largest declines", focus: "Declines", query: {
    version: 1, period: {from: "2026-09-01", to: "2026-09-30"}, comparison: {from: "2026-08-01", to: "2026-08-31"}, accounts: {include: [{id: account}]}, groupBy: ["merchant"]},
    budget: {maxQueries: 3, maxSupportRecords: 10, maxOutputTokens: 256, ...(mode === "deadline-followup" ? {maxDurationMs: 5000} : {})}}, "2026-10-07");
  const state = async () => (await (await request.get(`${boundary}/fixture/${id}`)).json());
  const remove = async () => {expect((await (await request.delete(`${boundary}/fixture/${id}`)).json()).removed).toBe(true);};
  return {id, workspace, account, ledger, specification, state, remove, headers: {cookie: `qa-workspace=${workspace}`}};
}

test("actual analysis form dispatches selected dates/planning and reloads retained progress", async ({page, request, context}) => {
  const owned = await fixture(request, context);
  try {
    await page.goto("/");
    await page.getByLabel("What would you like to investigate?").fill("Review September and the recorded goal");
    await page.getByLabel("Focus (optional)").fill("Subscriptions and savings");
    await page.locator('[name="from"]').fill("2026-09-01");
    await page.locator('[name="to"]').fill("2026-09-30");
    await page.locator('[name="comparisonFrom"]').fill("2026-08-01");
    await page.locator('[name="comparisonTo"]').fill("2026-08-31");
    await page.getByLabel("Planning evidence (optional)").selectOption("goals");
    await page.getByRole("button", {name: "Run review", exact: true}).click();
    await expect.poll(async () => (await owned.state()).status, {timeout: 90_000}).toBe("completed");
    const saved = await owned.state();
    expect(saved.review_request).toMatchObject({question: "Review September and the recorded goal", focus: "Subscriptions and savings", output: "answer", planningViews: [{view: "goals"}], query: {period: owned.specification.query.period, comparison: owned.specification.query.comparison}});
    expect(saved.analysis.evidence.planning.retainedViews).toEqual([{view: "goals"}]);
    expect(saved.review_progress.queries.some((query: {query: {page: {groupKey?: string}}}) => query.query.page.groupKey)).toBe(true);
    expect(saved.ledger).toEqual(owned.ledger);
    expect(saved.saves).toBe(1);
    await page.reload();
    await expect(page.getByText(/Evidence checks \d\/6/)).toBeVisible();
    const result = await request.get(`/api/analysis/${owned.id}`, {headers: owned.headers});
    expect((await result.json()).analysis.freshness.status).toBe("current");
    await request.patch(`${boundary}/fixture/${owned.id}`, {data: {ledger: owned.ledger.map((row, index) => index ? {...row, amount_minor: "-26", version: 2} : row)}});
    const changed = await (await request.get(`/api/analysis/${owned.id}`, {headers: owned.headers})).json();
    expect(changed.analysis.freshness.status).toBe("stale");
    expect(changed.analysis.body).toBe(saved.analysis.body);
  } finally {await owned.remove();}
});

for (const mode of ["checkpoint-lost-once", "followup-unavailable", "deadline-followup"]) {
  test(`actual bounded workflow preserves scope, partial evidence and spent budgets: ${mode}`, async ({request, context}) => {
    const owned = await fixture(request, context, mode);
    try {
      const input = {requestId: randomUUID(), investigation: owned.specification};
      const started = await request.post("/api/analysis", {data: input, headers: owned.headers});
      expect(started.status()).toBe(202);
      await expect.poll(async () => (await owned.state()).status, {timeout: 90_000}).toBe("completed");
      expect((await request.post("/api/analysis", {data: input, headers: owned.headers})).status()).toBe(202);
      const saved = await owned.state();
      expect(saved.review_request).toMatchObject(owned.specification);
      expect(saved.review_progress.queries.length).toBeLessThanOrEqual(3);
      expect(saved.review_progress.supportRecords).toBeLessThanOrEqual(10);
      expect(saved.saves).toBe(1); expect(saved.runs).toHaveLength(1);
      expect(saved.ledger).toEqual(owned.ledger);
      expect(saved.analysis.body).toContain("Large decline");
      expect(saved.analysis.body).toContain("Evidence trail");
      if (mode === "checkpoint-lost-once") expect(saved.lostCheckpoint).toBe(true);
      if (mode === "followup-unavailable") expect(saved.review_progress.queries.some((query: {status: string}) => query.status === "unavailable")).toBe(true);
      if (mode === "deadline-followup") {expect(saved.attempts.provider).toBe(0); expect(saved.readAborted).toBe(true); expect(saved.analysis.body).toContain("time budget");}
      else expect(saved.attempts.provider).toBe(1);
    } finally {await owned.remove();}
  });
}

test("owned Stop aborts the actual synthesis transport and prevents publication", async ({page, request, context}) => {
  const owned = await fixture(request, context, "provider-waits");
  try {
    expect((await request.post("/api/analysis", {data: {requestId: randomUUID(), investigation: owned.specification}, headers: owned.headers})).status()).toBe(202);
    await expect.poll(async () => (await owned.state()).attempts.provider, {timeout: 90_000}).toBe(1);
    await page.goto("/");
    await page.getByRole("button", {name: "Stop", exact: true}).click();
    await expect.poll(async () => (await owned.state()).status, {timeout: 30_000}).toBe("canceled");
    const canceled = await owned.state();
    expect(canceled.providerAborted).toBe(true); expect(canceled.saves).toBe(0);
    expect(canceled.ledger).toEqual(owned.ledger);
    await page.reload();
    await expect(page.getByText("Application work stopped.", {exact: false})).toBeVisible();
  } finally {await owned.remove();}
});

test("support exhaustion is retained and discloses requested planning left unexplored", async ({request, context}) => {
  const owned = await fixture(request, context);
  try {
    const investigation = {...owned.specification, includePlanning: true, planningViews: [{view: "goals"}], budget: {...owned.specification.budget, maxSupportRecords: 1}};
    expect((await request.post("/api/analysis", {data: {requestId: randomUUID(), investigation}, headers: owned.headers})).status()).toBe(202);
    await expect.poll(async () => (await owned.state()).status, {timeout: 90_000}).toBe("completed");
    const saved = await owned.state();
    expect(saved.review_progress.supportRecords).toBe(1);
    expect(saved.review_progress.queries).toHaveLength(1);
    expect(saved.analysis.body).toContain("Requested planning views remain unexplored");
    expect(saved.ledger).toEqual(owned.ledger);
    expect(saved.attempts.provider).toBe(1);
  } finally {await owned.remove();}
});
