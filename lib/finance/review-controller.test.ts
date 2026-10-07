import {describe, expect, it, vi} from "vitest";
import {investigate, type InvestigationRow} from "./investigation";
import {resolveReviewRequest} from "./review-request";
import {runReviewInvestigation} from "./review-controller";

const request = (budget = {}) => resolveReviewRequest({version: 1, question: "Explain September spending changes", query: {version: 1, period: {from: "2026-09-01", to: "2026-09-30"}, comparison: {from: "2026-08-01", to: "2026-08-31"}, groupBy: ["merchant"]}, budget}, "2026-10-07");
const context = {workspaceId: "11111111-1111-4111-8111-111111111111", capturedAt: "2026-10-07T12:00:00Z"};
function row(id: string, merchantId: string, amountMinor: string, date: string, currency = "EUR"): InvestigationRow {
  return {id, parentId: id, merchantId, accountId: "account", categoryId: null, amountMinor, date, currency, status: "posted", kind: "ordinary", tags: [], event: null, reviewReasons: [], version: 1, description: "synthetic"};
}
const rows = [row("decline", "decline", "-9007199254740993", "2026-08-03"), row("steady", "steady", "-9007199254740994", "2026-09-03"), row("steady-old", "steady", "-9007199254740994", "2026-08-03"), row("usd", "usd", "-20", "2026-09-03", "USD")];
const read = vi.fn(async (query, signal: AbortSignal) => {
  signal.throwIfAborted();
  return {result: investigate(query, rows, context), receiptId: `receipt-${read.mock.calls.length}`};
});

describe("bounded read-only investigation controller", () => {
  it("drills into the largest exact decline and gives each currency a turn without comparing their units", async () => {
    read.mockClear();
    const progress = await runReviewInvestigation(request({maxQueries: 3}), {read});
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[1][0].page.groupKey).toContain("decline");
    expect(read.mock.calls[2][0].page.groupKey).toContain("USD");
    expect(progress.queries[0].result?.groups.find(group => group.key.includes("decline"))?.deltaMinor).toBe("-9007199254740993");
    expect(progress.request.question).toBe("Explain September spending changes");
    expect(progress.limitations.join(" ")).toContain("Causal explanations are unproven");
  });
  it("checkpoints each query before reading, bounds support, and never repeats completed queries on resume", async () => {
    read.mockClear();
    const saved: number[] = [];
    const progress = await runReviewInvestigation(request({maxQueries: 2, maxSupportRecords: 2}), {read, checkpoint: async value => {saved.push(value.queries.length);}});
    expect(saved[0]).toBe(1);
    expect(progress.supportRecords).toBeLessThanOrEqual(2);
    expect(read.mock.calls[0][0].page.size).toBe(2);
    const count = read.mock.calls.length;
    const resumed = await runReviewInvestigation(progress.request, {read}, progress);
    expect(read.mock.calls.length).toBe(count);
    expect(resumed.queries).toEqual(progress.queries);
  });
  it("retains supported sections when a follow-up fails and counts failures against the budget", async () => {
    let calls = 0;
    const progress = await runReviewInvestigation(request({maxQueries: 2}), {read: async (query) => {
      if (++calls > 1) throw new Error("Unavailable evidence");
      return {result: investigate(query, rows, context), receiptId: "retained"};
    }});
    expect(progress.queries.map(query => query.status)).toEqual(["completed", "unavailable"]);
    expect(progress.queries[0].receiptId).toBe("retained");
    expect(progress.limitations.join(" ")).toContain("unavailable");
  });
  it("a durable elapsed deadline prevents further reads and cancellation reaches the active transport", async () => {
    const old = await runReviewInvestigation(request({maxQueries: 1}), {read});
    const reader = vi.fn();
    await runReviewInvestigation(old.request, {read: reader, now: () => old.startedAt + 100000}, old);
    expect(reader).not.toHaveBeenCalled();
    const stop = new AbortController();
    let settled = false;
    let started!: () => void;
    const entered = new Promise<void>(resolve => {started = resolve;});
    const running = runReviewInvestigation(request(), {signal: stop.signal, read: async (_query, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {settled = true; reject(signal.reason);}, {once: true}));
      throw new Error("unreachable");
    }});
    await entered;
    stop.abort(new Error("Stop"));
    await expect(running).rejects.toThrow("Stop");
    expect(settled).toBe(true);
  });
  it("rejects resume under a different question or budget and discloses mixed snapshots", async () => {
    const original = await runReviewInvestigation(request({maxQueries: 1}), {read});
    await expect(runReviewInvestigation({...original.request, question: "Different"}, {read}, original)).rejects.toThrow("request");
    let calls = 0;
    const progress = await runReviewInvestigation(request({maxQueries: 2}), {read: async query => ({result: {...investigate(query, rows, context), evidenceId: String(++calls)}, receiptId: String(calls)})});
    expect(progress.limitations.join(" ")).toContain("changed between reads");
  });
});
