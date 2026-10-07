import type {ReviewProgress} from "./review-controller";

type Input = {system: string; prompt: string} | null;
type Dependencies = {
  checkpoint: (progress: ReviewProgress) => Promise<void>;
  generate: (input: {system: string; prompt: string; maxOutputTokens: number; maxRetries: 0; abortSignal: AbortSignal}) => Promise<{text: string; finishReason?: string}>;
  now?: () => number; signal?: AbortSignal;
};

/** Reserve before transport: a failed/interrupted durable attempt cannot spend the model budget again. */
export async function synthesizeReview(progress: ReviewProgress, input: Input, dependencies: Dependencies) {
  dependencies.signal?.throwIfAborted();
  const remaining = progress.request.budget.maxDurationMs - ((dependencies.now ?? Date.now)() - progress.startedAt);
  const limitation = progress.synthesisAttempted ? "Model attempt budget already spent; retained supported measures are shown."
    : remaining <= 0 ? "Investigation time budget reached; retained supported measures are shown."
    : !input ? "Model input budget reached; retained supported measures are shown." : null;
  if (limitation) return {text: null, limitation};
  const reserved = {...progress, synthesisAttempted: true};
  await dependencies.checkpoint(reserved);
  // Recheck elapsed time after checkpoint transport; it counts against the same durable deadline.
  const timeLeft = progress.request.budget.maxDurationMs - ((dependencies.now ?? Date.now)() - progress.startedAt);
  if (timeLeft <= 0) return {text: null, limitation: "Investigation time budget reached; retained supported measures are shown."};
  const result = await dependencies.generate({...input!, maxOutputTokens: progress.request.budget.maxOutputTokens, maxRetries: 0,
    abortSignal: AbortSignal.any([...(dependencies.signal ? [dependencies.signal] : []), AbortSignal.timeout(timeLeft)])});
  return {text: result.text, limitation: result.finishReason === "length" ? "Incomplete review: the provider reached its output limit. Further findings may be missing." : null};
}
