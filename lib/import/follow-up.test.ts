import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dispatchFinancialReview } from "@/lib/finance/start-review";
import { FIRST_REVIEW_DEADLINE_MS, maybeStartFirstReview } from "./follow-up";

const eligibility = vi.hoisted(() => ({ settingsFail: false, modelFail: false, scopesDenied: false }));
vi.mock("@/lib/settings", () => ({ loadWorkspaceSettings: async () => { if (eligibility.settingsFail) throw new Error("settings unavailable"); return {}; }, requireAiScope: () => { if (eligibility.scopesDenied) throw new Error("scopes denied"); } }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => { if (eligibility.modelFail) throw new Error("model catalogue unavailable"); return {}; } }));
vi.mock("@/lib/finance/start-review", () => ({ dispatchFinancialReview: vi.fn() }));
vi.mock("@/lib/ai/agent-dispatch", () => ({ startAgentRun: vi.fn(async () => null) }));

const landed = Date.parse("2026-11-14T08:00:00Z");
// What the review waits for: the first rows, a finished agent pass, and every bank's history (accounts still without one).
const state = vi.hoisted(() => ({ job: null as { status: string } | null, pass: true, waitingAccounts: 0 }));
const db = { from: (table: string) => {
  const data = () => table === "background_jobs" ? state.job : table === "imports" ? { created_at: new Date(landed).toISOString() }
    : table === "agent_runs" ? (state.pass ? { id: "run" } : null) : Array.from({ length: state.waitingAccounts }, () => ({ connection_id: "c2" }));
  const q = { select: () => q, eq: () => q, gt: () => q, is: () => q, order: () => q, limit: () => q, upsert: () => q,
    maybeSingle: async () => ({ data: data(), error: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: data(), error: null }).then(resolve) };
  return q;
} } as never;
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic");
  vi.clearAllMocks();
  Object.assign(eligibility, { settingsFail: false, modelFail: false, scopesDenied: false });
  Object.assign(state, { job: null, pass: true, waitingAccounts: 0 });
});
afterEach(() => { vi.unstubAllEnvs(); });

// The first review ran after the first bank's rows, before the other banks or the organizer had finished.
it("waits for every bank's history and a finished pass, or 24 hours after the first rows", async () => {
  state.waitingAccounts = 1;
  await maybeStartFirstReview(db, "workspace", landed + 60_000);
  Object.assign(state, { waitingAccounts: 0, pass: false });
  await maybeStartFirstReview(db, "workspace", landed + 60_000);
  expect(dispatchFinancialReview).not.toHaveBeenCalled();
  state.waitingAccounts = 1;
  await maybeStartFirstReview(db, "workspace", landed + FIRST_REVIEW_DEADLINE_MS);
  expect(dispatchFinancialReview).toHaveBeenCalledOnce();
  Object.assign(state, { waitingAccounts: 0, pass: true });
  await maybeStartFirstReview(db, "workspace", landed + 60_000);
  expect(dispatchFinancialReview).toHaveBeenCalledTimes(2);
  state.job = { status: "completed" };
  await maybeStartFirstReview(db, "workspace", landed + 60_000);
  expect(dispatchFinancialReview).toHaveBeenCalledTimes(2);
});
it("dispatches a retained first-review claim when an earlier attempt lost its enqueue response", async () => {
  Object.assign(state, { job: { status: "queued" }, pass: false, waitingAccounts: 1 });
  await maybeStartFirstReview(db, "workspace", landed);
  expect(dispatchFinancialReview).toHaveBeenCalledWith(db, expect.any(String), "workspace", false);
});
it.each(["settings", "model"])("lets transient %s eligibility failures retry instead of skipping the review", async stage => {
  eligibility.settingsFail = stage === "settings"; eligibility.modelFail = stage === "model";
  await expect(maybeStartFirstReview(db, "workspace", landed)).rejects.toThrow("unavailable");
  expect(dispatchFinancialReview).not.toHaveBeenCalled();
});
it("skips optional review when current financial evidence scopes are denied", async () => {
  eligibility.scopesDenied = true;
  await maybeStartFirstReview(db, "workspace", landed);
  expect(dispatchFinancialReview).not.toHaveBeenCalled();
});
it("lets durable dispatch retry instead of swallowing an ambiguous enqueue failure", async () => {
  vi.mocked(dispatchFinancialReview).mockRejectedValueOnce(new Error("lost enqueue response"));
  await expect(maybeStartFirstReview(db, "workspace", landed)).rejects.toThrow("lost enqueue response");
});
