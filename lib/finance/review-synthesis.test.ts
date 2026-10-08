import {expect, it, vi} from "vitest";
import {synthesizeReview} from "./review-synthesis";
import {resolveReviewRequest} from "./review-request";
import type {ReviewProgress} from "./review-controller";

function progress(): ReviewProgress {
  return {version: 1, request: resolveReviewRequest({version: 1, question: "Explain September", budget: {maxDurationMs: 5000, maxOutputTokens: 256}}, "2026-10-07"),
    startedAt: 1000, supportRecords: 0, queries: [], limitations: []};
}
it("reserves the single model attempt before transport and never repeats it after a durable retry", async () => {
  const original = progress();
  let saved = original;
  const reserve = vi.fn(async (value: ReviewProgress) => {saved = structuredClone(value); return true;});
  const generate = vi.fn(async () => {expect(saved.synthesisAttempted).toBe(true); throw new Error("Transport failed");});
  const dependencies = {reserve, generate, now: () => 3000};
  await expect(synthesizeReview(original, {system: "strict", prompt: "dated"}, dependencies)).rejects.toThrow("Transport failed");
  const resumed = await synthesizeReview(saved, {system: "strict", prompt: "dated"}, dependencies);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(resumed).toMatchObject({text: null, limitation: expect.stringContaining("already spent")});
});
it("uses the remaining durable deadline and exact output cap, and withholds expired or oversized input", async () => {
  const generate = vi.fn(async () => ({text: "supported", finishReason: "stop"}));
  const reserve = vi.fn(async () => true);
  await synthesizeReview(progress(), {system: "strict", prompt: "dated"}, {reserve, generate, now: () => 3000});
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({maxOutputTokens: 256, maxRetries: 0, abortSignal: expect.any(AbortSignal)}));
  expect(await synthesizeReview(progress(), null, {reserve, generate, now: () => 3000})).toMatchObject({text: null});
  expect(await synthesizeReview(progress(), {system: "strict", prompt: "dated"}, {reserve, generate, now: () => 6001})).toMatchObject({text: null, limitation: expect.stringContaining("time budget")});
  expect(generate).toHaveBeenCalledTimes(1);
});
it("starts only one model transport when concurrent durable invocations read the same unspent progress", async () => {
  const generate = vi.fn(async () => ({text: "supported"}));
  let spent = false;
  const reserve = vi.fn(async () => {if (spent) return false; spent = true; return true;});
  const dependencies = {reserve, generate, now: () => 3000};
  const results = await Promise.all([synthesizeReview(progress(), {system: "strict", prompt: "dated"}, dependencies), synthesizeReview(progress(), {system: "strict", prompt: "dated"}, dependencies)]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(results.filter(result => result.text === null)).toHaveLength(1);
});
