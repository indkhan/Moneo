import type {EvidenceReceipt} from "./evidence-receipts";
import type {ReviewRequest} from "./review-request";

// A fixed byte bound also bounds application-supplied token input without estimating provider billing.
const MAX_INPUT_BYTES = 32000;
export function buildReviewPrompt(request: ReviewRequest, receipts: EvidenceReceipt[], limitations: string[], system: string) {
  const context = {question: request.question, focus: request.focus, query: request.query, output: request.output,
    limitations: [...limitations, "Synthesis input is bounded; complete calculation inputs, omitted measures and supporting records remain in retained receipts. Unseen findings must not be inferred."],
    evidenceReceipts: [] as {id: string; fetchedAt: string; metrics: Omit<EvidenceReceipt["metrics"][number], "sourceIds" | "calculation">[]}[]};
  const fits = () => Buffer.byteLength(system, "utf8") + Buffer.byteLength(JSON.stringify(context), "utf8") <= MAX_INPUT_BYTES;
  if (!fits()) return null;
  const total = receipts.reduce((count, receipt) => count + receipt.metrics.length, 0);
  let included = 0;
  // Round-robin gives each dated query a chance before adding more measures from any one query.
  for (let index = 0; receipts.some(receipt => index < receipt.metrics.length); index++) {
    for (const receipt of receipts) {
      const metric = receipt.metrics[index];
      if (!metric) continue;
      let target = context.evidenceReceipts.find(item => item.id === receipt.id);
      if (!target) {target = {id: receipt.id, fetchedAt: receipt.fetchedAt, metrics: []}; context.evidenceReceipts.push(target);}
      const {sourceIds, calculation, ...measure} = metric;
      void sourceIds; void calculation;
      target.metrics.push(measure);
      if (fits()) included++;
      else {target.metrics.pop(); if (!target.metrics.length) context.evidenceReceipts.splice(context.evidenceReceipts.indexOf(target), 1);}
    }
  }
  return {system, prompt: JSON.stringify(context), omittedMetrics: total - included, includedMetrics: included};
}
