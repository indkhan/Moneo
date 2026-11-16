import { APICallError } from "ai";

export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

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

export class StopWork extends Error {}

export function modelFailure(error: unknown): "stop" | "retry" | "fail" {
  if (error instanceof StopWork) return "stop";
  if (APICallError.isInstance(error) && error.statusCode === 429)
    return /usage_limit|usage limit|insufficient_quota|plan limit/i.test(`${error.message} ${error.responseBody ?? ""}`) ? "stop" : "retry";
  return "fail";
}

const LEFTOVER_COOLDOWN_MS = 3_600_000, LONGEST_PAUSE_MS = 7 * 86_400_000;

export function retryLeftoversAt(stopped: unknown, now: number) {
  if (stopped instanceof StopWork) return now;
  if (APICallError.isInstance(stopped)) {
    let body: { error?: Record<string, unknown> } & Record<string, unknown> = {};
    try { body = JSON.parse(stopped.responseBody ?? "{}") ?? {}; } catch { body = {}; }
    const detail = body.error ?? body, at = Number(detail.resets_at) * 1000;
    const wait = Number(detail.resets_in_seconds ?? stopped.responseHeaders?.["retry-after"]) * 1000;
    const reset = at > now ? at : wait > 0 ? now + wait : null;
    if (reset) return Math.min(reset, now + LONGEST_PAUSE_MS);
  }
  return now + LEFTOVER_COOLDOWN_MS;
}

export type AdaptiveResult<T, R> = { done: { job: T; result: R }[]; left: T[]; failed: { job: T; error: unknown }[]; stopped: unknown; peak: number };
export type AdaptiveOptions = { start?: number; max?: number; retries?: number; backoffMs?: number; classify?: (error: unknown) => "stop" | "retry" | "fail" };

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
