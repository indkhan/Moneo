import type {EvidenceReceipt} from "./evidence-receipts";
import type {ReviewRequest} from "./review-request";

// A fixed byte bound also bounds application-supplied token input without estimating provider billing.
const MAX_INPUT_BYTES = 32000;
export function buildReviewPrompt(request: ReviewRequest, receipts: EvidenceReceipt[], limitations: string[], system: string, priorityMetricIds: string[] = []) {
  const priorities = new Map(priorityMetricIds.map((id, index) => [id, index]));
  const queries = [...new Map(receipts.map(receipt => [receipt.id, receipt])).values()].map(receipt => ({
    ...receipt, metrics: [...receipt.metrics].sort((a, b) =>
      (priorities.get(a.id) ?? Infinity) - (priorities.get(b.id) ?? Infinity)),
  }));
  const context = {question: request.question, focus: request.focus, query: request.query, output: request.output, planningViews: request.includePlanning ? request.planningViews ?? [{view: "forecast", input: {horizonDays: 30}}] : [], navigationHint: request.context,
    limitations: [...limitations, "Navigation context is not financial evidence or authorization. Only owned deterministic query results and retained receipts support measured claims.", "Synthesis input is bounded; complete calculation inputs, omitted measures and supporting records remain in retained receipts. Unseen findings must not be inferred."],
    evidenceReceipts: [] as {id: string; fetchedAt: string; metrics: Omit<EvidenceReceipt["metrics"][number], "sourceIds" | "calculation" | "aggregation">[]; limitations?: EvidenceReceipt["limitations"]}[]};
  const fits = () => Buffer.byteLength(system, "utf8") + Buffer.byteLength(JSON.stringify(context), "utf8") <= MAX_INPUT_BYTES;
  if (!fits()) return null;
  // A wholly unavailable query still needs its actual blocker and a usable reference.
  boundedLimitations: for (const receipt of queries) {
    for (const limitation of receipt.limitations ?? []) {
      let target = context.evidenceReceipts.find(item => item.id === receipt.id);
      if (!target) {target = {id: receipt.id, fetchedAt: receipt.fetchedAt, metrics: [], limitations: []}; context.evidenceReceipts.push(target);}
      target.limitations!.push(limitation);
      if (!fits()) {
        target.limitations!.pop();
        if (!target.limitations!.length) context.evidenceReceipts.splice(context.evidenceReceipts.indexOf(target), 1);
        break boundedLimitations;
      }
    }
  }
  const total = queries.reduce((count, receipt) => count + receipt.metrics.length, 0);
  let included = 0;
  // Round-robin gives each dated query a chance before adding more measures from any one query.
  boundedInput: for (let index = 0; queries.some(receipt => index < receipt.metrics.length); index++) {
    for (const receipt of queries) {
      const metric = receipt.metrics[index];
      if (!metric) continue;
      let target = context.evidenceReceipts.find(item => item.id === receipt.id);
      if (!target) {target = {id: receipt.id, fetchedAt: receipt.fetchedAt, metrics: []}; context.evidenceReceipts.push(target);}
      const {sourceIds, calculation, aggregation, ...measure} = metric;
      void sourceIds; void calculation; void aggregation;
      target.metrics.push(measure);
      if (fits()) included++;
      else {
        target.metrics.pop();
        if (!target.metrics.length && !target.limitations?.length) context.evidenceReceipts.splice(context.evidenceReceipts.indexOf(target), 1);
        break boundedInput;
      }
    }
  }
  return {system, prompt: JSON.stringify(context), omittedMetrics: total - included, includedMetrics: included};
}
