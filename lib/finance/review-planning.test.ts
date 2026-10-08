import {expect, it, vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {loadReviewGoals} from "./review-planning";
import {toolResultReceipt} from "./tool-evidence";

const workspaceId = "11111111-1111-4111-8111-111111111111";
it("does not label undated manual savings as a current recorded snapshot", async () => {
  const goal = {id: workspaceId, name: "Synthetic", currency_code: "EUR", target_minor: "9007199254740993", recorded_saved_minor: "25", saved_as_of: null};
  const query = {select: () => query, eq: vi.fn(() => query), order: () => query, limit: vi.fn(() => query), in: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({data: [goal], error: null}).then(resolve)};
  const input = {goalIds: [workspaceId], limit: 1};
  const result = await loadReviewGoals(input, {from: () => query} as unknown as SupabaseClient, workspaceId);
  const receipt = toolResultReceipt("goals_review", input, result, {workspaceId, timezone: "UTC", fetchedAt: "2026-10-07T00:00:00Z"}, ["planning"]);
  expect(receipt.metrics.some(metric => metric.id.endsWith("recorded_saved_minor") && metric.valueMinor !== null)).toBe(false);
  expect(receipt.limitations?.some(limit => limit.kind === "missing_input")).toBe(true);
  expect(query.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
  expect(query.in).toHaveBeenCalledWith("id", [workspaceId]);
  expect(query.limit).toHaveBeenCalledWith(2);
});
