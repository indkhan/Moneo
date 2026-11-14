import { APICallError } from "ai";

// Work for the AI organizer: batches sized by tokens, run with parallelism that adapts to the provider.

/** A rough token count for what is sent: about four characters a token. */
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

/** Greedy batches that stay under a token budget and an item cap; an item bigger than the budget goes alone. */
export function tokenBatches<T>(items: T[], tokens: (item: T) => number, budget: number, maxItems: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [], used = 0;
  for (const item of items) {
    const size = tokens(item);
    if (current.length && (used + size > budget || current.length >= maxItems)) { batches.push(current); current = []; used = 0; }
    current.push(item); used += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Ends the whole run's AI work (plan limit, spent budget, a stopped run); what is left waits for the next run. */
export class StopWork extends Error {}

/**
 * "stop" for limits that won't lift within this run (the ChatGPT plan's usage limit, an API key out of quota),
 * "retry" for a temporary throttle, "fail" for anything else.
 */
export function modelFailure(error: unknown): "stop" | "retry" | "fail" {
  if (error instanceof StopWork) return "stop";
  if (APICallError.isInstance(error) && error.statusCode === 429)
    return /usage_limit|usage limit|insufficient_quota|plan limit/i.test(`${error.message} ${error.responseBody ?? ""}`) ? "stop" : "retry";
  return "fail";
}

export type AdaptiveResult<T, R> = { done: { job: T; result: R }[]; left: T[]; failed: { job: T; error: unknown }[]; stopped: unknown; peak: number };
export type AdaptiveOptions = { start?: number; max?: number; retries?: number; backoffMs?: number; classify?: (error: unknown) => "stop" | "retry" | "fail" };

/**
 * Runs jobs with `start` at once, one more after each success up to `max`, half as many after a throttle (which is
 * retried after a growing pause, `retries` times, then left for the next run). A "stop" lets running jobs finish
 * and leaves the rest.
 */
export function runAdaptive<T, R>(jobs: T[], work: (job: T) => Promise<R>, options: AdaptiveOptions = {}): Promise<AdaptiveResult<T, R>> {
  const { start = 2, max = 6, retries = 3, backoffMs = 2000, classify = modelFailure } = options;
  const queue = jobs.map(job => ({ job, attempts: 0 }));
  const result: AdaptiveResult<T, R> = { done: [], left: [], failed: [], stopped: null, peak: 0 };
  let limit = Math.max(1, start), active = 0, stopping = false;
  return new Promise(resolve => {
    const pump = () => {
      if (stopping) result.left.push(...queue.splice(0).map(entry => entry.job));
      while (!stopping && active < limit && queue.length) {
        const entry = queue.shift()!;
        active++;
        result.peak = Math.max(result.peak, active);
        work(entry.job).then(value => {
          result.done.push({ job: entry.job, result: value });
          limit = Math.min(max, limit + 1);
        }, async error => {
          const kind = classify(error);
          if (kind === "stop") { stopping = true; result.stopped ??= error; result.left.push(entry.job); return; }
          if (kind === "retry") {
            limit = Math.max(1, Math.floor(limit / 2));
            if (entry.attempts >= retries) { result.left.push(entry.job); return; }
            entry.attempts++;
            await new Promise(wake => setTimeout(wake, backoffMs * entry.attempts));
            queue.unshift(entry);
            return;
          }
          result.failed.push({ job: entry.job, error });
        }).finally(() => { active--; pump(); });
      }
      if (!active && !queue.length) resolve(result);
    };
    pump();
  });
}
