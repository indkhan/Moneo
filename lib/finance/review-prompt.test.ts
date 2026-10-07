import {expect, it} from "vitest";
import {createEvidenceReceipt} from "./evidence-receipts";
import {resolveReviewRequest} from "./review-request";
import {buildReviewPrompt} from "./review-prompt";

const request = resolveReviewRequest({version: 1, question: "Explain September subscriptions", focus: "Subscriptions"}, "2026-10-07");
const receipt = createEvidenceReceipt({workspaceId: "11111111-1111-4111-8111-111111111111", fetchedAt: "2026-10-07T00:00:00Z", sourceVersion: "source", calculationVersion: "v1", scopes: ["transactions"], query: {kind: "synthetic"}, sources: [],
  metrics: Array.from({length: 200}, (_, id) => ({id: String(id), label: `Measure ${id}`, valueMinor: "9007199254740993", currency: "EUR", period: request.query.period, qualifiers: ["partial_coverage"], sourceIds: [], calculation: "Complete retained calculation ".repeat(50)}))});
it("bounds actual model input bytes while preserving exact referenced measures, question and limits", () => {
  const result = buildReviewPrompt(request, [receipt], ["Some supporting evidence was unavailable"], "strict claim instructions");
  expect(result).not.toBeNull();
  expect(Buffer.byteLength(result!.prompt) + Buffer.byteLength(result!.system)).toBeLessThanOrEqual(32000);
  const context = JSON.parse(result!.prompt);
  expect(context.question).toBe(request.question);
  expect(context.focus).toBe(request.focus);
  expect(context.query).toEqual(request.query);
  expect(context.evidenceReceipts[0].metrics[0]).toMatchObject({valueMinor: "9007199254740993", currency: "EUR", qualifiers: ["partial_coverage"], period: request.query.period});
  expect(context.evidenceReceipts[0].metrics[0]).not.toHaveProperty("sourceIds");
  expect(context.evidenceReceipts[0].metrics[0]).not.toHaveProperty("calculation");
  expect(context.limitations).toContain("Some supporting evidence was unavailable");
  expect(result!.omittedMetrics).toBeGreaterThan(0);
  expect(context.limitations.join(" ")).toContain("bounded");
});
it("withholds a model call if its instructions and exact question scope cannot fit", () => {
  expect(buildReviewPrompt(request, [receipt], [], "x".repeat(32000))).toBeNull();
});
it("does not silently change Unicode question bytes or unsupported money into approximate numbers", () => {
  const selected = {...request, question: "€".repeat(1000)};
  const result = buildReviewPrompt(selected, [receipt], [], "strict");
  expect(JSON.parse(result!.prompt).question).toBe(selected.question);
  expect(JSON.parse(result!.prompt).evidenceReceipts[0].metrics[0].valueMinor).toBe("9007199254740993");
});
